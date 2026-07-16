/**
 * POLARIS Task 2.3 — `locationAt` question composer (schema v4).
 *
 * Pure module: no SQL, no fs, no connections. All persisted data arrives
 * through the session's QuestionToolkit inside the entry protocol's single
 * read transaction. Assembly is shared with `fileModel` (questions/file.ts)
 * so parent chains, handles, and fact projections are correct by
 * construction; this composer only decides intersection, ordering, gating,
 * and paging.
 *
 * Contract (plan §Question contracts): "A keyset page of every fact
 * intersecting a point/range plus innermost-first containment. Line/range
 * facts are returned with exactness disclosed; equal or line-only ties
 * remain ambiguous/partial."
 *
 * v4 honesty rules applied here:
 *  - Facts are line-precision (defs/scopes/anchors/injections span lines;
 *    references carry a start column). Exactness is disclosed per fact via
 *    `range.precision`; the composer never fabricates byte precision and
 *    never discards a line-precision fact it cannot column-test.
 *  - Column refinement applies only to point questions and only to
 *    references (name length in UTF-16 code units, plan amendment F2).
 *  - `kind:'byte'` positions are accepted-then-unavailable at v4 (the same
 *    typed pattern as regex): byte-exact facts arrive with Wave 3+.
 *  - `diagnostics` is a v5 domain: requested ⇒ typed unavailable.
 *
 * Include gating (payload semantics owned at Wave 2, frozen after):
 *  - 'enclosing'   ⇒ the innermost-first containment chain PLUS scope and
 *                    anchor facts — the containment picture at the location.
 *  - 'occurrences' ⇒ declaration/reference occurrence facts.
 *  - 'injections'  ⇒ injection facts.
 *  - 'diagnostics' ⇒ v4: coverage-unavailable, no facts.
 *  - 'relations'   ⇒ one trailing relation fact restricted to intersecting
 *                    endpoints (containment explicit + edge frontier).
 *  Import facts have no LocatedFact arm by frozen contract; an import at the
 *  location surfaces through its reference occurrence row instead.
 */

import type {
    ContinuationCursor,
    CoverageIssue,
    FactCoverage,
    FactDomain,
    LocatedFact,
    LocatedSymbol,
    LocationModel,
    LocationQuestion,
    PageInfo,
    QueryResult,
    SourcePosition,
    SourceRange,
} from '../types.js';
import { PROVISIONAL_LIMITS } from '../limits.js';
import { canonicalJsonStringify, coverageBuilder } from '../evidence.js';
import type { SessionEntry } from '../session.js';
import {
    anchorFactOf,
    assembleFile,
    containsRelationsOf,
    frontierOf,
    injectionFactOf,
    locatedSymbolOf,
    occurrenceFactOf,
    publicPathOf,
    scopeFactOf,
    storeCorrupt,
} from './file.js';
import type { AssembledSymbol, FileAssembly } from './file.js';

const INCLUDE_ORDER = [
    'enclosing', 'occurrences', 'diagnostics', 'injections', 'relations',
] as const;
type IncludeKind = (typeof INCLUDE_ORDER)[number];

const INCLUDE_DOMAINS: Readonly<Record<IncludeKind, readonly FactDomain[]>> = {
    enclosing: ['declaration', 'scope', 'anchor'],
    occurrences: ['declaration', 'reference'],
    diagnostics: ['diagnostic'],
    injections: ['injection'],
    relations: ['relation'],
};

/** Canonical cross-family order for positioned facts (pinned by tests). */
const FAMILY_RANK = { occurrence: 0, scope: 1, anchor: 2, injection: 3 } as const;

type NormalizedAt =
    | { kind: 'lines'; startLine: number; endLine: number; column: number | null }
    | { kind: 'byte_unsupported' }
    | { kind: 'invalid'; detail: string };

function normalizeAt(at: LocationQuestion['at']): NormalizedAt {
    const lineOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;
    if (typeof at !== 'object' || at === null) {
        return { kind: 'invalid', detail: 'at must be a SourcePosition or SourceRange' };
    }
    if ('kind' in at) {
        const pos = at as SourcePosition;
        if (pos.kind === 'byte') return { kind: 'byte_unsupported' };
        if (pos.kind === 'line_column') {
            if (!lineOk(pos.line) || !Number.isInteger(pos.column) || pos.column < 0) {
                return { kind: 'invalid', detail: 'line_column position needs line ≥ 1 and column ≥ 0' };
            }
            return { kind: 'lines', startLine: pos.line, endLine: pos.line, column: pos.column };
        }
        return { kind: 'invalid', detail: 'unknown SourcePosition kind' };
    }
    if ('precision' in at) {
        const range = at as SourceRange;
        if (!lineOk(range.startLine) || !lineOk(range.endLine) || range.endLine < range.startLine) {
            return { kind: 'invalid', detail: 'range needs 1 ≤ startLine ≤ endLine' };
        }
        // Ranges intersect at line granularity against v4 line-precision
        // facts; per-fact `range.precision` discloses the achievable
        // exactness ("line-only ties remain" — nothing is discarded).
        return { kind: 'lines', startLine: range.startLine, endLine: range.endLine, column: null };
    }
    return { kind: 'invalid', detail: 'at must be a SourcePosition or SourceRange' };
}

interface SequencedFact {
    line: number;
    column: number;
    rank: number;
    seq: number;
    item: LocatedFact;
}

function intersectsLines(start: number, end: number, qStart: number, qEnd: number): boolean {
    return start <= qEnd && end >= qStart;
}

/** A reference intersects a point-with-column across its name's UTF-16 span. */
function referenceHitsColumn(sym: AssembledSymbol, line: number, column: number): boolean {
    return sym.line === line && sym.column <= column && column < sym.column + sym.name.length;
}

export function composeLocationModel(
    entry: SessionEntry,
    questionPath: string,
    q: LocationQuestion,
): QueryResult<LocationModel> {
    const storeKey = entry.storeKeyFor(questionPath);
    const member = storeKey === null ? undefined : entry.memberByKey.get(storeKey);
    if (storeKey === null || member === undefined) {
        return { status: 'unavailable', basis: entry.basis, reason: 'path_outside_scope', issues: [] };
    }

    const at = normalizeAt(q.at);
    if (at.kind === 'invalid') {
        return {
            status: 'failed', basis: entry.basis,
            failure: {
                code: 'INVALID_QUERY', retryable: false,
                detail: at.detail, correction: 'supply_position',
            },
        };
    }
    if (at.kind === 'byte_unsupported') {
        // Accepted-then-unavailable, exactly like regex: byte positions are a
        // typed request v4 cannot serve (no byte-exact facts until Wave 3+).
        return { status: 'unavailable', basis: entry.basis, reason: 'question_kind_unsupported', issues: [] };
    }

    const requested: readonly IncludeKind[] = q.include ?? INCLUDE_ORDER;
    const include = INCLUDE_ORDER.filter((k) => requested.includes(k));
    const limit = Math.max(1, Math.min(
        q.page?.limit ?? PROVISIONAL_LIMITS.pageDefaults.fileModel,
        PROVISIONAL_LIMITS.pageMaxima.fileFacts,
    ));
    const queryDigest = entry.queryDigest('locationAt', {
        path: storeKey,
        at: { startLine: at.startLine, endLine: at.endLine, column: at.column },
        include,
    }, limit);
    const publicPath = publicPathOf(entry.address, storeKey);

    let resumeAfter = -1;
    if (q.page?.after !== undefined) {
        const acceptance = entry.cursors.accept(q.page.after, queryDigest);
        if (!acceptance.ok) {
            return { status: 'failed', basis: entry.basis, failure: acceptance.failure };
        }
        const parsed = Number(JSON.parse(acceptance.lastCanonicalKey));
        if (!Number.isInteger(parsed) || parsed < 0) {
            return {
                status: 'failed', basis: entry.basis,
                failure: {
                    code: 'INVALID_QUERY', retryable: false,
                    detail: 'continuation key does not address this question\u2019s canonical sequence',
                    correction: 'retry',
                },
            };
        }
        resumeAfter = parsed;
    }

    const coverage = coverageBuilder();
    const issues = new Set<CoverageIssue>();
    const domains: FactDomain[] = [];
    for (const k of include) {
        for (const d of INCLUDE_DOMAINS[k]) {
            if (!domains.includes(d)) domains.push(d);
        }
    }
    for (const d of domains) coverage.request(d);

    const settle = (unsupported: boolean): void => {
        for (const d of domains) {
            if (d === 'diagnostic') coverage.unavailable(d, 'question_kind_unsupported');
            else if (unsupported) coverage.unavailable(d, 'unsupported_language');
            else coverage.complete(d);
        }
    };

    const assembly: FileAssembly | null =
        member.status === 'present' ? assembleFile(entry, storeKey) : null;
    if (member.status === 'unsupported') {
        settle(true);
    } else if (assembly === null) {
        // unreadable, or present in the domain but absent from the store —
        // an honest empty under incomplete_facts, never fabricated certainty.
        issues.add('incomplete_facts');
        settle(false);
    } else {
        if (assembly.oversized) issues.add('source_file_too_large');
        settle(false);
    }

    // ---- containment chain (innermost-first) and intersecting facts -------
    const enclosing: LocatedSymbol[] = [];
    const positioned: SequencedFact[] = [];
    let relationFact: LocatedFact | null = null;
    let seq = 0;

    if (assembly !== null) {
        const spanningDecls = assembly.declarations.filter((s) =>
            intersectsLines(s.line, s.endLine, at.startLine, at.endLine));

        if (include.includes('enclosing')) {
            const containing = assembly.declarations
                .filter((s) => s.line <= at.startLine && s.endLine >= at.endLine)
                .sort((a, b) =>
                    b.line - a.line || a.endLine - b.endLine || b.column - a.column
                    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            for (const d of containing) {
                enclosing.push({ ...locatedSymbolOf(d, publicPath), candidateBasis: 'parent_containment' });
            }
            for (const row of assembly.scopes) {
                const fact = scopeFactOf(row, assembly);
                if (fact.range.precision !== 'line') storeCorrupt(`scope fact with non-line precision in ${storeKey}`);
                if (!intersectsLines(fact.range.startLine, fact.range.endLine, at.startLine, at.endLine)) continue;
                positioned.push({
                    line: fact.range.startLine, column: -1,
                    rank: FAMILY_RANK.scope, seq: seq++, item: { kind: 'scope', fact },
                });
            }
            for (const row of assembly.anchors) {
                const fact = anchorFactOf(row, assembly);
                if (!intersectsLines(fact.range.startLine, fact.range.endLine, at.startLine, at.endLine)) continue;
                positioned.push({
                    line: fact.range.startLine, column: -1,
                    rank: FAMILY_RANK.anchor, seq: seq++, item: { kind: 'anchor', fact },
                });
            }
        }

        if (include.includes('occurrences')) {
            for (const sym of spanningDecls) {
                positioned.push({
                    line: sym.line, column: sym.column,
                    rank: FAMILY_RANK.occurrence, seq: seq++,
                    item: { kind: 'occurrence', fact: occurrenceFactOf(sym, publicPath) },
                });
            }
            for (const sym of assembly.references) {
                const hit = at.column === null
                    ? intersectsLines(sym.line, sym.line, at.startLine, at.endLine)
                    : referenceHitsColumn(sym, at.startLine, at.column);
                if (!hit) continue;
                positioned.push({
                    line: sym.line, column: sym.column,
                    rank: FAMILY_RANK.occurrence, seq: seq++,
                    item: { kind: 'occurrence', fact: occurrenceFactOf(sym, publicPath) },
                });
            }
        }

        if (include.includes('injections')) {
            for (const row of assembly.injections) {
                const fact = injectionFactOf(row, assembly);
                if (!intersectsLines(fact.range.startLine, fact.range.endLine, at.startLine, at.endLine)) continue;
                positioned.push({
                    line: fact.range.startLine, column: -1,
                    rank: FAMILY_RANK.injection, seq: seq++, item: { kind: 'injection', fact },
                });
            }
        }

        if (include.includes('relations')) {
            const intersectingKeys = new Set(spanningDecls.map((s) => s.key));
            const explicit = containsRelationsOf(assembly).filter((rel) =>
                intersectingKeys.has(rel.source.stableKey) || intersectingKeys.has(rel.target.stableKey));
            const frontier = frontierOf(entry, assembly).filter((f) =>
                intersectingKeys.has(f.source.handle.stableKey));
            if (frontier.length > 0) issues.add('unresolved_frontier');
            if (explicit.length > 0 || frontier.length > 0) {
                relationFact = { kind: 'relation', fact: { explicit, frontier } };
            }
        }
    }

    positioned.sort((a, b) =>
        a.line - b.line || a.column - b.column || a.rank - b.rank || a.seq - b.seq);
    const sequence: LocatedFact[] = positioned.map((p) => p.item);
    if (relationFact !== null) sequence.push(relationFact); // always the final position

    // ---- keyset page over the canonical sequence ---------------------------
    const kept: LocatedFact[] = [];
    let lastEmittedPosition = resumeAfter;
    let truncated = false;
    for (let position = 0; position < sequence.length; position++) {
        if (position <= resumeAfter) continue;
        if (kept.length >= limit) { truncated = true; break; }
        const fact = sequence[position];
        if (fact === undefined) storeCorrupt(`locationAt sequence hole at ${position} in ${storeKey}`);
        kept.push(fact);
        lastEmittedPosition = position;
    }

    for (const issue of issues) coverage.issue(issue);
    const cov: FactCoverage = coverage.build();
    const next: ContinuationCursor | null = truncated
        ? entry.cursors.issue(queryDigest, canonicalJsonStringify(lastEmittedPosition))
        : null;
    const page: PageInfo = {
        returned: kept.length,
        total: { kind: 'exact', value: sequence.length },
        exhausted: !truncated,
        next,
    };

    const model: LocationModel = {
        path: publicPath,
        at: q.at,
        enclosing, // served whole on every page; only `facts` is paged
        facts: kept,
        page,
        coverage: cov,
    };
    return {
        // Plan payload rule: status derives from FactCoverage alone — never
        // from a non-exhausted page.
        status: issues.size > 0 || cov.unavailable.length > 0 ? 'partial' : 'complete',
        basis: entry.basis,
        data: model,
        issues: cov.issues,
    };
}
