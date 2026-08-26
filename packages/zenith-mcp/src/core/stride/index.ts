// ---------------------------------------------------------------------------
// core/stride/index.ts — the sparse, checkpointed structural index
//
// The whole design turns on one measurement: a byte offset costs 32 bits, and
// there are as many of them as there are JSON values. Storing one per value is
// what makes a "sparse index" cost 45x the document it indexes. So STRIDE does
// not store one per value.
//
// It stores three things instead:
//
//   1. A SKELETON of eagerly indexed containers — the top of the tree, where
//      an agent orients itself. Descent stops at any container wide enough to
//      be a bulk collection rather than structure.
//   2. CHECKPOINTS for those wide containers: one byte offset every K members
//      instead of one per member. Element i is reached by seeking checkpoint
//      floor(i/K) and re-scanning forward at most K members. Measured, the
//      knee is around K=64: versus a full offset table that is 63x less memory
//      for 52x the access latency (235 ns -> ~12 us), and past it latency grows
//      faster than the memory saved is worth. K is chosen per container so the
//      forward re-scan covers a roughly constant NUMBER OF BYTES, because that
//      is what the latency actually tracks.
//   3. A KEY HASH TABLE for wide objects, so a 50,000-key object still answers
//      a member lookup with a hash probe rather than a linear walk.
//
// Everything else is recovered by re-scanning a bounded byte span on demand.
// A scalar inside a record is found by scanning that record — a few hundred
// bytes — not by having stored it during the build.
//
// Two decisions govern the build, and they are decisions about separate things:
//
//   "Do I record my own members one by one?"  Asked of a container about
//   itself, answered by its width against DENSE_CHILD_LIMIT. Yes up to that
//   width; past it the members are reduced to checkpoints.
//
//   "Does this member get an index node of its own?"  Asked of the PARENT when
//   the member is entered. Only a parent that is recording densely can answer
//   "which node is my member i" — resolve.ts reads a member's node id out of
//   its parent's dense table and has no other route to it — so a node under a
//   bulk container could never be found again. That is what makes descent stop
//   at a bulk collection instead of following it all the way down, and it is
//   the difference between an index that is a small fraction of the document
//   (I6) and one that is twice its size.
//
// A container only proves itself bulk part-way through, by which time its first
// members already have nodes. Those become unreachable the moment the dense
// table is dropped, so they are given back — see `discardDescendants`.
//
// Nothing here allocates an object per JSON value. Node handles are views
// materialised on demand from parallel typed arrays.
// ---------------------------------------------------------------------------

import {
    DENSE_CHILD_LIMIT, STRIDE_DEFAULT, STRIDE_MAX, STRIDE_RESCAN_BYTES,
    type StrideKind,
} from './types.js';
import type { StrideSource } from './source.js';
import { scanStructure, KIND_NAMES, K_OBJECT, K_ARRAY } from './scan.js';

/**
 * Hard ceiling on indexed nodes, so index memory cannot run away even on a
 * document that is genuinely structure all the way down. Hitting it sets
 * `truncatedIndex`: a capped structural index is an incomplete one, and saying
 * so is the difference between bounded memory (I6) and silently lost coverage
 * (I7).
 */
const MAX_INDEX_NODES = 250_000;

/** Checkpoints kept per wide container. The stride doubles rather than exceed it. */
const CHECKPOINT_CAP = 16_384;

/**
 * Members of wide objects that get a hash-table entry, summed over the whole
 * document. 262,144 entries at 12 bytes each is a 3.1 MB ceiling whatever the
 * document does, so this table can never be the thing that breaks I6. Past the
 * cap a lookup falls back to a walk: slower, and still exhaustive.
 */
const KEY_INDEX_CAP = 262_144;

export const F_DENSE = 1;
export const F_CHECKPOINT = 2;
/**
 * Set when the key hash table ran out of room before it could cover every
 * member that qualifies for an entry. Members the table deliberately skips —
 * those a lookup can walk to within STRIDE_RESCAN_BYTES of the container's
 * first byte — are not partiality; they are the table declining to pay for a
 * shortcut past a distance the stride already covers.
 */
const F_PARTIAL_KEYS = 4;

/** Everything the index knows about one indexed node, materialised on demand. */
export interface IndexedNode {
    readonly id: number;
    readonly kind: StrideKind;
    readonly start: number;
    readonly end: number;
    readonly depth: number;
    readonly parent: number;
    readonly count: number;
    readonly flags: number;
}

/** One member of an indexed container. */
export interface ChildRef {
    readonly start: number;
    readonly end: number;
    readonly kind: StrideKind;
    /** Node id when this child is itself indexed, else -1. */
    readonly node: number;
    /** Member name for an object child, or null for an array element. */
    readonly key: string | null;
    /** Ordinal within the parent. */
    readonly ordinal: number;
}

// The buffer type argument on these four is `ArrayBuffer`, not the bare alias,
// because that is what the storage actually is: every array below is born from
// `new XArray(n)` in this module, which allocates a plain ArrayBuffer, and no
// index array is ever adopted from outside. A bare `Float64Array` annotation
// means `Float64Array<ArrayBufferLike>`, which additionally admits a
// SharedArrayBuffer-backed view — a store this module cannot produce and whose
// element writes would need synchronisation the build loop does not perform.
function growF64(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Float64Array(n);
    out.set(a);
    return out;
}
function growI32(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Int32Array(n);
    out.set(a);
    return out;
}
function growU32(a: Uint32Array<ArrayBuffer>, need: number): Uint32Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Uint32Array(n);
    out.set(a);
    return out;
}
function growU8(a: Uint8Array<ArrayBuffer>, need: number): Uint8Array<ArrayBuffer> {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Uint8Array(n);
    out.set(a);
    return out;
}

/** FNV-1a over a byte range. Used for member-name hashing. */
export function hashBytes(buf: Buffer | Uint8Array, from: number, to: number): number {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) h = Math.imul(h ^ (buf[i] ?? 0), 0x01000193);
    return h >>> 0;
}

/** FNV-1a over a JS string's UTF-8 bytes, matching `hashBytes`. */
export function hashKey(key: string): string extends never ? never : number {
    const b = Buffer.from(key, 'utf8');
    return hashBytes(b, 0, b.length);
}

/**
 * Decode a raw quoted JSON string span to its member name. The overwhelmingly
 * common case has no escapes, so it is a straight UTF-8 decode of the interior;
 * only a span containing a backslash pays for `JSON.parse`.
 */
export function decodeJsonString(raw: Buffer): string {
    const n = raw.length;
    if (n >= 2 && raw.indexOf(0x5c) < 0) return raw.toString('utf8', 1, n - 1);
    try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        return typeof parsed === 'string' ? parsed : raw.toString('utf8');
    } catch {
        // A malformed escape is still real bytes; report them rather than
        // pretending the member does not exist.
        return raw.toString('utf8', 1, Math.max(1, n - 1));
    }
}

export interface IndexStats {
    readonly nodes: number;
    readonly denseChildren: number;
    readonly checkpoints: number;
    readonly keyIndexEntries: number;
    readonly bytes: number;
    readonly buildMs: number;
    readonly maxDepth: number;
    readonly errorAt: number;
    readonly errorMessage: string;
    readonly truncatedIndex: boolean;
}

export class StrideIndex {
    readonly source: StrideSource;

    // ── node table ───────────────────────────────────────────────────────
    private nStart = new Float64Array(0);
    private nEnd = new Float64Array(0);
    private nKind = new Uint8Array(0);
    private nDepth = new Uint32Array(0);
    private nParent = new Int32Array(0);
    private nCount = new Float64Array(0);
    private nFlags = new Uint8Array(0);
    private nChildOff = new Int32Array(0);
    private nChildLen = new Int32Array(0);
    private nCkOff = new Int32Array(0);
    private nCkLen = new Int32Array(0);
    private nCkStride = new Int32Array(0);
    private nKeyIdxOff = new Int32Array(0);
    private nKeyIdxLen = new Int32Array(0);
    /** Ordinal of this node within its parent. */
    private nSlot = new Float64Array(0);
    private nCounter = 0;

    // ── dense child table ────────────────────────────────────────────────
    private cStart = new Float64Array(0);
    private cEnd = new Float64Array(0);
    private cKind = new Uint8Array(0);
    private cNode = new Int32Array(0);
    private cKeyOff = new Uint32Array(0);
    private cKeyLen = new Uint32Array(0);
    private cCounter = 0;

    // ── checkpoints: byte offset of every stride-th member ───────────────
    private ck = new Float64Array(0);
    private ckCounter = 0;

    // ── wide-object member index: parallel hash and ordinal arrays ───────
    private kiHash = new Uint32Array(0);
    private kiOrd = new Float64Array(0);
    private kiCounter = 0;

    // ── member-name blob ─────────────────────────────────────────────────
    private keyBlob: Buffer = Buffer.alloc(0);
    private keyLen = 0;

    private statsValue: IndexStats = {
        nodes: 0, denseChildren: 0, checkpoints: 0, keyIndexEntries: 0,
        bytes: 0, buildMs: 0, maxDepth: 0, errorAt: -1, errorMessage: '', truncatedIndex: false,
    };

    private constructor(source: StrideSource) {
        this.source = source;
    }

    get stats(): IndexStats { return this.statsValue; }
    get rootId(): number { return this.nCounter > 0 ? 0 : -1; }

    node(id: number): IndexedNode | null {
        if (id < 0 || id >= this.nCounter) return null;
        return {
            id,
            kind: KIND_NAMES[this.nKind[id] ?? 0] ?? 'null',
            start: this.nStart[id] ?? 0,
            end: this.nEnd[id] ?? 0,
            depth: this.nDepth[id] ?? 0,
            parent: this.nParent[id] ?? -1,
            count: this.nCount[id] ?? 0,
            flags: this.nFlags[id] ?? 0,
        };
    }

    /** Ordinal of `id` within its parent container. */
    slotOf(id: number): number {
        return this.nSlot[id] ?? -1;
    }

    /** Member name of `id`, or null when its parent is an array or it is the root. */
    keyOf(id: number): string | null {
        const parent = this.nParent[id] ?? -1;
        if (parent < 0) return null;
        if ((this.nFlags[parent] ?? 0) !== 0 && (this.nKind[parent] ?? 0) !== K_OBJECT) return null;
        const off = this.nChildOff[parent] ?? -1;
        const len = this.nChildLen[parent] ?? 0;
        for (let i = 0; i < len; i++) {
            if (this.cNode[off + i] === id) {
                const ko = this.cKeyOff[off + i] ?? 0;
                const kl = this.cKeyLen[off + i] ?? 0;
                return kl === 0 ? null : this.keyBlob.toString('utf8', ko, ko + kl);
            }
        }
        return null;
    }

    /** True when this container's members were stored one by one. */
    isDense(id: number): boolean { return ((this.nFlags[id] ?? 0) & F_DENSE) !== 0; }
    /** True when this container is represented by checkpoints. */
    isCheckpointed(id: number): boolean { return ((this.nFlags[id] ?? 0) & F_CHECKPOINT) !== 0; }
    /** True when the member hash table does not cover every member. */
    hasPartialKeys(id: number): boolean { return ((this.nFlags[id] ?? 0) & F_PARTIAL_KEYS) !== 0; }

    /** Members of a densely indexed container. Empty for a checkpointed one. */
    denseChildren(id: number): ChildRef[] {
        const off = this.nChildOff[id] ?? -1;
        const len = this.nChildLen[id] ?? 0;
        if (off < 0 || len === 0) return [];
        const out: ChildRef[] = new Array<ChildRef>(len);
        for (let i = 0; i < len; i++) {
            const ko = this.cKeyOff[off + i] ?? 0;
            const kl = this.cKeyLen[off + i] ?? 0;
            out[i] = {
                start: this.cStart[off + i] ?? 0,
                end: this.cEnd[off + i] ?? 0,
                kind: KIND_NAMES[this.cKind[off + i] ?? 0] ?? 'null',
                node: this.cNode[off + i] ?? -1,
                key: kl === 0 ? null : this.keyBlob.toString('utf8', ko, ko + kl),
                ordinal: i,
            };
        }
        return out;
    }

    /** The stride of a checkpointed container: members between stored offsets. */
    strideOf(id: number): number { return this.nCkStride[id] ?? 1; }

    /**
     * Byte offset of the checkpoint at or before member `ordinal`, with the
     * ordinal that offset actually names. Returns null when `id` has none.
     *
     * The offset is a RESUMABLE MEMBER BOUNDARY: for an array element the first
     * byte of the value, for an object member the first byte of the NAME. An
     * object interior scanned from a value boundary pairs every name with the
     * preceding member's value, so this boundary is what a caller may hand to
     * `scanStructure`, and nothing else is.
     */
    checkpointBefore(id: number, ordinal: number): { offset: number; ordinal: number } | null {
        const off = this.nCkOff[id] ?? -1;
        const len = this.nCkLen[id] ?? 0;
        if (off < 0 || len === 0) return null;
        const stride = this.nCkStride[id] ?? 1;
        let slot = Math.floor(ordinal / stride);
        if (slot >= len) slot = len - 1;
        if (slot < 0) slot = 0;
        return { offset: this.ck[off + slot] ?? 0, ordinal: slot * stride };
    }

    /**
     * The last checkpoint at or before byte offset `at`, for mapping a raw
     * match position back to the member that contains it. Same boundary
     * guarantee as `checkpointBefore`.
     */
    checkpointAtByte(id: number, at: number): { offset: number; ordinal: number } | null {
        const off = this.nCkOff[id] ?? -1;
        const len = this.nCkLen[id] ?? 0;
        if (off < 0 || len === 0) return null;
        let lo = 0;
        let hi = len - 1;
        let best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((this.ck[off + mid] ?? 0) <= at) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        const stride = this.nCkStride[id] ?? 1;
        return { offset: this.ck[off + best] ?? 0, ordinal: best * stride };
    }

    /**
     * Ordinal of a member of a wide object by name, or -1. Uses the hash table
     * when the object is covered by it; the caller falls back to a walk when
     * this misses, as it does by design for every member lying within
     * STRIDE_RESCAN_BYTES of the container's first byte — reaching those by
     * walking is the re-scan the stride was tuned against, not a penalty.
     */
    lookupWideKey(id: number, key: string): number {
        const off = this.nKeyIdxOff[id] ?? -1;
        const len = this.nKeyIdxLen[id] ?? 0;
        if (off < 0 || len === 0) return -1;
        const b = Buffer.from(key, 'utf8');
        const h = hashBytes(b, 0, b.length);
        // Linear probe from the hash slot: collisions are resolved by the
        // caller re-reading the member name from the source, so a false hit
        // costs a comparison, never a wrong answer.
        for (let i = 0; i < len; i++) {
            if (this.kiHash[off + i] === h) return this.kiOrd[off + i] ?? -1;
        }
        return -1;
    }

    /** Total heap bytes the index occupies. */
    private measure(): number {
        return this.nCounter * (8 + 8 + 1 + 4 + 4 + 8 + 1 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 8)
            + this.cCounter * (8 + 8 + 1 + 4 + 4 + 4)
            + this.ckCounter * 8
            + this.kiCounter * 12
            + this.keyLen;
    }

    // ── build ────────────────────────────────────────────────────────────

    static build(source: StrideSource): StrideIndex {
        const t0 = Date.now();
        const idx = new StrideIndex(source);

        // Per-depth staging. A container's members accumulate here until it
        // closes, at which point they are committed as dense children or
        // reduced to checkpoints.
        interface Frame {
            /** -1 when this container is outside the skeleton and has no node. */
            nodeId: number;
            kind: number;
            start: number;
            /**
             * Still recording one entry per member. This is the container's own
             * question — "record my members densely?" — and nothing else. Whether
             * a member gets an index node of its own is a separate question, put
             * to the PARENT at `enter`.
             */
            dense: boolean;
            count: number;           // members seen so far
            // dense staging
            dStart: number[];
            dEnd: number[];
            dKind: number[];
            dNode: number[];
            dKeyOff: number[];
            dKeyLen: number[];
            /**
             * Resumable scan boundary of each staged member — see `addChild`.
             * Only the reduction to checkpoints reads it, and only the entries
             * it keeps survive the container proving itself bulk.
             */
            dBoundary: number[];
            // checkpoint staging
            ckOffsets: number[];
            ckStride: number;
            // wide-object member index staging
            kiHash: number[];
            kiOrd: number[];
            partialKeys: boolean;
            // pending member name for the next value
            pendKeyOff: number;
            pendKeyLen: number;
            /**
             * Byte offset of the opening quote of the pending member name, or -1
             * when no name is pending. This — not the value offset beside it — is
             * where a resumed scan of an object has to start.
             */
            pendNameStart: number;
            // Table sizes when this container was entered. The scan is a single
            // forward pass, so every row allocated after these marks and before
            // this container closes belongs to one of its descendants.
            markNode: number;
            markChild: number;
            markCk: number;
            markKi: number;
            markKey: number;
        }

        const stack: Frame[] = [];
        let truncated = false;

        const appendKey = (raw: Buffer): { off: number; len: number } => {
            const text = decodeJsonString(raw);
            const bytes = Buffer.from(text, 'utf8');
            if (idx.keyLen + bytes.length > idx.keyBlob.length) {
                let n = idx.keyBlob.length === 0 ? 4096 : idx.keyBlob.length;
                while (n < idx.keyLen + bytes.length) n *= 2;
                const next = Buffer.allocUnsafe(n);
                idx.keyBlob.copy(next, 0, 0, idx.keyLen);
                idx.keyBlob = next;
            }
            bytes.copy(idx.keyBlob, idx.keyLen);
            const off = idx.keyLen;
            idx.keyLen += bytes.length;
            return { off, len: bytes.length };
        };

        const newNode = (kind: number, start: number, depth: number, parent: number, slot: number): number => {
            const id = idx.nCounter++;
            idx.nStart = growF64(idx.nStart, idx.nCounter); idx.nStart[id] = start;
            idx.nEnd = growF64(idx.nEnd, idx.nCounter); idx.nEnd[id] = 0;
            idx.nKind = growU8(idx.nKind, idx.nCounter); idx.nKind[id] = kind;
            idx.nDepth = growU32(idx.nDepth, idx.nCounter); idx.nDepth[id] = depth;
            idx.nParent = growI32(idx.nParent, idx.nCounter); idx.nParent[id] = parent;
            idx.nCount = growF64(idx.nCount, idx.nCounter); idx.nCount[id] = 0;
            idx.nFlags = growU8(idx.nFlags, idx.nCounter); idx.nFlags[id] = 0;
            idx.nChildOff = growI32(idx.nChildOff, idx.nCounter); idx.nChildOff[id] = -1;
            idx.nChildLen = growI32(idx.nChildLen, idx.nCounter); idx.nChildLen[id] = 0;
            idx.nCkOff = growI32(idx.nCkOff, idx.nCounter); idx.nCkOff[id] = -1;
            idx.nCkLen = growI32(idx.nCkLen, idx.nCounter); idx.nCkLen[id] = 0;
            idx.nCkStride = growI32(idx.nCkStride, idx.nCounter); idx.nCkStride[id] = 1;
            idx.nKeyIdxOff = growI32(idx.nKeyIdxOff, idx.nCounter); idx.nKeyIdxOff[id] = -1;
            idx.nKeyIdxLen = growI32(idx.nKeyIdxLen, idx.nCounter); idx.nKeyIdxLen[id] = 0;
            idx.nSlot = growF64(idx.nSlot, idx.nCounter); idx.nSlot[id] = slot;
            return id;
        };

        const result = scanStructure(source, 0, source.size, {
            enter(kind, start, depth) {
                const parentFrame = stack.length > 0 ? stack[stack.length - 1] : undefined;
                // The second of the two decisions, and it belongs to the parent:
                // a member's node id is only ever read out of its parent's dense
                // table, so a node whose parent has stopped recording densely can
                // never be reached again and would cost 70 bytes to say nothing.
                // "The parent is still structure" is therefore the whole
                // predicate — and it is what halts descent at a bulk collection
                // rather than indexing every record inside it.
                const parentIndexes = parentFrame === undefined
                    ? true
                    : parentFrame.nodeId >= 0 && parentFrame.dense;
                const indexed = parentIndexes && idx.nCounter < MAX_INDEX_NODES;
                // Only a node the ceiling actually refused is a truncation. A
                // node the skeleton never wanted is the design working, and
                // reporting that as truncation would make `truncatedIndex` mean
                // nothing on every large document.
                if (parentIndexes && !indexed) truncated = true;

                let nodeId = -1;
                if (indexed) {
                    const parentId = parentFrame === undefined ? -1 : parentFrame.nodeId;
                    const slot = parentFrame === undefined ? -1 : parentFrame.count;
                    nodeId = newNode(kind, start, depth, parentId, slot);
                }
                stack.push({
                    nodeId, kind, start,
                    // A container with no node has nowhere to commit member rows
                    // to, so it records nothing at all; its members are recovered
                    // by scanning its own span on demand.
                    dense: nodeId >= 0,
                    count: 0,
                    dStart: [], dEnd: [], dKind: [], dNode: [], dKeyOff: [], dKeyLen: [], dBoundary: [],
                    ckOffsets: [], ckStride: STRIDE_DEFAULT,
                    kiHash: [], kiOrd: [], partialKeys: false,
                    pendKeyOff: 0, pendKeyLen: 0, pendNameStart: -1,
                    markNode: idx.nCounter, markChild: idx.cCounter, markCk: idx.ckCounter,
                    markKi: idx.kiCounter, markKey: idx.keyLen,
                });
            },

            key(start, end) {
                const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;
                if (frame === undefined || frame.nodeId < 0) return;
                // Recorded whether or not the name itself is kept: the name's
                // first byte is the only offset this object can be re-entered
                // from (see `addChild`).
                frame.pendNameStart = start;
                if (frame.dense) {
                    const k = appendKey(source.slice(start, end));
                    frame.pendKeyOff = k.off;
                    frame.pendKeyLen = k.len;
                    return;
                }
                frame.pendKeyLen = 0;
                // Past the dense limit a name is worth keeping only as a hash,
                // and only where the hash saves work. A by-name lookup that
                // misses this table walks from the container's first byte, and
                // STRIDE_RESCAN_BYTES is the walk distance the stride is already
                // tuned to accept. A member inside that distance therefore costs
                // no more to reach by walking than by seeking, so an entry for it
                // would be 12 bytes that buy nothing.
                if (start - frame.start < STRIDE_RESCAN_BYTES) return;
                if (idx.kiCounter + frame.kiHash.length < KEY_INDEX_CAP && frame.kiHash.length < KEY_INDEX_CAP) {
                    // Wide object: keep a hash, not the name. Names are re-read
                    // from the source when a lookup needs to confirm a hit.
                    const raw = source.slice(start, end);
                    const text = decodeJsonString(raw);
                    const b = Buffer.from(text, 'utf8');
                    frame.kiHash.push(hashBytes(b, 0, b.length));
                    frame.kiOrd.push(frame.count);
                } else {
                    frame.partialKeys = true;
                }
            },

            scalar(kind, start, end) {
                const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;
                if (frame === undefined) {
                    // A bare scalar document.
                    if (idx.nCounter === 0) {
                        const id = newNode(kind, start, 0, -1, -1);
                        idx.nEnd[id] = end;
                    }
                    return;
                }
                addChild(frame, start, end, kind, -1);
            },

            exit(_kind, start, end, _depth, childCount) {
                const frame = stack.pop();
                if (frame === undefined) return;
                const id = frame.nodeId;
                if (id >= 0) {
                    idx.nEnd[id] = end;
                    idx.nCount[id] = childCount;
                    commit(frame, id);
                }
                const parentFrame = stack.length > 0 ? stack[stack.length - 1] : undefined;
                if (parentFrame !== undefined) {
                    addChild(parentFrame, start, end, frame.kind, id);
                }
            },
        });

        /**
         * Keep every other checkpoint, doubling the stride. Exact rather than
         * approximate: the offsets that remain still name members a fixed number
         * of ordinals apart. Coarsening is the only reduction available, because
         * an offset that was never recorded cannot be recovered without another
         * pass over the document.
         */
        function halveCheckpoints(offsets: number[]): number[] {
            return offsets.filter((_at, i) => i % 2 === 0);
        }

        /**
         * Give back every index row allocated since `frame` was entered, apart
         * from the frame's own node.
         *
         * A container that has just proved itself bulk is about to drop its dense
         * table, and that table was the only route to its members' node ids. So
         * every node, dense row, checkpoint, hash entry and name byte recorded
         * for its subtree is unreachable from here on, and an unreachable row is
         * pure footprint. Truncating the counters back to the entry marks is
         * exact rather than approximate because the scan is a single forward
         * pass: this container's ancestors staged their rows before its own node
         * existed, its siblings have not been scanned yet, and its descendants
         * are all closed. Nothing outside the discarded range refers into it.
         */
        function discardDescendants(frame: Frame): void {
            idx.nCounter = frame.markNode;
            idx.cCounter = frame.markChild;
            idx.ckCounter = frame.markCk;
            idx.kiCounter = frame.markKi;
            idx.keyLen = frame.markKey;
        }

        function addChild(frame: Frame, start: number, end: number, kind: number, nodeId: number): void {
            const ordinal = frame.count;
            frame.count++;
            if (frame.nodeId < 0) return;

            // Where a scan that resumes at this member has to begin. For an
            // ARRAY element that is the value's first byte. For an OBJECT member
            // it is the first byte of the NAME, because an object interior
            // entered at a value boundary reads that value as a name and the
            // following name as its value: the member vanishes and every member
            // after it is reported under its neighbour's name. A pending name
            // missing here means the document is malformed at this point, which
            // `errorAt` already reports, and the value's own start is then the
            // only offset that exists.
            const boundary = frame.kind === K_OBJECT && frame.pendNameStart >= 0
                ? frame.pendNameStart
                : start;
            frame.pendNameStart = -1;

            if (frame.dense) {
                frame.dStart.push(start);
                frame.dEnd.push(end);
                frame.dKind.push(kind);
                frame.dNode.push(nodeId);
                frame.dKeyOff.push(frame.pendKeyOff);
                frame.dKeyLen.push(frame.kind === K_OBJECT ? frame.pendKeyLen : 0);
                frame.dBoundary.push(boundary);
                frame.pendKeyLen = 0;
                if (frame.count > DENSE_CHILD_LIMIT) {
                    // The container just proved itself a bulk collection rather
                    // than structure. Reduce the per-member table to every
                    // stride-th boundary and stop lending nodes to members —
                    // including the ones already lent, which this table was the
                    // only way to find.
                    frame.ckOffsets = frame.dBoundary.filter((_at, i) => i % frame.ckStride === 0);
                    frame.dStart = []; frame.dEnd = []; frame.dKind = [];
                    frame.dNode = []; frame.dKeyOff = []; frame.dKeyLen = [];
                    frame.dBoundary = [];
                    frame.dense = false;
                    discardDescendants(frame);
                }
                return;
            }

            // Checkpoint mode.
            if (ordinal % frame.ckStride === 0) frame.ckOffsets.push(boundary);
            if (frame.ckOffsets.length > CHECKPOINT_CAP) {
                frame.ckOffsets = halveCheckpoints(frame.ckOffsets);
                frame.ckStride *= 2;
            }
            frame.pendKeyLen = 0;
        }

        function commit(frame: Frame, id: number): void {
            const bytes = (idx.nEnd[id] ?? 0) - (idx.nStart[id] ?? 0);
            if (frame.dense) {
                // Dense: one entry per member.
                const n = frame.dStart.length;
                if (n > 0) {
                    const base = idx.cCounter;
                    idx.cCounter += n;
                    idx.cStart = growF64(idx.cStart, idx.cCounter);
                    idx.cEnd = growF64(idx.cEnd, idx.cCounter);
                    idx.cKind = growU8(idx.cKind, idx.cCounter);
                    idx.cNode = growI32(idx.cNode, idx.cCounter);
                    idx.cKeyOff = growU32(idx.cKeyOff, idx.cCounter);
                    idx.cKeyLen = growU32(idx.cKeyLen, idx.cCounter);
                    // Bulk copy rather than element by element: a per-element
                    // read of a staging array is `number | undefined`, and every
                    // default that could be given for a missing span would be a
                    // fabricated offset. `set` needs no default at all.
                    idx.cStart.set(frame.dStart, base);
                    idx.cEnd.set(frame.dEnd, base);
                    idx.cKind.set(frame.dKind, base);
                    idx.cNode.set(frame.dNode, base);
                    idx.cKeyOff.set(frame.dKeyOff, base);
                    idx.cKeyLen.set(frame.dKeyLen, base);
                    idx.nChildOff[id] = base;
                    idx.nChildLen[id] = n;
                }
                idx.nFlags[id] = (idx.nFlags[id] ?? 0) | F_DENSE;
                return;
            }

            // Checkpointed. Retune the stride by BYTES per member: latency
            // tracks the re-scan distance, not the member count, so a
            // collection of 40-byte members can afford a much wider stride
            // than one of 4 KB members.
            const count = idx.nCount[id] ?? 0;
            let stride = frame.ckStride;
            if (count > 0) {
                const perMember = Math.max(1, bytes / count);
                const wanted = Math.max(1, Math.min(STRIDE_MAX, Math.round(STRIDE_RESCAN_BYTES / perMember)));
                while (stride < wanted && frame.ckOffsets.length > 1) {
                    frame.ckOffsets = halveCheckpoints(frame.ckOffsets);
                    stride *= 2;
                }
            }
            const base = idx.ckCounter;
            idx.ckCounter += frame.ckOffsets.length;
            idx.ck = growF64(idx.ck, idx.ckCounter);
            idx.ck.set(frame.ckOffsets, base);
            idx.nCkOff[id] = base;
            idx.nCkLen[id] = frame.ckOffsets.length;
            idx.nCkStride[id] = stride;
            idx.nFlags[id] = (idx.nFlags[id] ?? 0) | F_CHECKPOINT | (frame.partialKeys ? F_PARTIAL_KEYS : 0);

            if (frame.kiHash.length > 0) {
                const kb = idx.kiCounter;
                idx.kiCounter += frame.kiHash.length;
                idx.kiHash = growU32(idx.kiHash, idx.kiCounter);
                idx.kiOrd = growF64(idx.kiOrd, idx.kiCounter);
                idx.kiHash.set(frame.kiHash, kb);
                idx.kiOrd.set(frame.kiOrd, kb);
                idx.nKeyIdxOff[id] = kb;
                idx.nKeyIdxLen[id] = frame.kiHash.length;
            }
        }

        idx.statsValue = {
            nodes: idx.nCounter,
            denseChildren: idx.cCounter,
            checkpoints: idx.ckCounter,
            keyIndexEntries: idx.kiCounter,
            bytes: idx.measure(),
            buildMs: Date.now() - t0,
            maxDepth: result.maxDepth,
            errorAt: result.errorAt,
            errorMessage: result.errorMessage,
            truncatedIndex: truncated,
        };
        return idx;
    }
}

export { K_OBJECT, K_ARRAY };
