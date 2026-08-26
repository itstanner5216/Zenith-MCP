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
// Nothing here allocates an object per JSON value. Node handles are views
// materialised on demand from parallel typed arrays.
// ---------------------------------------------------------------------------

import {
    STRIDE_DEFAULT, STRIDE_MAX, STRIDE_RESCAN_BYTES,
    type StrideKind,
} from './types.js';
import type { StrideSource } from './source.js';
import { scanStructure, KIND_NAMES, K_OBJECT, K_ARRAY } from './scan.js';

/** A container is indexed member-by-member up to this width. */
const EAGER_CHILD_LIMIT = 1024;

/** Hard ceiling on eagerly indexed nodes, so index memory cannot run away. */
const MAX_EAGER_NODES = 250_000;

/** Checkpoints kept per wide container. The stride doubles rather than exceed it. */
const CHECKPOINT_CAP = 16_384;

/** Members of a wide object that get a hash-table entry. Beyond this, lookup scans. */
const KEY_INDEX_CAP = 262_144;

export const F_DENSE = 1;
export const F_CHECKPOINT = 2;
/** Set when the container is wider than the key hash table could cover. */
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

function growF64(a: Float64Array, need: number): Float64Array {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Float64Array(n);
    out.set(a);
    return out;
}
function growI32(a: Int32Array, need: number): Int32Array {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Int32Array(n);
    out.set(a);
    return out;
}
function growU32(a: Uint32Array, need: number): Uint32Array {
    if (need <= a.length) return a;
    let n = a.length === 0 ? 1024 : a.length;
    while (n < need) n *= 2;
    const out = new Uint32Array(n);
    out.set(a);
    return out;
}
function growU8(a: Uint8Array, need: number): Uint8Array {
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
     * match position back to the member that contains it.
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
     * when the object is covered by it; the caller falls back to a scan when
     * `hasPartialKeys` is set and this misses.
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
            nodeId: number;
            kind: number;
            start: number;
            eager: boolean;          // ancestors permit member-by-member indexing
            count: number;           // members seen so far
            // dense staging
            dStart: number[];
            dEnd: number[];
            dKind: number[];
            dNode: number[];
            dKeyOff: number[];
            dKeyLen: number[];
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
        }

        const stack: Frame[] = [];
        let pendingKeyOff = 0;
        let pendingKeyLen = 0;
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
                const parentEager = parentFrame === undefined ? true : parentFrame.eager;
                const eager = parentEager && idx.nCounter < MAX_EAGER_NODES;
                if (!eager && idx.nCounter >= MAX_EAGER_NODES) truncated = true;

                let nodeId = -1;
                if (eager) {
                    const parentId = parentFrame === undefined ? -1 : parentFrame.nodeId;
                    const slot = parentFrame === undefined ? -1 : parentFrame.count;
                    nodeId = newNode(kind, start, depth, parentId, slot);
                }
                stack.push({
                    nodeId, kind, start, eager,
                    count: 0,
                    dStart: [], dEnd: [], dKind: [], dNode: [], dKeyOff: [], dKeyLen: [],
                    ckOffsets: [], ckStride: STRIDE_DEFAULT,
                    kiHash: [], kiOrd: [], partialKeys: false,
                    pendKeyOff: 0, pendKeyLen: 0,
                });
                pendingKeyOff = 0;
                pendingKeyLen = 0;
            },

            key(start, end) {
                const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;
                if (frame === undefined) return;
                // A member name is only stored when somebody can use it: the
                // container is eagerly indexed, or it is a wide object whose
                // hash table still has room.
                if (!frame.eager) { pendingKeyLen = 0; return; }
                if (frame.count < EAGER_CHILD_LIMIT) {
                    const k = appendKey(source.slice(start, end));
                    pendingKeyOff = k.off;
                    pendingKeyLen = k.len;
                    frame.pendKeyOff = k.off;
                    frame.pendKeyLen = k.len;
                } else if (idx.kiCounter + frame.kiHash.length < KEY_INDEX_CAP && frame.kiHash.length < KEY_INDEX_CAP) {
                    // Wide object: keep a hash, not the name. Names are re-read
                    // from the source when a lookup needs to confirm a hit.
                    const raw = source.slice(start, end);
                    const text = decodeJsonString(raw);
                    const b = Buffer.from(text, 'utf8');
                    frame.kiHash.push(hashBytes(b, 0, b.length));
                    frame.kiOrd.push(frame.count);
                    pendingKeyLen = 0;
                } else {
                    frame.partialKeys = true;
                    pendingKeyLen = 0;
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

        function addChild(frame: Frame, start: number, end: number, kind: number, nodeId: number): void {
            const ordinal = frame.count;
            frame.count++;
            if (!frame.eager) return;

            if (frame.count <= EAGER_CHILD_LIMIT && frame.ckOffsets.length === 0) {
                frame.dStart.push(start);
                frame.dEnd.push(end);
                frame.dKind.push(kind);
                frame.dNode.push(nodeId);
                frame.dKeyOff.push(frame.pendKeyOff);
                frame.dKeyLen.push(frame.kind === K_OBJECT ? frame.pendKeyLen : 0);
                frame.pendKeyLen = 0;
                if (frame.count === EAGER_CHILD_LIMIT) {
                    // The container just proved itself a bulk collection. Drop
                    // the per-member table, keep every stride-th offset, and
                    // stop treating descendants as skeleton.
                    for (let i = 0; i < frame.dStart.length; i += frame.ckStride) {
                        frame.ckOffsets.push(frame.dStart[i] ?? 0);
                    }
                    frame.dStart = []; frame.dEnd = []; frame.dKind = [];
                    frame.dNode = []; frame.dKeyOff = []; frame.dKeyLen = [];
                    frame.eager = frame.kind === K_OBJECT || frame.kind === K_ARRAY;
                }
                return;
            }

            // Checkpoint mode.
            if (ordinal % frame.ckStride === 0) frame.ckOffsets.push(start);
            if (frame.ckOffsets.length > CHECKPOINT_CAP) {
                // Halve the resolution rather than grow without bound: keeping
                // every other checkpoint doubles the stride and is exact.
                const halved: number[] = [];
                for (let i = 0; i < frame.ckOffsets.length; i += 2) halved.push(frame.ckOffsets[i] ?? 0);
                frame.ckOffsets = halved;
                frame.ckStride *= 2;
            }
            frame.pendKeyLen = 0;
        }

        function commit(frame: Frame, id: number): void {
            const bytes = (idx.nEnd[id] ?? 0) - (idx.nStart[id] ?? 0);
            if (frame.ckOffsets.length === 0) {
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
                    for (let i = 0; i < n; i++) {
                        idx.cStart[base + i] = frame.dStart[i] ?? 0;
                        idx.cEnd[base + i] = frame.dEnd[i] ?? 0;
                        idx.cKind[base + i] = frame.dKind[i] ?? 0;
                        idx.cNode[base + i] = frame.dNode[i] ?? -1;
                        idx.cKeyOff[base + i] = frame.dKeyOff[i] ?? 0;
                        idx.cKeyLen[base + i] = frame.dKeyLen[i] ?? 0;
                    }
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
                // Only ever coarsen: the offsets that were not recorded cannot
                // be recovered without another pass over the document.
                while (stride < wanted && frame.ckOffsets.length > 1) {
                    const halved: number[] = [];
                    for (let i = 0; i < frame.ckOffsets.length; i += 2) halved.push(frame.ckOffsets[i] ?? 0);
                    frame.ckOffsets = halved;
                    stride *= 2;
                }
            }
            const base = idx.ckCounter;
            idx.ckCounter += frame.ckOffsets.length;
            idx.ck = growF64(idx.ck, idx.ckCounter);
            for (let i = 0; i < frame.ckOffsets.length; i++) idx.ck[base + i] = frame.ckOffsets[i] ?? 0;
            idx.nCkOff[id] = base;
            idx.nCkLen[id] = frame.ckOffsets.length;
            idx.nCkStride[id] = stride;
            idx.nFlags[id] = (idx.nFlags[id] ?? 0) | F_CHECKPOINT | (frame.partialKeys ? F_PARTIAL_KEYS : 0);

            if (frame.kiHash.length > 0) {
                const kb = idx.kiCounter;
                idx.kiCounter += frame.kiHash.length;
                idx.kiHash = growU32(idx.kiHash, idx.kiCounter);
                idx.kiOrd = growF64(idx.kiOrd, idx.kiCounter);
                for (let i = 0; i < frame.kiHash.length; i++) {
                    idx.kiHash[kb + i] = frame.kiHash[i] ?? 0;
                    idx.kiOrd[kb + i] = frame.kiOrd[i] ?? 0;
                }
                idx.nKeyIdxOff[id] = kb;
                idx.nKeyIdxLen[id] = frame.kiHash.length;
            }
        }

        void pendingKeyOff;
        void pendingKeyLen;

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
