// ---------------------------------------------------------------------------
// core/stride/resolve.ts — turning an address into a span
//
// Three ways to reach a member, in falling order of how much the index already
// knows:
//
//   DENSE       the container's members are in the index; O(1) by ordinal, and
//               by name a scan of the dense table, which holds at most
//               DENSE_CHILD_LIMIT (32) entries because that limit is what
//               "dense" means. So the by-name scan is bounded by a constant,
//               not by the container.
//   CHECKPOINT  the container is a bulk collection; seek the checkpoint at or
//               before the member and re-scan forward. Bounded by the stride,
//               which was chosen so that walk covers a roughly constant number
//               of bytes — STRIDE_RESCAN_BYTES, 12 KiB.
//   INTERIOR    the container is inside a bulk collection and has no index
//               entry at all; scan its own span. A record is a few hundred
//               bytes, so this is the cheap case even though it sounds like
//               the expensive one.
//
// Wide objects get a fourth route: a member-name hash probe that yields the
// ordinal, after which the checkpoint seek applies. Without it a 50,000-key
// object would walk from the first member on every lookup. A miss on that table
// is not a failure — it falls back to the same STRIDE_RESCAN_BYTES-bounded walk
// from the container's first byte, which is the only route that cannot be wrong.
//
// EVERY ONE OF THOSE ROUTES FIRST NEEDS THE CONTAINER'S INDEX NODE ID, and that
// lookup, not the member walk, was where resolution was spending its time. A
// member's node id is recorded in exactly one place — its parent's dense table —
// so the id of a node at depth d used to be derived by climbing to the root,
// which cost a resolution of every ancestor on the way. One resolve at depth 512
// on a 3 KB document made 341,630 of those climbs and took 5.7 seconds: measured
// at 2^3.05 per doubling of depth, i.e. cubic in depth for a single pointer.
//
// Three things fix it, and none of them changes an answer:
//
//   THREADED    a member lookup returns the member's own node id in
//               `Member.node`. That is the same number a derivation would
//               reach, so a descent carries its ancestors' ids forward instead
//               of re-deriving them, and the walk is O(depth).
//   MEMOISED    byte start -> node id, bounded. A JSON value's first byte
//               identifies it uniquely within a document, so this is a function
//               of one number and needs no pointer as a key.
//   RESUMED     a pointer whose parent is already in the resolution cache takes
//               its last reference token against that parent, so a top-down
//               descent costs one member lookup per level rather than a fresh
//               walk from the root per level.
//
// A small resolution cache sits in front of all of this, because an agent
// re-addresses the same handful of pointers many times in a session and the
// second lookup should not repeat the first one's work.
// ---------------------------------------------------------------------------

import {
    StrideError,
    type StrideKind, type StrideNode,
} from './types.js';
import type { StrideSource } from './source.js';
import { scanStructure, KIND_NAMES, K_OBJECT, K_ARRAY } from './scan.js';
import { StrideIndex, decodeJsonString, type ChildRef } from './index.js';
import { childPointer, indexPointer, parsePointer, parentPointer, tokenToIndex } from './pointer.js';

/** Resolved pointers cached across calls. Bounded; oldest evicted first. */
const RESOLVE_CACHE_MAX = 4096;

/**
 * Byte-start -> index-node-id memos held at once. Bounded; oldest evicted first.
 *
 * 16,384 entries of two numbers is roughly 0.7 MB at V8's ~40 bytes per Map
 * entry, whatever the document does — three orders of magnitude inside the
 * budget the index's own key-hash table is already allowed (I6). Four times
 * RESOLVE_CACHE_MAX, because one resolution records an entry for every node on
 * its spine and not only for the pointer it was asked about, so serving a cache
 * of 4,096 pointers takes several full spines' worth of ids.
 *
 * The bound cannot return resolution to super-linear cost. A single walk from
 * the root never consults the memo for its own ancestors — it carries their ids
 * forward in a local (see `resolve`) — so the memo only ever has to hold ONE
 * entry for the walk that follows it: its parent's, written one step earlier.
 * Eviction is insertion-ordered, which makes that entry the newest and so the
 * last to go. Losing it costs one derivation, not a change of answer.
 *
 * Exported so the bound can be asserted rather than restated: a memory bound
 * whose test spells the number out a second time is a bound that drifts.
 */
export const RESOLVE_ID_CACHE_MAX = 16_384;

/** A member of a container, as produced by any of the four routes. */
export interface Member {
    readonly ordinal: number;
    readonly key: string | null;
    readonly start: number;
    readonly end: number;
    readonly kind: StrideKind;
    /** Index node id when this member is itself indexed, else -1. */
    readonly node: number;
}

/**
 * How a resolver obtains a container's index node id.
 *
 * `shortcuts: false` turns off all three of them at once — the resume from an
 * already-resolved parent, the threading of `Member.node` into the next
 * lookup, and the byte-start memo — so every id comes from `deriveIndexId`,
 * which reads the index and nothing else. It exists so the fast route can be
 * proved to answer identically to a route that shares none of its state
 * (tests: resolve-equivalence). Nothing in the product passes it.
 */
export interface ResolverOptions {
    readonly shortcuts?: boolean;
}

export class Resolver {
    readonly index: StrideIndex;
    readonly source: StrideSource;
    private readonly cache = new Map<string, StrideNode>();
    /**
     * Byte start of a value -> its index node id, or -1 for "not indexed".
     * Keyed by the byte offset rather than by the pointer because the mapping is
     * a function of that offset alone, and because a pointer key costs bytes
     * proportional to depth on exactly the documents this memo exists for.
     */
    private readonly ids = new Map<number, number>();
    private readonly shortcuts: boolean;

    constructor(index: StrideIndex, options?: ResolverOptions) {
        this.index = index;
        this.source = index.source;
        this.shortcuts = options?.shortcuts ?? true;
    }

    private remember(pointer: string, node: StrideNode): StrideNode {
        if (this.cache.size >= RESOLVE_CACHE_MAX) {
            const oldest = this.cache.keys().next();
            if (oldest.done !== true) this.cache.delete(oldest.value);
        }
        this.cache.set(pointer, node);
        return node;
    }

    /**
     * Memoise one byte-start -> node-id mapping and return the id.
     *
     * The size check skips eviction when the key is already present, because
     * `Map.set` on an existing key does not grow the map: evicting anyway would
     * drain the memo one entry per re-descent of a spine it is already holding.
     */
    private rememberId(start: number, id: number): number {
        if (this.ids.size >= RESOLVE_ID_CACHE_MAX && !this.ids.has(start)) {
            const oldest = this.ids.keys().next();
            if (oldest.done !== true) this.ids.delete(oldest.value);
        }
        this.ids.set(start, id);
        return id;
    }

    /** The document root as a node. */
    root(): StrideNode {
        const r = this.index.node(this.index.rootId);
        if (r === null) {
            throw new StrideError(
                'malformed_json',
                'The document contains no JSON value.',
                'Check that the input is JSON; an empty or whitespace-only body has nothing to navigate.',
            );
        }
        return { pointer: '', kind: r.kind, start: r.start, end: r.end, depth: 0, parent: null, count: r.count };
    }

    /**
     * Resolve a JSON Pointer to a node. Throws `not_found` naming the deepest
     * pointer that DID resolve, so a caller that guessed one segment wrong is
     * told where it went wrong rather than just that it failed.
     */
    resolve(pointer: string): StrideNode {
        const cached = this.cache.get(pointer);
        if (cached !== undefined) return cached;

        // Parsed before anything below reads the pointer's bytes, so a pointer
        // that is not RFC 6901 still fails as `bad_pointer` rather than being
        // cut into a parent and a token by `parentPointer`.
        const tokens = parsePointer(pointer);

        let node = this.root();
        let id = this.index.rootId;
        let walked = '';
        // Sliced rather than indexed: under `noUncheckedIndexedAccess` an index
        // read is `string | undefined`, and there is no default for a missing
        // reference token that is not a different pointer.
        let rest = tokens;

        const resume = this.resumeFrom(pointer, tokens.length);
        if (resume !== null) {
            node = resume;
            id = this.indexIdFor(resume);
            walked = resume.pointer;
            rest = tokens.slice(tokens.length - 1);
        }

        for (const token of rest) {
            if (node.kind !== 'object' && node.kind !== 'array') {
                throw new StrideError(
                    'not_found',
                    `${walked === '' ? 'The document root' : walked} is a ${node.kind}; it has no member ${JSON.stringify(token)}.`,
                    `Read ${JSON.stringify(walked)} to see what is actually there.`,
                );
            }
            const member = node.kind === 'array'
                ? this.memberAt(node, id, tokenToIndex(token))
                : this.memberNamed(node, id, token);
            if (member === null) {
                throw new StrideError(
                    'not_found',
                    `No member ${JSON.stringify(token)} under ${JSON.stringify(walked)}.`,
                    `Read ${JSON.stringify(walked)} with mode "read" to list what it contains.`,
                );
            }
            walked = node.kind === 'array'
                ? indexPointer(walked, member.ordinal)
                : childPointer(walked, member.key ?? '');
            node = {
                pointer: walked,
                kind: member.kind,
                start: member.start,
                end: member.end,
                depth: node.depth + 1,
                parent: parentPointer(walked),
                count: this.countOf(member),
            };
            // `member.node` IS this node's index node id. A member's id is
            // recorded in exactly one place, its parent's dense table, and that
            // row is what the lookup above just read — so it is the same number
            // `deriveIndexId` reaches by descending to this byte, and carrying it
            // forward makes the next level's lookup cost nothing to set up.
            id = this.shortcuts
                ? this.rememberId(member.start, member.node)
                : this.deriveIndexId(member.start);
        }
        return this.remember(pointer, node);
    }

    /**
     * The already-resolved parent to take the last reference token against, or
     * null to walk from the root.
     *
     * A descent re-addresses its own ancestors: the render walk resolves a
     * container before each of its members, so this pointer's parent is normally
     * the pointer resolved immediately before it. Starting there costs one member
     * lookup instead of a walk of the whole spine, which is the difference
     * between a descent that costs O(depth) in total and one that costs
     * O(depth^2) — on a 2,000-level document, 2,000 lookups against 2,000,000.
     *
     * Gated on the cached node's own pointer equalling the key it is filed under.
     * `remember` files a node under the pointer the CALLER asked for, and for a
     * token carrying an escape RFC 6901 does not define — "~2" — that is not the
     * pointer the node reports. `walked` has to stay the canonical form, because
     * it is what a `not_found` message names.
     */
    private resumeFrom(pointer: string, tokenCount: number): StrideNode | null {
        if (!this.shortcuts || tokenCount === 0) return null;
        const parentKey = parentPointer(pointer);
        if (parentKey === null) return null;
        const parent = this.cache.get(parentKey);
        if (parent === undefined || parent.pointer !== parentKey) return null;
        return parent;
    }

    /** Member count of a container member, without indexing it. */
    private countOf(member: Member): number {
        if (member.kind !== 'object' && member.kind !== 'array') return 0;
        if (member.node >= 0) {
            const n = this.index.node(member.node);
            if (n !== null) return n.count;
        }
        // Not indexed: count by scanning its own span. Bounded by the member.
        let count = 0;
        scanStructure(this.source, member.start + 1, member.end, {
            enter(_k, _s, d) { if (d === 1) count++; },
            exit() { /* counted on enter */ },
            key() { /* names do not add to the count */ },
            scalar(_k, _s, _e, d) { if (d === 1) count++; },
        }, member.kind === 'object' ? 0 : 1);
        return count;
    }

    /** Member of an array container by ordinal, or null. */
    memberByIndex(node: StrideNode, ordinal: number): Member | null {
        return this.memberAt(node, this.indexIdFor(node), ordinal);
    }

    /** Member of an object container by name, or null. */
    memberByKey(node: StrideNode, key: string): Member | null {
        return this.memberNamed(node, this.indexIdFor(node), key);
    }

    /**
     * `memberByIndex` with the container's index node id already in hand.
     * The descent in `resolve` always has it and nothing else has to know it
     * exists; `id` must be `indexIdFor(node)` and -1 is the honest value for a
     * container the index never reached.
     */
    private memberAt(node: StrideNode, id: number, ordinal: number): Member | null {
        if (ordinal < 0) return null;
        if (id >= 0 && this.index.isDense(id)) {
            const kids = this.index.denseChildren(id);
            const k = kids[ordinal];
            return k === undefined ? null : toMember(k, ordinal);
        }
        if (id >= 0 && this.index.isCheckpointed(id)) {
            const cp = this.index.checkpointBefore(id, ordinal);
            if (cp !== null) {
                return this.walkFrom(node, cp.offset, cp.ordinal, ordinal, null);
            }
        }
        return this.walkFrom(node, node.start + 1, 0, ordinal, null);
    }

    /** `memberByKey` with the container's index node id already in hand. */
    private memberNamed(node: StrideNode, id: number, key: string): Member | null {
        if (id >= 0 && this.index.isDense(id)) {
            const kids = this.index.denseChildren(id);
            // Reverse order: a duplicated member name resolves to the LAST
            // occurrence, matching JSON.parse, while both remain enumerable.
            for (let i = kids.length - 1; i >= 0; i--) {
                const k = kids[i];
                if (k !== undefined && k.key === key) return toMember(k, i);
            }
            return null;
        }
        if (id >= 0 && this.index.isCheckpointed(id)) {
            const ordinal = this.index.lookupWideKey(id, key);
            if (ordinal >= 0) {
                const cp = this.index.checkpointBefore(id, ordinal);
                const found = cp !== null
                    ? this.walkFrom(node, cp.offset, cp.ordinal, ordinal, null)
                    : this.walkFrom(node, node.start + 1, 0, ordinal, null);
                // A hash hit is a candidate, not an answer: confirm the name.
                if (found !== null && found.key === key) return found;
            }
            // Miss, collision, or a member past the hash table: walk the
            // container. Correct, and the only route that cannot be wrong.
            return this.walkFrom(node, node.start + 1, 0, -1, key);
        }
        return this.walkFrom(node, node.start + 1, 0, -1, key);
    }

    /**
     * The index node id for a node, or -1 when it is not indexed.
     *
     * -1 IS AN ANSWER, NOT A FAILURE. It routes the caller to a re-scan of the
     * container's own bytes, which is exhaustive and correct for any container
     * whatever the index holds. That is what makes this safe to memoise: a memo
     * entry saying -1 can only ever cost a walk that was already going to be
     * right, and can never turn "not indexed, re-scan for it" into "not found".
     */
    private indexIdFor(node: StrideNode): number {
        if (node.pointer === '') return this.index.rootId;
        if (node.parent === null) return this.index.rootId;
        if (!this.shortcuts) return this.deriveIndexId(node.start);
        const memo = this.ids.get(node.start);
        if (memo !== undefined) return memo;
        return this.rememberId(node.start, this.deriveIndexId(node.start));
    }

    /**
     * The index node id of the value beginning at byte `start`, or -1.
     *
     * Derived by descending the index's dense tables from the root, following at
     * each level the one member whose span contains that byte. It reads the index
     * and nothing else: no pointer, no cache, no resolution of an ancestor.
     *
     * It is exact because of an invariant index.ts maintains rather than states.
     * A member's node id is recorded only in its parent's dense table, and a
     * container that later proves itself a bulk collection gives its whole
     * subtree's nodes back (`discardDescendants`). So every node that survives
     * the build has a dense parent, and by induction every one of its ancestors
     * is dense too; each of their spans strictly contains this byte, because a
     * container's own first byte is its bracket. The descent therefore cannot
     * miss an indexed node, and a byte no indexed node begins at falls off the
     * dense chain and answers -1 — the re-scan route.
     *
     * Byte start is the right key for all of this: distinct JSON values occupy
     * disjoint spans, so a value's first byte names it uniquely in a document.
     */
    private deriveIndexId(start: number): number {
        let id = this.index.rootId;
        if (id < 0) return -1;
        const root = this.index.node(id);
        if (root === null) return -1;
        if (root.start === start) return id;
        while (this.index.isDense(id)) {
            let into = -1;
            for (const k of this.index.denseChildren(id)) {
                // Equality before containment: a member starting exactly here IS
                // the node, and its own node id — including -1, when the index
                // declined to give it one — is the answer rather than a reason to
                // descend into it. Members occupy disjoint spans, so at most one
                // entry in this table relates to `start` at all and breaking on
                // the first container that holds it cannot skip a nearer match.
                if (k.start === start) return k.node;
                if (k.start <= start && start < k.end) { into = k.node; break; }
            }
            if (into < 0) return -1;
            id = into;
        }
        return -1;
    }

    /**
     * Walk a container's members from a known member boundary until either
     * ordinal `wantOrdinal` or member name `wantKey` is reached.
     * `fromByte` must be the first byte of the member at `fromOrdinal`.
     */
    private walkFrom(
        node: StrideNode,
        fromByte: number,
        fromOrdinal: number,
        wantOrdinal: number,
        wantKey: string | null,
    ): Member | null {
        const isObject = node.kind === 'object';
        const source = this.source;
        let ordinal = fromOrdinal;
        let pendingKeyStart = -1;
        let pendingKeyEnd = -1;
        let found: Member | null = null;

        const take = (start: number, end: number, kind: StrideKind): boolean => {
            const key = isObject && pendingKeyStart >= 0
                ? decodeJsonString(source.slice(pendingKeyStart, pendingKeyEnd))
                : null;
            pendingKeyStart = -1;
            const hit = wantKey !== null ? key === wantKey : ordinal === wantOrdinal;
            if (hit) {
                found = { ordinal, key, start, end, kind, node: -1 };
                return true;
            }
            ordinal++;
            return false;
        };

        try {
            scanStructure(source, fromByte, node.end, {
                enter() { /* the span is taken on exit, when the end is known */ },
                exit(kind, start, end, d) {
                    if (d === 1 && take(start, end, kind === K_OBJECT ? 'object' : 'array')) throw STOP;
                },
                key(start, end, d) { if (d === 1) { pendingKeyStart = start; pendingKeyEnd = end; } },
                scalar(kind, start, end, d) {
                    if (d === 1 && take(start, end, KIND_NAMES[kind] ?? 'null')) throw STOP;
                },
            }, isObject ? 0 : 1);
        } catch (e) {
            rethrowUnlessStop(e);
        }

        return found;
    }

    /**
     * Members of a container in [offset, offset+limit). Uses whichever route
     * the container's indexing supports; the caller never has to know which.
     */
    members(node: StrideNode, offset: number, limit: number): Member[] {
        if (node.kind !== 'object' && node.kind !== 'array') {
            throw new StrideError(
                'not_a_container',
                `${node.pointer === '' ? 'The document' : node.pointer} is a ${node.kind}, not a container.`,
                'Use mode "read" on it directly, or mode "scalar" if it is a long string.',
            );
        }
        if (limit <= 0) return [];
        const id = this.indexIdFor(node);
        if (id >= 0 && this.index.isDense(id)) {
            const kids = this.index.denseChildren(id);
            const out: Member[] = [];
            for (let i = offset; i < Math.min(kids.length, offset + limit); i++) {
                const k = kids[i];
                if (k !== undefined) out.push(toMember(k, i));
            }
            return out;
        }
        let fromByte = node.start + 1;
        let fromOrdinal = 0;
        if (id >= 0 && this.index.isCheckpointed(id)) {
            const cp = this.index.checkpointBefore(id, offset);
            if (cp !== null) { fromByte = cp.offset; fromOrdinal = cp.ordinal; }
        }
        return this.collect(node, fromByte, fromOrdinal, offset, limit);
    }

    /** Collect members [offset, offset+limit) by walking from a boundary. */
    private collect(node: StrideNode, fromByte: number, fromOrdinal: number, offset: number, limit: number): Member[] {
        const isObject = node.kind === 'object';
        const source = this.source;
        const out: Member[] = [];
        let ordinal = fromOrdinal;
        let pendingKeyStart = -1;
        let pendingKeyEnd = -1;

        const take = (start: number, end: number, kind: StrideKind): boolean => {
            const key = isObject && pendingKeyStart >= 0
                ? decodeJsonString(source.slice(pendingKeyStart, pendingKeyEnd))
                : null;
            pendingKeyStart = -1;
            if (ordinal >= offset) out.push({ ordinal, key, start, end, kind, node: -1 });
            ordinal++;
            return out.length >= limit;
        };

        try {
            scanStructure(source, fromByte, node.end, {
                enter() { /* the span is taken on exit, when the end is known */ },
                exit(kind, start, end, d) {
                    if (d === 1 && take(start, end, kind === K_OBJECT ? 'object' : 'array')) throw STOP;
                },
                key(start, end, d) { if (d === 1) { pendingKeyStart = start; pendingKeyEnd = end; } },
                scalar(kind, start, end, d) {
                    if (d === 1 && take(start, end, KIND_NAMES[kind] ?? 'null')) throw STOP;
                },
            }, isObject ? 0 : 1);
        } catch (e) {
            rethrowUnlessStop(e);
        }

        return out;
    }

    /**
     * The pointer of the smallest indexed-or-bulk member containing `at`.
     * This is how a raw byte match from a literal scan becomes a location an
     * agent can act on.
     */
    locate(at: number): StrideNode {
        let node = this.root();
        // Threaded exactly as in `resolve`, and for the same reason: a byte
        // inside a deep record is located by descending to it, and each level
        // already knows the next level's id.
        let id = this.index.rootId;
        for (;;) {
            if (node.kind !== 'object' && node.kind !== 'array') return node;
            let child: Member | null = null;
            if (id >= 0 && this.index.isDense(id)) {
                for (const k of this.index.denseChildren(id)) {
                    if (at >= k.start && at < k.end) { child = toMember(k, k.ordinal); break; }
                }
            } else {
                let fromByte = node.start + 1;
                let fromOrdinal = 0;
                if (id >= 0 && this.index.isCheckpointed(id)) {
                    const cp = this.index.checkpointAtByte(id, at);
                    if (cp !== null) { fromByte = cp.offset; fromOrdinal = cp.ordinal; }
                }
                child = this.memberContaining(node, fromByte, fromOrdinal, at);
            }
            if (child === null) return node;
            const next: StrideNode = {
                pointer: node.kind === 'array'
                    ? indexPointer(node.pointer, child.ordinal)
                    : childPointer(node.pointer, child.key ?? ''),
                kind: child.kind,
                start: child.start,
                end: child.end,
                depth: node.depth + 1,
                parent: node.pointer,
                count: 0,
            };
            node = next;
            id = this.shortcuts
                ? this.rememberId(child.start, child.node)
                : this.deriveIndexId(child.start);
        }
    }

    private memberContaining(node: StrideNode, fromByte: number, fromOrdinal: number, at: number): Member | null {
        const isObject = node.kind === 'object';
        const source = this.source;
        let ordinal = fromOrdinal;
        let pendingKeyStart = -1;
        let pendingKeyEnd = -1;
        let found: Member | null = null;

        const take = (start: number, end: number, kind: StrideKind): boolean => {
            const key = isObject && pendingKeyStart >= 0
                ? decodeJsonString(source.slice(pendingKeyStart, pendingKeyEnd))
                : null;
            pendingKeyStart = -1;
            if (at >= start && at < end) {
                found = { ordinal, key, start, end, kind, node: -1 };
                return true;
            }
            if (start > at) return true;      // walked past it
            ordinal++;
            return false;
        };

        try {
            scanStructure(source, fromByte, node.end, {
                enter() { /* taken on exit */ },
                exit(kind, start, end, d) {
                    if (d === 1 && take(start, end, kind === K_OBJECT ? 'object' : 'array')) throw STOP;
                },
                key(start, end, d) { if (d === 1) { pendingKeyStart = start; pendingKeyEnd = end; } },
                scalar(kind, start, end, d) {
                    if (d === 1 && take(start, end, KIND_NAMES[kind] ?? 'null')) throw STOP;
                },
            }, isObject ? 0 : 1);
        } catch (e) {
            rethrowUnlessStop(e);
        }

        return found;
    }
}

/**
 * Thrown to unwind a scan that has found what it came for. The scanner has no
 * early-exit protocol of its own and giving it one would put a per-event
 * branch in the hot loop; a sentinel throw costs nothing until it happens.
 */
const STOP = Symbol('stride.stop');

/**
 * Absorb the early-exit sentinel and nothing else.
 *
 * The walks above stop by throwing STOP out of a scanner visitor, so every one
 * of them has to be driven inside a `try`. Absorbing the whole `catch` instead
 * would swallow the two throws that must reach the caller: a `StrideError` from
 * the source (an over-long slice, a closed file descriptor) and any genuine
 * scanner failure. Identity against the module-private symbol is the narrowest
 * possible test — nothing outside this file can produce that value.
 */
function rethrowUnlessStop(e: unknown): void {
    if (e !== STOP) throw e;
}

function toMember(k: ChildRef, ordinal: number): Member {
    return { ordinal, key: k.key, start: k.start, end: k.end, kind: k.kind, node: k.node };
}

export { K_OBJECT, K_ARRAY, STOP };
