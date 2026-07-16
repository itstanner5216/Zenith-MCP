/**
 * POLARIS Task 2.1 — the AstSession factory and session machinery.
 *
 * This module is INTERNAL. The only public door is ast-intelligence.ts, which
 * re-exports openAstSession and the two advisory lifecycle functions. Tests
 * may import the *WithDeps factory and the cursor codec directly; production
 * code must not.
 *
 * Responsibilities (plan §Task 2.1, Decisions 12, 15, 16, 24):
 *  - opaque session construction behind a disk/content freshness transition
 *  - canonical source-domain digest over sorted (storeKey, status, hash)
 *  - fact epoch pinning: PRAGMA data_version + connection outer-commit
 *    generation, revalidated with the pinned scope hash view at EVERY entry
 *  - sliding lease: +30 s per successful call, hard cap openedAt + 10 min
 *  - MAC'd keyset continuation cursors (payload: scopeKey, domain digest,
 *    snapshotKey|null, queryDigest, lastCanonicalKey)
 *  - partial-content failure receipts on open
 *  - close semantics
 *
 * The seven question handlers are wired by Task 2.3 (questions/*.ts); until
 * then every question returns a typed `unavailable` with
 * `question_kind_unsupported`, which exercises the full entry protocol.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { minimatch } from 'minimatch';

import type {
    AstSession, ContextQuestion, CoverageIssue, FileModel, FileModelQuestion, FsContext, LocationModel, ScopeModel,
    LocationQuestion, OccurrenceQuestion, OpenSessionRequest, OpenSessionResult,
    OperationalFailure, QueryResult, RelationQuestion, ResolveQuestion,
    ScopeQuestion, ScopeSelector, SessionBasis, CoveredAnswer, ContinuationCursor,
} from './types.js';
import { PROVISIONAL_LIMITS } from './limits.js';
import { canonicalJsonStringify, domainHash } from './evidence.js';
export { canonicalJsonStringify, domainHash } from './evidence.js';
import { composeFileModel } from './questions/file.js';
import { composeLocationModel } from './questions/location.js';
import { composeScopeModel } from './questions/scope.js';
import { getProjectContext, type IntelligenceStore } from '../project-context.js';
import {
    ensureFreshFromContentAt, indexFileAt, type IndexAddress, type IndexFileOutcome,
} from '../symbol-index.js';
import {
    getFactEpoch, getScopeFileHashView, runTransaction, type FactEpoch,
    readV4CompleteFileFactBundle, readV4ParentAncestry, readV4FactsIntersectingRange,
    queryV4Occurrences, readV4StructuresByInternalIds, readV4ImportsByFileKeys,
    readV4ImportBindingsByFileKeys, readV4AnchorsByFileKeys, readV4InjectionsByFileKeys,
    readV4ScopesByFileKeys, readV4EdgeResolutionStats, readV4EdgeFrontier,
    readV4DirectoryProjectAggregates, readV4FileHashesByKeys,
    type V4CompleteFileFactBundle, type V4ParentAncestryRow, type V4IntersectingFactRow,
    type V4OccurrenceFilter, type V4OccurrencePageRequest, type V4OccurrencePage,
    type V4StructureFactRow, type V4ImportFactRow, type V4ImportBindingFactRow,
    type V4AnchorFactRow, type V4InjectionFactRow, type V4ScopeFactRow,
    type V4EdgeResolutionStatRow, type V4EdgeFrontierRow,
    type V4DirectoryProjectAggregates, type V4FileCoverageRow,
} from '../db-adapter.js';
import { getLangForFile } from '../tree-sitter/languages.js';
import { getDefaultExcludes, isSensitive } from '../shared.js';
import { isSupported } from '../tree-sitter.js';

// ---------------------------------------------------------------------------
// Domain enumeration
// ---------------------------------------------------------------------------

type MemberStatus = 'present' | 'unreadable' | 'unsupported';

interface DomainMember {
    storeKey: string;
    absPath: string;
    status: MemberStatus;
    /** Stored content hash (or too-large sentinel) for present members. */
    hash: string | null;
}

interface EnumeratedDomain {
    /** Sorted by storeKey; capped at PROVISIONAL_LIMITS.workspaceFiles. */
    members: DomainMember[];
    capped: boolean;
    /** Store-key predicate defining domain membership for revalidation. */
    keyPredicate: (storeKey: string) => boolean;
    /** True when a directory read failed, so the domain is known-incomplete. */
    incompleteWalk: boolean;
}

function fileExcluded(scopeRoot: string, absPath: string, excludes: readonly string[]): boolean {
    const relPath = path.relative(scopeRoot, absPath);
    const base = path.basename(absPath);
    const dirSegments = relPath.split(path.sep).slice(0, -1);
    if (dirSegments.some((seg) => excludes.some((pattern) =>
        seg === pattern || minimatch(seg, pattern, { dot: true, nocase: true })
    ))) return true;
    return excludes.some((pattern) =>
        base === pattern ||
        minimatch(relPath, pattern, { dot: true, nocase: true }) ||
        minimatch(relPath, `**/${pattern}`, { dot: true, nocase: true })
    );
}

function dirExcluded(scopeRoot: string, absDir: string, name: string, excludes: readonly string[]): boolean {
    const relDir = path.relative(scopeRoot, absDir);
    return excludes.some((pattern) =>
        name === pattern ||
        minimatch(relDir, pattern, { dot: true, nocase: true }) ||
        minimatch(relDir, `**/${pattern}`, { dot: true, nocase: true })
    );
}

/**
 * Enumerate every domain file (excludes honored, sensitive files omitted
 * ENTIRELY — they are never members, so no later phase may scan their bytes),
 * classify support by extension, sort by store key, apply the provisional
 * workspace cap deterministically.
 *
 * Two documented conservative choices (review H2/H4):
 *  - The cap counts EVERY member kind, including unsupported files — a mixed
 *    tree can therefore cap out earlier than symbol-index's indexable-only
 *    walk. Capped domains carry incomplete_cap; honest, never silent.
 *  - Revalidation's pinned view spans the WHOLE scope prefix, not just the
 *    capped membership: a change beyond the cap invalidates the session.
 *    Conservative in the safe direction (false invalidation is a reopen;
 *    false validity would be a wrong proof).
 */
async function enumerateDomain(
    ctx: FsContext,
    address: IndexAddress,
    domain: Exclude<ScopeSelector, { kind: 'module' }>,
    anchorAbs: string,
): Promise<EnumeratedDomain | { invalid: string }> {
    const excludes = getDefaultExcludes();
    let incompleteWalk = false;
    const resolveInScope = (p: string): string | null => {
        const abs = path.isAbsolute(p) ? p : path.resolve(address.scopeRoot, p);
        return address.toStoreKey(abs) === null ? null : abs;
    };

    const files: { storeKey: string; absPath: string }[] = [];
    const pushFile = (absPath: string): void => {
        if (isSensitive(absPath)) return;
        if (fileExcluded(address.scopeRoot, absPath, excludes)) return;
        const storeKey = address.toStoreKey(absPath);
        if (storeKey === null || storeKey === '') return;
        files.push({ storeKey, absPath });
    };

    async function walk(dir: string, recursive: boolean): Promise<void> {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { incompleteWalk = true; return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!recursive) continue;
                if (dirExcluded(address.scopeRoot, fullPath, entry.name, excludes)) continue;
                await walk(fullPath, true);
            } else if (entry.isFile()) {
                pushFile(fullPath);
            }
        }
    }

    let keyPredicate: (k: string) => boolean;
    if (domain.kind === 'file') {
        const abs = resolveInScope(domain.path);
        if (abs === null) return { invalid: `file path escapes the session scope: ${domain.path}` };
        // Realpath scope guard: a lexically-in-scope path that resolves outside
        // the allowed roots (e.g. via symlink) is refused, never indexed.
        try { await ctx.validatePath(abs); } catch { return { invalid: `file path escapes the allowed scope: ${domain.path}` }; }
        pushFile(abs);
        const key = address.toStoreKey(abs);
        if (files.length === 0 || key === null) {
            return { invalid: `file path is excluded or sensitive: ${domain.path}` };
        }
        keyPredicate = (k) => k === key;
    } else if (domain.kind === 'directory') {
        const abs = resolveInScope(domain.path);
        if (abs === null) return { invalid: `directory path escapes the session scope: ${domain.path}` };
        const dirKey = address.toStoreKey(abs);
        if (dirKey === null) return { invalid: `directory path escapes the session scope: ${domain.path}` };
        // Realpath scope guard (see file branch): refuse symlinked directory
        // selectors that resolve outside the allowed roots.
        try { await ctx.validatePath(abs); } catch { return { invalid: `directory path escapes the allowed scope: ${domain.path}` }; }
        await walk(abs, domain.recursive);
        const prefix = dirKey === '' ? '' : `${dirKey}/`;
        keyPredicate = domain.recursive
            ? (k) => k.startsWith(prefix)
            : (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/');
    } else {
        // project: the whole scope root (global mode: the anchor's allowed root).
        void anchorAbs;
        await walk(address.scopeRoot, true);
        const scopePrefix = address.mode === 'global' ? `${address.scopeKey}/` : '';
        keyPredicate = scopePrefix === '' ? () => true : (k) => k.startsWith(scopePrefix);
    }

    files.sort((a, b) => (a.storeKey < b.storeKey ? -1 : a.storeKey > b.storeKey ? 1 : 0));
    const capped = files.length > PROVISIONAL_LIMITS.workspaceFiles;
    const kept = capped ? files.slice(0, PROVISIONAL_LIMITS.workspaceFiles) : files;

    return {
        members: kept.map((f) => ({
            storeKey: f.storeKey,
            absPath: f.absPath,
            status: isSupported(f.absPath) ? 'present' as const : 'unsupported' as const,
            hash: null,
        })),
        capped,
        keyPredicate,
        incompleteWalk,
    };
}

// ---------------------------------------------------------------------------
// Source-domain digest + pinned revalidation view
// ---------------------------------------------------------------------------

interface PinnedDomain {
    digest: string;
    fileCount: number;
    /** Sorted `storeKey\x1fhash` lines for present members (the DB view). */
    presentView: string[];
    keyPredicate: (storeKey: string) => boolean;
    /** '' (project mode) or `g/<hash>/` (global mode) for the view read. */
    viewPrefix: string;
    epoch: FactEpoch;
}

function computeDomainDigest(members: readonly DomainMember[]): string {
    const lines = members.map((m) => `${m.storeKey}\x1f${m.status}\x1f${m.hash ?? '-'}`);
    return domainHash('polaris-source-domain@1', lines);
}

function readPresentView(
    address: IndexAddress,
    viewPrefix: string,
    keyPredicate: (k: string) => boolean,
): string[] {
    return getScopeFileHashView(address.db, viewPrefix)
        .filter((row) => keyPredicate(row.path))
        .map((row) => `${row.path}\x1f${row.hash}`);
}

function viewsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Continuation cursor codec (Decision 24)
// ---------------------------------------------------------------------------

export interface CursorPayload {
    v: 1;
    scopeKey: string;
    domainDigest: string;
    snapshotKey: string | null;
    queryDigest: string;
    lastCanonicalKey: string;
}

export type CursorAcceptance =
    | { ok: true; lastCanonicalKey: string }
    | { ok: false; failure: OperationalFailure };

export interface SessionCursorCodec {
    issue(queryDigest: string, lastCanonicalKey: string): ContinuationCursor;
    accept(cursor: string, expectedQueryDigest: string): CursorAcceptance;
}

export function queryDigestOf(queryName: string, normalizedQuestion: unknown, limit: number): string {
    // Covers the strict normalized question and page limit, NEVER page.after.
    return domainHash('polaris-cursor-query@1', [
        queryName,
        canonicalJsonStringify(normalizedQuestion),
        String(limit),
    ]);
}

function invalidQuery(detail: string): OperationalFailure {
    return { code: 'INVALID_QUERY', retryable: false, detail, correction: 'retry' };
}

function createCursorCodec(scopeKey: string, domainDigest: string): SessionCursorCodec {
    const secret = crypto.randomBytes(32); // process-local session secret
    const mac = (payloadJson: string): Buffer =>
        crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest();
    return {
        issue(queryDigest, lastCanonicalKey) {
            const payload: CursorPayload = {
                v: 1, scopeKey, domainDigest, snapshotKey: null, queryDigest, lastCanonicalKey,
            };
            const payloadJson = canonicalJsonStringify(payload);
            const body = Buffer.from(payloadJson, 'utf8').toString('base64url');
            const tag = mac(payloadJson).toString('base64url');
            return `${body}.${tag}` as ContinuationCursor;
        },
        accept(cursor, expectedQueryDigest) {
            const dot = cursor.lastIndexOf('.');
            if (dot <= 0) return { ok: false, failure: invalidQuery('malformed continuation cursor') };
            let payloadJson: string;
            let payload: CursorPayload;
            try {
                payloadJson = Buffer.from(cursor.slice(0, dot), 'base64url').toString('utf8');
                payload = JSON.parse(payloadJson) as CursorPayload;
            } catch {
                return { ok: false, failure: invalidQuery('malformed continuation cursor') };
            }
            let suppliedTag: Buffer;
            try {
                suppliedTag = Buffer.from(cursor.slice(dot + 1), 'base64url');
            } catch {
                return { ok: false, failure: invalidQuery('malformed continuation cursor') };
            }
            const expectedTag = mac(canonicalJsonStringify(payload));
            if (suppliedTag.length !== expectedTag.length
                || !crypto.timingSafeEqual(suppliedTag, expectedTag)) {
                return { ok: false, failure: invalidQuery('continuation cursor failed authentication') };
            }
            if (payload.v !== 1
                || payload.scopeKey !== scopeKey
                || payload.domainDigest !== domainDigest
                || payload.snapshotKey !== null
                || payload.queryDigest !== expectedQueryDigest
                || typeof payload.lastCanonicalKey !== 'string') {
                return { ok: false, failure: invalidQuery('continuation cursor does not match this session and question') };
            }
            return { ok: true, lastCanonicalKey: payload.lastCanonicalKey };
        },
    };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface SessionDeps {
    now?: () => number;
}

const LEASE_SLIDE_MS = 30_000;
const LEASE_HARD_CAP_MS = 600_000;

function failed(basis: SessionBasis | null, failure: OperationalFailure): QueryResult<never> {
    return { status: 'failed', basis, failure };
}

/**
 * Classifies a caught error as a typed operational store failure, or null when
 * it is not one (programming errors stay loud — they are not query results).
 * Recognizes the composer/adapter's own STORE_CORRUPT/FUTURE_SCHEMA-prefixed
 * signals AND raw node:sqlite corruption/schema errors (dropped table, missing
 * column, malformed image, non-database file). Transient/programming SQLite
 * errors (locked db, too-many-variables, API misuse) are deliberately NOT
 * mapped, so real defects surface instead of masquerading as corruption.
 */
function typedStoreFailure(e: unknown): OperationalFailure | null {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('FUTURE_SCHEMA')) {
        return { code: 'FUTURE_SCHEMA', retryable: false, detail: message, correction: 'repair_store' };
    }
    if (message.startsWith('STORE_CORRUPT')) {
        return { code: 'STORE_CORRUPT', retryable: false, detail: message, correction: 'repair_store' };
    }
    const code = typeof e === 'object' && e !== null && 'code' in e
        ? (e as { code?: unknown }).code
        : undefined;
    if (code === 'ERR_SQLITE_ERROR') {
        const m = message.toLowerCase();
        if (m.includes('no such table') || m.includes('no such column')
            || m.includes('malformed') || m.includes('not a database')
            || m.includes('file is encrypted')) {
            return { code: 'STORE_CORRUPT', retryable: false, detail: message, correction: 'repair_store' };
        }
    }
    return null;
}

interface SessionState {
    closed: boolean;
    expiresAt: number;
    readonly hardExpiresAt: number;
    readonly openedAt: number;
}

/**
 * The bound v4 read set composers work through. Session.ts binds each named
 * db-adapter read to the session's connection ONCE; composers stay pure —
 * they never import the adapter, never hold a connection, never see SQL.
 * Every method here executes inside the entry protocol's read transaction.
 */
export interface QuestionToolkit {
    bundle(storeKeys: readonly string[]): V4CompleteFileFactBundle;
    ancestry(symbolInternalIds: readonly number[]): V4ParentAncestryRow[];
    intersecting(fileKey: string, startLine: number, endLine: number): V4IntersectingFactRow[];
    occurrences(filter: V4OccurrenceFilter, page: V4OccurrencePageRequest): V4OccurrencePage;
    structuresByIds(ids: readonly number[]): V4StructureFactRow[];
    importsByKeys(keys: readonly string[]): V4ImportFactRow[];
    bindingsByKeys(keys: readonly string[]): V4ImportBindingFactRow[];
    anchorsByKeys(keys: readonly string[]): V4AnchorFactRow[];
    injectionsByKeys(keys: readonly string[]): V4InjectionFactRow[];
    scopesByKeys(keys: readonly string[]): V4ScopeFactRow[];
    edgeStats(scopePrefix: string): V4EdgeResolutionStatRow[];
    frontier(scopePrefix: string): V4EdgeFrontierRow[];
    aggregates(scopePrefix: string): V4DirectoryProjectAggregates;
    hashesByKeys(keys: readonly string[]): V4FileCoverageRow[];
}

function buildToolkit(address: IndexAddress): QuestionToolkit {
    const db = address.db;
    return {
        bundle: (keys) => readV4CompleteFileFactBundle(db, keys),
        ancestry: (ids) => readV4ParentAncestry(db, ids),
        intersecting: (fileKey, startLine, endLine) => readV4FactsIntersectingRange(db, fileKey, startLine, endLine),
        occurrences: (filter, page) => queryV4Occurrences(db, filter, page),
        structuresByIds: (ids) => readV4StructuresByInternalIds(db, ids),
        importsByKeys: (keys) => readV4ImportsByFileKeys(db, keys),
        bindingsByKeys: (keys) => readV4ImportBindingsByFileKeys(db, keys),
        anchorsByKeys: (keys) => readV4AnchorsByFileKeys(db, keys),
        injectionsByKeys: (keys) => readV4InjectionsByFileKeys(db, keys),
        scopesByKeys: (keys) => readV4ScopesByFileKeys(db, keys),
        edgeStats: (prefix) => readV4EdgeResolutionStats(db, prefix),
        frontier: (prefix) => readV4EdgeFrontier(db, prefix),
        aggregates: (prefix) => readV4DirectoryProjectAggregates(db, prefix),
        hashesByKeys: (keys) => readV4FileHashesByKeys(db, keys),
    };
}

export interface SessionDomainFile {
    storeKey: string;
    absPath: string;
    status: 'present' | 'unreadable' | 'unsupported';
    content?: string;
}

/** What a validated entry hands to a question handler (Task 2.3 consumes). */
export interface SessionEntry {
    address: IndexAddress;
    basis: SessionBasis;
    cursors: SessionCursorCodec;
    /**
     * Domain members in canonical store-key order (absPath + classification),
     * with in-hand bytes for content-mode files: the literal floor scans
     * THESE bytes for content-fresh paths, never disk (plan floor step 3).
     */
    domainFiles: readonly SessionDomainFile[];
    /** Pinned members by store key — the membership oracle for questions. */
    memberByKey: ReadonlyMap<string, SessionDomainFile>;
    /** The bound v4 read set (executes inside the entry transaction). */
    toolkit: QuestionToolkit;
    /**
     * Resolve a question path to a pinned store key: an exact member key is
     * accepted as-is; otherwise the path resolves against the scope root
     * through the address codec. Null = not expressible in this scope.
     */
    storeKeyFor(p: string): string | null;
    /** Canonical language detection over a store key (path-derived at v4). */
    languageOf(storeKey: string): string | null;
    /** Canonical query digest for cursor issue/accept (see queryDigestOf). */
    queryDigest(queryName: string, normalizedQuestion: unknown, limit: number): string;
}

class StructuralSession implements AstSession {
    private readonly state: SessionState;
    private readonly pinned: PinnedDomain;
    private readonly address: IndexAddress;
    private readonly baseBasis: Omit<SessionBasis, 'expiresAt'>;
    private readonly now: () => number;
    private readonly domainFiles: SessionEntry['domainFiles'];
    private readonly memberByKey: ReadonlyMap<string, SessionDomainFile>;
    private readonly toolkit: QuestionToolkit;
    /** Internal, test-visible cursor codec (composers receive it per-entry). */
    readonly cursors: SessionCursorCodec;

    constructor(
        address: IndexAddress,
        pinned: PinnedDomain,
        basis: Omit<SessionBasis, 'expiresAt'>,
        domainFiles: SessionEntry['domainFiles'],
        deps: Required<SessionDeps>,
    ) {
        this.address = address;
        this.pinned = pinned;
        this.baseBasis = basis;
        this.domainFiles = domainFiles;
        this.memberByKey = new Map(domainFiles.map((f) => [f.storeKey, f]));
        this.toolkit = buildToolkit(address);
        this.now = deps.now;
        this.state = {
            closed: false,
            openedAt: basis.openedAt,
            hardExpiresAt: basis.hardExpiresAt,
            expiresAt: Math.min(basis.openedAt + LEASE_SLIDE_MS, basis.hardExpiresAt),
        };
        this.cursors = createCursorCodec(basis.scopeKey, basis.sourceDomain.digest);
    }

    get basis(): SessionBasis {
        return Object.freeze({ ...this.baseBasis, expiresAt: this.state.expiresAt });
    }

    /** Exact member keys pass through; anything else goes via the codec. */
    private storeKeyFor(p: string): string | null {
        if (this.memberByKey.has(p)) return p;
        const abs = path.isAbsolute(p) ? p : path.resolve(this.address.scopeRoot, p);
        return this.address.toStoreKey(abs);
    }

    /**
     * The entry protocol shared by every query: closed -> expired checks
     * before any DB work. Returns null when the call may proceed to the
     * transactional phase.
     */
    private lifecycleRefusal(): QueryResult<never> | null {
        if (this.state.closed) {
            return failed(this.basis, {
                code: 'SESSION_CLOSED', retryable: false,
                detail: 'this session was closed; open a new one',
                correction: 'reopen_session',
            });
        }
        const t = this.now();
        if (t > this.state.hardExpiresAt || t > this.state.expiresAt) {
            return failed(this.basis, {
                code: 'SESSION_EXPIRED', retryable: true,
                detail: 'the session lease expired',
                correction: 'reopen_session',
            });
        }
        return null;
    }

    /** Epoch + pinned-view revalidation. MUST run inside the entry txn. */
    private changedSincePin(): boolean {
        const epoch = getFactEpoch(this.address.db);
        if (epoch.dataVersion !== this.pinned.epoch.dataVersion
            || epoch.commitGeneration !== this.pinned.epoch.commitGeneration) {
            // Deliberately strict (locked design): epoch movement invalidates
            // even when the pinned (path,hash) view is untouched, because a
            // commit in ANOTHER scope of a cohabiting global store can rewrite
            // THIS scope's edges through name-based re-resolution — a change
            // the file view cannot see. Over-invalidation is the sound side of
            // that trade until semantic units make edge provenance
            // scope-explicit (Wave 5+). The view below backstops the epoch's
            // own blind spot: same-connection autocommit writes move neither
            // epoch half.
            return true;
        }
        const view = readPresentView(this.address, this.pinned.viewPrefix, this.pinned.keyPredicate);
        return !viewsEqual(view, this.pinned.presentView);
    }

    /** Successful answers slide the lease; failures never do. */
    private slide(): void {
        this.state.expiresAt = Math.min(this.now() + LEASE_SLIDE_MS, this.state.hardExpiresAt);
    }

    /**
     * Two-phase answer protocol. `inTxn` runs INSIDE the same short read
     * transaction as epoch/view revalidation, so no cross-connection commit
     * can land between revalidation and the persisted reads it validated.
     * `finish` (optional) runs OUTSIDE the transaction for phases that touch
     * the filesystem or processes (the literal floor) — its evidence binds to
     * the pinned domain digest, and the NEXT entry re-detects drift.
     *
     * Composer/adapter throws prefixed STORE_CORRUPT map to the typed
     * operational failure here — the single catch boundary. Anything else
     * stays loud: programming errors are not query results.
     */
    private async answer<T extends CoveredAnswer, S = QueryResult<T>>(
        inTxn: (entry: SessionEntry) => S,
        finish?: (staged: S, entry: SessionEntry) => QueryResult<T>,
    ): Promise<QueryResult<T>> {
        const refusal = this.lifecycleRefusal();
        if (refusal !== null) return refusal;
        const entry: SessionEntry = {
            address: this.address,
            basis: this.basis,
            cursors: this.cursors,
            domainFiles: this.domainFiles,
            memberByKey: this.memberByKey,
            toolkit: this.toolkit,
            storeKeyFor: (p) => this.storeKeyFor(p),
            languageOf: (storeKey) => getLangForFile(storeKey),
            queryDigest: (queryName, normalizedQuestion, limit) => queryDigestOf(queryName, normalizedQuestion, limit),
        };
        let staged: S | undefined;
        let changed = false;
        try {
            runTransaction(this.address.db, () => {
                changed = this.changedSincePin();
                if (changed) return;
                staged = inTxn(entry);
            });
        } catch (e) {
            const failure = typedStoreFailure(e);
            if (failure !== null) return failed(this.basis, failure);
            throw e;
        }
        if (changed || staged === undefined) {
            return failed(this.basis, {
                code: 'INPUT_CHANGED', retryable: true,
                detail: 'the fact store or source domain changed since this session pinned it',
                correction: 'reopen_session',
            });
        }
        const result = finish === undefined
            ? staged as unknown as QueryResult<T>
            : finish(staged, entry);
        if (result.status !== 'failed') this.slide();
        return result;
    }

    /**
     * Questions not yet composed return a typed refusal AFTER the full entry
     * protocol, so lease/epoch/close behavior is real for every query from
     * the first release of this file. Task 2.3 retires these one by one.
     */
    private notComposedYet<T extends CoveredAnswer>(): Promise<QueryResult<T>> {
        return this.answer<T>((entry) => ({
            status: 'unavailable',
            basis: entry.basis,
            reason: 'question_kind_unsupported',
            issues: ['semantic_pending'] as CoverageIssue[],
        }));
    }

    fileModel(p: string, q?: FileModelQuestion) {
        return this.answer<FileModel>((entry) => composeFileModel(entry, p, q));
    }
    locationAt(p: string, q: LocationQuestion) {
        return this.answer<LocationModel>((entry) => composeLocationModel(entry, p, q));
    }
    resolveAt(p: string, q: ResolveQuestion) { void p; void q; return this.notComposedYet<never>(); }
    queryOccurrences(q: OccurrenceQuestion) { void q; return this.notComposedYet<never>(); }
    traceRelations(q: RelationQuestion) { void q; return this.notComposedYet<never>(); }
    scopeModel(q: ScopeQuestion) {
        return this.answer<ScopeModel>((entry) => composeScopeModel(entry, q));
    }
    contextFor(q: ContextQuestion) { void q; return this.notComposedYet<never>(); }

    close(): void {
        this.state.closed = true;
    }
}

// ---------------------------------------------------------------------------
// openAstSession
// ---------------------------------------------------------------------------

function openFailure(
    failure: OperationalFailure,
    receipt?: { updated: string[]; unchanged: string[]; failedPath: string | null },
): OpenSessionResult {
    return {
        status: 'failed',
        failure,
        updated: receipt?.updated ?? [],
        unchanged: receipt?.unchanged ?? [],
        failedPath: receipt?.failedPath ?? null,
    };
}

export async function openAstSessionWithDeps(
    ctx: FsContext,
    request: OpenSessionRequest,
    deps: SessionDeps = {},
): Promise<OpenSessionResult> {
    const now = deps.now ?? Date.now;

    if (request.domain.kind === 'module') {
        return openFailure({
            code: 'INVALID_QUERY', retryable: false,
            detail: 'module domains require semantic profiles (Wave 4+); open a file, directory, or project domain',
            correction: 'narrow_scope',
        });
    }

    // Route the anchor through the ONE resolver. FUTURE_SCHEMA and corruption
    // surface as typed failures, never throws.
    let store: IntelligenceStore;
    const anchorAbs = path.resolve(request.anchor);
    // Realpath scope guard: the anchor must resolve inside the allowed roots.
    // A lexically-in-scope anchor that escapes via symlink is refused before any
    // store/index work. The lexical anchorAbs is kept for routing so a legitimate
    // symlinked allowed-root is not silently re-scoped to its realpath.
    try {
        await ctx.validatePath(request.anchor);
    } catch {
        return openFailure({
            code: 'INVALID_QUERY', retryable: false,
            detail: `anchor path resolves outside the allowed scope: ${request.anchor}`,
            correction: 'narrow_scope',
        });
    }
    try {
        store = getProjectContext(ctx).getIntelligenceStore(anchorAbs);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith('FUTURE_SCHEMA')) {
            return openFailure({
                code: 'FUTURE_SCHEMA', retryable: false, detail: message, correction: 'repair_store',
            });
        }
        return openFailure({
            code: 'STORE_CORRUPT', retryable: false, detail: message, correction: 'repair_store',
        });
    }
    const address = store.address;

    // Enumerate the complete requested domain.
    const enumerated = await enumerateDomain(ctx, address, request.domain, anchorAbs);
    if ('invalid' in enumerated) {
        return openFailure({
            code: 'INVALID_QUERY', retryable: false, detail: enumerated.invalid, correction: 'narrow_scope',
        });
    }
    const { members, capped, keyPredicate, incompleteWalk } = enumerated;

    // Disk freshness transition over every supported member.
    for (const member of members) {
        if (member.status !== 'present') continue;
        let outcome: IndexFileOutcome;
        try {
            outcome = await indexFileAt(address, member.absPath);
        } catch (e) {
            return openFailure({
                code: 'FRESHNESS_FAILED', retryable: true,
                detail: `indexing failed for ${member.storeKey}: ${e instanceof Error ? e.message : String(e)}`,
                correction: 'retry',
            }, { updated: [], unchanged: [], failedPath: member.storeKey });
        }
        if (outcome === 'purged_unreadable') member.status = 'unreadable';
        else if (outcome === 'purged_unindexable') member.status = 'unsupported';
        // 'indexed' | 'fresh' | 'too_large' remain present (too_large keeps
        // its versioned sentinel as the stored hash).
    }

    // Content phase: exact in-hand bytes for listed files, applied AFTER the
    // disk transition. Every content file must be a domain member.
    let contentDigest: string | null = null;
    let contentFileCount = 0;
    const contentByKey = new Map<string, string>();
    if (request.freshness.mode === 'content') {
        const byKey = new Map(members.map((m) => [m.storeKey, m]));
        const updated: string[] = [];
        const unchanged: string[] = [];
        const seen = new Set<string>();
        const contentKeys: { key: string; member: DomainMember; content: string }[] = [];
        for (const file of request.freshness.files) {
            const abs = path.isAbsolute(file.path) ? file.path : path.resolve(address.scopeRoot, file.path);
            const key = address.toStoreKey(abs);
            const member = key === null ? undefined : byKey.get(key);
            if (key === null || member === undefined) {
                return openFailure({
                    code: 'INVALID_QUERY', retryable: false,
                    detail: `content file is not part of the requested domain: ${file.path}`,
                    correction: 'narrow_scope',
                });
            }
            if (seen.has(key)) {
                return openFailure({
                    code: 'INVALID_QUERY', retryable: false,
                    detail: `duplicate content file in request: ${file.path}`,
                    correction: 'narrow_scope',
                });
            }
            seen.add(key);
            contentKeys.push({ key, member, content: file.content });
        }
        // Canonical store-key order: a partial commit is deterministic and the
        // updated/unchanged receipt names exactly the attempted prefix.
        contentKeys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (let i = 0; i < contentKeys.length; i++) {
            const entry = contentKeys[i];
            if (entry === undefined) continue;
            let reindexed: number;
            try {
                reindexed = await ensureFreshFromContentAt(address, entry.member.absPath, entry.content);
            } catch (e) {
                // Facts for the 1..i-1 files already committed and stay authoritative;
                // the failed file is named only in failedPath, unattempted files omitted.
                return openFailure({
                    code: 'FRESHNESS_FAILED', retryable: true,
                    detail: `content ingestion failed for ${entry.key}: ${e instanceof Error ? e.message : String(e)}`,
                    correction: 'retry',
                }, { updated, unchanged, failedPath: entry.key });
            }
            if (reindexed === 1) updated.push(entry.key);
            else unchanged.push(entry.key);
            contentByKey.set(entry.key, entry.content);
            if (entry.member.status === 'unreadable') entry.member.status = 'present';
        }
        contentFileCount = contentKeys.length;
        contentDigest = domainHash('polaris-content-domain@1', contentKeys
            .map((c) => `${c.key}\x1f${domainHash('polaris-content-file@1', [c.content])}`)
            .sort());
    }

    // Pin: one view read supplies present hashes for digest AND the
    // revalidation baseline; the epoch is read after all open-time writes.
    const viewPrefix = address.mode === 'global' ? `${address.scopeKey}/` : '';
    let presentView: string[] = [];
    let epoch: FactEpoch = { dataVersion: 0, commitGeneration: 0 };
    try {
        runTransaction(address.db, () => {
            presentView = readPresentView(address, viewPrefix, keyPredicate);
            epoch = getFactEpoch(address.db);
        });
    } catch (e) {
        const failure = typedStoreFailure(e);
        if (failure !== null) return openFailure(failure);
        throw e;
    }
    const hashByKey = new Map(presentView.map((line) => {
        const sep = line.indexOf('\x1f');
        return [line.slice(0, sep), line.slice(sep + 1)] as const;
    }));
    for (const member of members) {
        if (member.status === 'present') {
            const hash = hashByKey.get(member.storeKey);
            if (hash === undefined) {
                // A present classification with no stored row means the store
                // and walk disagree; surface it rather than fabricate a hash.
                member.status = 'unreadable';
            } else {
                member.hash = hash;
            }
        }
    }

    const digest = computeDomainDigest(members);
    const coverage: CoverageIssue[] = [];
    if (capped) coverage.push('incomplete_cap');
    if (incompleteWalk) coverage.push('incomplete_walk');
    if (address.mode === 'global') coverage.push('global_structural_only');
    if (store.issue !== null) coverage.push(store.issue);

    const openedAt = now();
    const basis: Omit<SessionBasis, 'expiresAt'> = {
        scopeKey: address.scopeKey,
        scopeMode: address.mode,
        evidenceCeiling: 'structural',
        sourceDomain: { digest, fileCount: members.length, contentDigest, contentFileCount },
        snapshot: null,
        coverage,
        openedAt,
        hardExpiresAt: openedAt + LEASE_HARD_CAP_MS,
    };

    const pinned: PinnedDomain = {
        digest, fileCount: members.length, presentView, keyPredicate, viewPrefix, epoch,
    };

    return {
        status: 'opened',
        session: new StructuralSession(address, pinned, basis, members.map((m) => {
            const content = contentByKey.get(m.storeKey);
            return {
                storeKey: m.storeKey,
                absPath: m.absPath,
                status: m.status,
                ...(content === undefined ? {} : { content }),
            };
        }), { now }),
    };
}
