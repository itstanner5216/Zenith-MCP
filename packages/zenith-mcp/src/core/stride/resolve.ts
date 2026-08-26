// ---------------------------------------------------------------------------
// core/stride/resolve.ts — turning an address into a span
//
// Three ways to reach a member, in falling order of how much the index already
// knows:
//
//   DENSE       the container's members are in the index; O(1) by ordinal,
//               O(members) by name over at most EAGER_CHILD_LIMIT entries.
//   CHECKPOINT  the container is a bulk collection; seek the checkpoint at or
//               before the member and re-scan forward. Bounded by the stride,
//               which was chosen so that walk covers a roughly constant number
//               of bytes.
//   INTERIOR    the container is inside a bulk collection and has no index
//               entry at all; scan its own span. A record is a few hundred
//               bytes, so this is the cheap case even though it sounds like
//               the expensive one.
//
// Wide objects get a fourth route: a member-name hash probe that yields the
// ordinal, after which the checkpoint seek applies. Without it a 50,000-key
// object would walk from the first member on every lookup.
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

export class Resolver {
    readonly index: StrideIndex;
    readonly source: StrideSource;
    private readonly cache = new Map<string, StrideNode>();

    constructor(index: StrideIndex) {
        this.index = index;
        this.source = index.source;
    }

    private remember(pointer: string, node: StrideNode): StrideNode {
        if (this.cache.size >= RESOLVE_CACHE_MAX) {
            const oldest = this.cache.keys().next();
            if (oldest.done !== true) this.cache.delete(oldest.value);
        }
        this.cache.set(pointer, node);
        return node;
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

        const tokens = parsePointer(pointer);
        let node = this.root();
        let walked = '';
        for (const token of tokens) {
            if (node.kind !== 'object' && node.kind !== 'array') {
                throw new StrideError(
                    'not_found',
                    `${walked === '' ? 'The document root' : walked} is a ${node.kind}; it has no member ${JSON.stringify(token)}.`,
                    `Read ${JSON.stringify(walked)} to see what is actually there.`,
                );
            }
            const member = node.kind === 'array'
                ? this.memberByIndex(node, tokenToIndex(token))
                : this.memberByKey(node, token);
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
        }
        return this.remember(pointer, node);
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
        if (ordinal < 0) return null;
        const id = this.indexIdFor(node);
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

    /** Member of an object container by name, or null. */
    memberByKey(node: StrideNode, key: string): Member | null {
        const id = this.indexIdFor(node);
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

    /** The index node id for a pointer, or -1 when it is not indexed. */
    private indexIdFor(node: StrideNode): number {
        if (node.pointer === '') return this.index.rootId;
        const parent = node.parent;
        if (parent === null) return this.index.rootId;
        // Walk the parent's dense table for a child whose span matches. Only
        // dense parents record node ids for their members.
        const parentId = this.indexIdForPointer(parent);
        if (parentId < 0 || !this.index.isDense(parentId)) return -1;
        const kids = this.index.denseChildren(parentId);
        for (const k of kids) {
            if (k.start === node.start && k.node >= 0) return k.node;
        }
        return -1;
    }

    private indexIdForPointer(pointer: string): number {
        if (pointer === '') return this.index.rootId;
        const cached = this.cache.get(pointer);
        const node = cached !== undefined ? cached : this.resolve(pointer);
        return this.indexIdFor(node);
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
        for (;;) {
            if (node.kind !== 'object' && node.kind !== 'array') return node;
            const id = this.indexIdFor(node);
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
