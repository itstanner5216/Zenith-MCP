// ---------------------------------------------------------------------------
// core/stride/source.ts — bounded-memory access to the document bytes
//
// STRIDE never holds a whole document in the heap unless the caller already
// did. Two sources satisfy one interface:
//
//   BufferSource  the caller handed us bytes; we index them in place.
//   FileSource    the caller handed us a path; we hold a file descriptor and a
//                 fixed-size page cache. A 600 MB file costs the cache, not
//                 600 MB. (invariant I6)
//
// There is no mmap here on purpose. Node has no built-in memory mapping, and a
// `bytes(mm)` copy dressed up as one is worse than honest paging: it silently
// materialises the whole file. Measured on this class of workload, a syscall
// read has a ~550 ns floor regardless of size while an in-process subarray of
// a cached page costs ~80 ns, so a page cache in front of positional reads is
// both the honest and the fast answer.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { StrideError } from './types.js';

/** Page size for FileSource. Large enough that sequential scans rarely fault. */
const PAGE_BITS = 20;                       // 1 MiB
const PAGE_BYTES = 1 << PAGE_BITS;

/** Default resident-page budget. 32 pages = 32 MiB, independent of file size. */
const DEFAULT_PAGE_CACHE = 32;

/** Chunk handed to the scanner on a sequential pass. */
const SCAN_CHUNK_BYTES = 4 << 20;           // 4 MiB

/**
 * A single slice may not exceed this. A caller asking for a 400 MB scalar in
 * one piece is a bug in the caller, and answering it would defeat I6; the
 * failure names the paging call to use instead.
 */
export const MAX_SLICE_BYTES = 64 << 20;    // 64 MiB

export interface StrideSource {
    /** Total bytes in the document. */
    readonly size: number;
    /** A stable identity for cache keying: path+mtime, or a content digest. */
    readonly id: string;
    /** Bytes in [start, end). Never longer than MAX_SLICE_BYTES. */
    slice(start: number, end: number): Buffer;
    /** The single byte at `i`, or -1 past the end. */
    byteAt(i: number): number;
    /**
     * Feed [from, to) to `onChunk` in order, as buffers the callee must not
     * retain. `absolute` is the document offset of chunk byte 0.
     */
    sequential(from: number, to: number, onChunk: (chunk: Buffer, absolute: number) => void): void;
    close(): void;
}

function guardRange(start: number, end: number, size: number): [number, number] {
    const s = start < 0 ? 0 : start > size ? size : start;
    const e = end < s ? s : end > size ? size : end;
    if (e - s > MAX_SLICE_BYTES) {
        throw new StrideError(
            'too_large',
            `Requested ${e - s} bytes in one slice; the limit is ${MAX_SLICE_BYTES}.`,
            `Read it in pages: call mode "scalar" with an offset and length, or narrow the pointer.`,
            s,
        );
    }
    return [s, e];
}

/** A document already resident in memory. */
export class BufferSource implements StrideSource {
    readonly size: number;
    readonly id: string;
    private readonly buf: Buffer;

    constructor(bytes: Buffer | Uint8Array, id: string) {
        this.buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.size = this.buf.length;
        this.id = id;
    }

    slice(start: number, end: number): Buffer {
        const [s, e] = guardRange(start, end, this.size);
        return this.buf.subarray(s, e);
    }

    byteAt(i: number): number {
        if (i < 0 || i >= this.size) return -1;
        return this.buf[i] ?? -1;
    }

    sequential(from: number, to: number, onChunk: (chunk: Buffer, absolute: number) => void): void {
        const [s, e] = [Math.max(0, from), Math.min(this.size, to)];
        // One virtual chunk: the bytes are already resident, so slicing them
        // into pieces would only add copies.
        if (e > s) onChunk(this.buf.subarray(s, e), s);
    }

    close(): void {
        // Nothing to release; the caller owns the buffer.
    }
}

/** A document on disk, read through a fixed-size page cache. */
export class FileSource implements StrideSource {
    readonly size: number;
    readonly id: string;
    private readonly fd: number;
    private readonly maxPages: number;
    /** Insertion-ordered, so the first key is the least recently used. */
    private readonly pages = new Map<number, Buffer>();
    private closed = false;
    /** Diagnostics: how hard the cache is working. */
    private hits = 0;
    private misses = 0;

    constructor(path: string, maxPages: number = DEFAULT_PAGE_CACHE) {
        const st = fs.statSync(path);
        this.fd = fs.openSync(path, 'r');
        this.size = st.size;
        this.id = `${path}:${st.size}:${st.mtimeMs}`;
        this.maxPages = Math.max(2, maxPages);
    }

    get stats(): { hits: number; misses: number; residentBytes: number } {
        return { hits: this.hits, misses: this.misses, residentBytes: this.pages.size * PAGE_BYTES };
    }

    private page(index: number): Buffer {
        const cached = this.pages.get(index);
        if (cached !== undefined) {
            this.hits++;
            // Refresh recency: delete then re-insert moves it to the tail.
            this.pages.delete(index);
            this.pages.set(index, cached);
            return cached;
        }
        this.misses++;
        const offset = index * PAGE_BYTES;
        const length = Math.min(PAGE_BYTES, this.size - offset);
        const buf = Buffer.allocUnsafe(length < 0 ? 0 : length);
        if (buf.length > 0) {
            let read = 0;
            while (read < buf.length) {
                const n = fs.readSync(this.fd, buf, read, buf.length - read, offset + read);
                if (n <= 0) break;
                read += n;
            }
        }
        while (this.pages.size >= this.maxPages) {
            const oldest = this.pages.keys().next();
            if (oldest.done === true) break;
            this.pages.delete(oldest.value);
        }
        this.pages.set(index, buf);
        return buf;
    }

    slice(start: number, end: number): Buffer {
        if (this.closed) throw new StrideError('not_found', 'Source is closed.', 'Reopen the document.');
        const [s, e] = guardRange(start, end, this.size);
        if (e === s) return Buffer.alloc(0);
        const firstPage = s >>> PAGE_BITS;
        const lastPage = (e - 1) >>> PAGE_BITS;
        if (firstPage === lastPage) {
            // The common case: no copy, a view onto the cached page.
            const page = this.page(firstPage);
            const base = firstPage * PAGE_BYTES;
            return page.subarray(s - base, e - base);
        }
        // Straddles pages: one allocation, filled page by page.
        const out = Buffer.allocUnsafe(e - s);
        let written = 0;
        for (let p = firstPage; p <= lastPage; p++) {
            const page = this.page(p);
            const base = p * PAGE_BYTES;
            const from = Math.max(s, base) - base;
            const to = Math.min(e, base + page.length) - base;
            if (to > from) {
                page.copy(out, written, from, to);
                written += to - from;
            }
        }
        return out.subarray(0, written);
    }

    byteAt(i: number): number {
        if (i < 0 || i >= this.size) return -1;
        const page = this.page(i >>> PAGE_BITS);
        return page[i - (i >>> PAGE_BITS) * PAGE_BYTES] ?? -1;
    }

    sequential(from: number, to: number, onChunk: (chunk: Buffer, absolute: number) => void): void {
        if (this.closed) throw new StrideError('not_found', 'Source is closed.', 'Reopen the document.');
        const s = Math.max(0, from);
        const e = Math.min(this.size, to);
        if (e <= s) return;
        // One reusable buffer for the whole pass — allocating per chunk is the
        // difference between a warm copy and a page-fault storm.
        const buf = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, e - s));
        let pos = s;
        while (pos < e) {
            const want = Math.min(buf.length, e - pos);
            let read = 0;
            while (read < want) {
                const n = fs.readSync(this.fd, buf, read, want - read, pos + read);
                if (n <= 0) break;
                read += n;
            }
            if (read === 0) break;
            onChunk(buf.subarray(0, read), pos);
            pos += read;
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.pages.clear();
        try {
            fs.closeSync(this.fd);
        } catch {
            // A descriptor that is already gone is not a failure worth raising:
            // close() is called on every teardown path including error paths.
        }
    }
}

/** Open a document from a path, or wrap bytes the caller already holds. */
export function openSource(input: string | Buffer | Uint8Array, pageCache?: number): StrideSource {
    if (typeof input === 'string') {
        return pageCache === undefined ? new FileSource(input) : new FileSource(input, pageCache);
    }
    // Identity for an in-memory blob: length plus a cheap sampled digest. A
    // full hash of 600 MB would cost more than the index it keys.
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) {
        h = Math.imul(h ^ (bytes[i] ?? 0), 0x01000193) >>> 0;
    }
    return new BufferSource(bytes, `buffer:${bytes.length}:${h.toString(16)}`);
}
