/**
 * POLARIS Task 2.3 — the evidence lattice and canonical orders.
 *
 * Pure module: no SQL, no fs, no formatting. Composers use these helpers so
 * that two locked properties hold mechanically (plan §Task 2.4):
 *
 *   - every composed grade is <= its weakest input (basis conservation)
 *   - canonical orders never depend on row IDs or insertion order
 */

import type {
    CandidateBasis, CoverageIssue, EvidenceGrade, FactCoverage, FactDomain,
    LocatedSymbol, SourceRange, UnavailabilityReason,
} from './types.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Canonical JSON + domain-separated hashing (shared by session and composers)
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJsonStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    return '{' + entries.join(',') + '}';
}

/** Domain-separated, length-prefixed SHA-256 over UTF-8 parts. */
export function domainHash(domain: string, parts: readonly string[]): string {
    const h = crypto.createHash('sha256');
    const dom = Buffer.from(domain, 'utf8');
    h.update(String(dom.length) + ':');
    h.update(dom);
    for (const part of parts) {
        const buf = Buffer.from(part, 'utf8');
        h.update(String(buf.length) + ':');
        h.update(buf);
    }
    return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Handle keys (plan: domain-separated, length-prefixed, no SQLite row IDs)
// ---------------------------------------------------------------------------

/** Canonical range encoding for key material. */
export function rangeKey(range: SourceRange): string {
    return range.precision === 'byte'
        ? `b:${range.startByte}:${range.endByte}`
        : `l:${range.startLine}:${range.startColumn ?? -1}:${range.endLine}`;
}

export interface FactKeyInput {
    scopeKey: string;
    /** Scope-relative path — never absolute, never a SQLite id. */
    path: string;
    sourceHash: string;
    family: FactDomain;
    /** The exact persisted occurrence key within its family. */
    occurrenceKey: string;
    range: SourceRange;
    kind: string;
    name: string;
}

/** A fact handle's stable key: `fact@1` domain over the persisted identity. */
export function factKey(input: FactKeyInput): string {
    return domainHash('fact@1', [
        input.scopeKey, input.path, input.sourceHash, input.family,
        input.occurrenceKey, rangeKey(input.range), input.kind, input.name,
    ]);
}

export interface TextKeyInput {
    sourceDomainDigest: string;
    path: string;
    range: SourceRange;
    literal: string;
}

/** A text candidate's key: `text@1` over the exact match under the domain. */
export function textKey(input: TextKeyInput): string {
    return domainHash('text@1', [
        input.sourceDomainDigest, input.path, rangeKey(input.range), input.literal,
    ]);
}

// ---------------------------------------------------------------------------
// The grade lattice: text < structural < binding
// ---------------------------------------------------------------------------

const GRADE_RANK: Readonly<Record<EvidenceGrade, number>> = {
    text: 0,
    structural: 1,
    binding: 2,
};

export function gradeRank(grade: EvidenceGrade): number {
    return GRADE_RANK[grade];
}

/** True when `grade` is at most `ceiling` (never exceeds it). */
export function gradeAtMost(grade: EvidenceGrade, ceiling: EvidenceGrade): boolean {
    return GRADE_RANK[grade] <= GRADE_RANK[ceiling];
}

/**
 * The grade of a composition is the weakest of its inputs — evidence never
 * strengthens by aggregation. NonEmpty by construction: callers with zero
 * inputs have no composed fact to grade.
 */
export function weakestGrade(first: EvidenceGrade, ...rest: readonly EvidenceGrade[]): EvidenceGrade {
    let weakest = first;
    for (const grade of rest) {
        if (GRADE_RANK[grade] < GRADE_RANK[weakest]) weakest = grade;
    }
    return weakest;
}

/** The evidence grade a candidate basis is allowed to claim. */
export function gradeOfBasis(basis: CandidateBasis): EvidenceGrade {
    switch (basis) {
        case 'text_occurrence':
            return 'text';
        case 'exact_declaration':
        case 'parent_containment':
        case 'heuristic_name':
            return 'structural';
        // Every BindingBasis member proves a binding.
        case 'declaration_self':
        case 'lexical_scope':
        case 'explicit_import':
        case 'explicit_reexport':
        case 'qualified_namespace':
        case 'direct_member':
        case 'language_global':
            return 'binding';
    }
}

// ---------------------------------------------------------------------------
// Canonical orders (Decision 26)
// ---------------------------------------------------------------------------

function cmp(a: string | number, b: string | number): number {
    if (typeof a === 'number') {
        if (typeof b !== 'number') throw new Error('cmp: mixed string/number comparison');
        return a < b ? -1 : a > b ? 1 : 0;
    }
    if (typeof b !== 'string') throw new Error('cmp: mixed string/number comparison');
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Positions order by (startLine, startColumn|-1, endLine, kind, name). */
export interface PositionOrdered {
    startLine: number;
    startColumn: number | null;
    endLine: number;
    kind: string;
    name: string;
}

export function comparePositions(a: PositionOrdered, b: PositionOrdered): number {
    return cmp(a.startLine, b.startLine)
        || cmp(a.startColumn ?? -1, b.startColumn ?? -1)
        || cmp(a.endLine, b.endLine)
        || cmp(a.kind, b.kind)
        || cmp(a.name, b.name);
}

export interface CandidateOrderInput {
    symbol: LocatedSymbol;
    proofGrade: EvidenceGrade;
    qualifierVerified: boolean;
    sameFile: boolean;
    /** Line distance to the querying occurrence; null when unknowable. */
    nearDistance: number | null;
    line: number;
    column: number;
}

/**
 * Candidates order by (proofGrade desc, qualifierVerified desc, sameFile
 * desc, nearDistance asc null-last, path, line, column, handle.stableKey).
 */
export function compareCandidates(a: CandidateOrderInput, b: CandidateOrderInput): number {
    const grade = GRADE_RANK[b.proofGrade] - GRADE_RANK[a.proofGrade];
    if (grade !== 0) return grade;
    const qualifier = Number(b.qualifierVerified) - Number(a.qualifierVerified);
    if (qualifier !== 0) return qualifier;
    const sameFile = Number(b.sameFile) - Number(a.sameFile);
    if (sameFile !== 0) return sameFile;
    if (a.nearDistance !== b.nearDistance) {
        if (a.nearDistance === null) return 1;
        if (b.nearDistance === null) return -1;
        const near = cmp(a.nearDistance, b.nearDistance);
        if (near !== 0) return near;
    }
    return cmp(a.symbol.path, b.symbol.path)
        || cmp(a.line, b.line)
        || cmp(a.column, b.column)
        || cmp(a.symbol.handle.stableKey, b.symbol.handle.stableKey);
}

/** Relations order by (kind, sourceKey, targetKey). */
export function compareRelations(
    a: { kind: string; sourceKey: string; targetKey: string },
    b: { kind: string; sourceKey: string; targetKey: string },
): number {
    return cmp(a.kind, b.kind) || cmp(a.sourceKey, b.sourceKey) || cmp(a.targetKey, b.targetKey);
}

/** Coverage issues order by the closed enum's declaration order, then dedupe. */
const ISSUE_ORDER: readonly CoverageIssue[] = [
    'incomplete_cap', 'incomplete_walk', 'incomplete_facts', 'parse_tainted',
    'global_structural_only', 'legacy_global_scope_ambiguous',
    'unresolved_frontier', 'safety_cap_candidates', 'safety_cap_file_model',
    'safety_cap_scope_model', 'safety_cap_relations', 'safety_cap_context',
    'text_floor_partial', 'semantic_pending', 'semantic_unit_too_large',
    'source_file_too_large', 'corrupt_fact_repaired',
];
const ISSUE_RANK = new Map(ISSUE_ORDER.map((issue, i) => [issue, i]));

export function canonicalIssues(issues: Iterable<CoverageIssue>): CoverageIssue[] {
    return [...new Set(issues)].sort((a, b) =>
        (ISSUE_RANK.get(a) ?? ISSUE_ORDER.length) - (ISSUE_RANK.get(b) ?? ISSUE_ORDER.length));
}

// ---------------------------------------------------------------------------
// FactCoverage composition
// ---------------------------------------------------------------------------

export interface CoverageBuilder {
    request(domain: FactDomain): void;
    complete(domain: FactDomain): void;
    unavailable(domain: FactDomain, reason: UnavailabilityReason): void;
    taint(): void;
    issue(issue: CoverageIssue): void;
    build(): FactCoverage;
}

/**
 * Accumulates one answer's coverage. Every requested domain must end either
 * complete or unavailable — build() throws on a silently dropped domain,
 * because omission is not a state the public contract permits.
 */
export function coverageBuilder(): CoverageBuilder {
    const requested: FactDomain[] = [];
    const completeSet = new Set<FactDomain>();
    const unavailable = new Map<FactDomain, UnavailabilityReason>();
    const issues = new Set<CoverageIssue>();
    let tainted = false;
    return {
        request(domain) { if (!requested.includes(domain)) requested.push(domain); },
        complete(domain) { completeSet.add(domain); },
        unavailable(domain, reason) { unavailable.set(domain, reason); },
        taint() { tainted = true; },
        issue(issue) { issues.add(issue); },
        build() {
            for (const domain of requested) {
                if (!completeSet.has(domain) && !unavailable.has(domain)) {
                    throw new Error(`coverage dropped a requested domain silently: ${domain}`);
                }
            }
            return {
                requested: [...requested],
                complete: requested.filter((d) => completeSet.has(d) && !unavailable.has(d)),
                unavailable: requested
                    .filter((d) => unavailable.has(d))
                    .map((d) => {
                        const reason = unavailable.get(d);
                        return reason === undefined ? null : { domain: d, reason };
                    })
                    .filter((entry): entry is { domain: FactDomain; reason: UnavailabilityReason } => entry !== null),
                tainted,
                issues: canonicalIssues(issues),
            };
        },
    };
}
