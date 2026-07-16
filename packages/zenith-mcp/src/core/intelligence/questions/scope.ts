/**
 * POLARIS Task 2.3-B — the scopeModel composer.
 *
 * Pure module: no SQL, no fs, no process work, and no value import from
 * db-adapter (types only). Every persisted fact arrives through the
 * SessionEntry's bound toolkit, executing inside the entry transaction; every
 * projection is deterministic over those rows.
 *
 * The plan's question-contract row for `scopeModel`:
 *   "Keyset-paged directory/module/project files, groups, exact-or-lower-bound
 *    aggregates, and coverage over requested sections | One set-oriented scope
 *    query, never N fileModel calls".
 *
 * v4 answer shape (contract + frozen types):
 *  - The paged unit is the canonical, key-ordered list of scope GROUPS
 *    (directory rows for directory/project selectors; file-grain and module
 *    selectors are typed refusals — fileModel owns files, modules are v5+).
 *    Ordering is store-key/directory ascending — the exact
 *    order readV4DirectoryProjectAggregates emits — so a numeric-position
 *    cursor (mirroring composeFileModel) is stable under the pinned domain.
 *  - Aggregate counts come from ONE set-oriented read
 *    (toolkit.aggregates = readV4DirectoryProjectAggregates); relation frontier
 *    counts come from ONE set-oriented read
 *    (toolkit.edgeStats = readV4EdgeResolutionStats). No per-file bundle loop
 *    is ever issued for a directory/project scope — the plan forbids "N
 *    fileModel calls" by name.
 *
 * Section availability at v4 (honest, mirroring file.ts's V4_UNAVAILABLE
 * discipline — typed unavailable, never invented facts):
 *  - files / languages / declarations / references / relations / coverage are
 *    served: the ScopeGroup projection (fileCount / declarationCount /
 *    referenceCount / languages) is exactly what the directory/project
 *    aggregate read produces, and relation counts come from the edge stats.
 *  - modules / exports / signatures / diagnostics / configuration are v5+ and
 *    typed unavailable (question_kind_unsupported); bindings is v6 and typed
 *    unavailable (question_requires_binding) — same rows as fileModel.
 *  - scopes / imports / anchors / injections / structures ARE persisted at v4
 *    per file, but the frozen ScopeGroup projection carries no per-section
 *    count field and the toolkit exposes no set-oriented COUNT aggregate for
 *    them. Serving them would require either inventing a field or pulling every
 *    row across the scope to count it. Per the task's hard rule we STOP and
 *    report the missing aggregate rather than work around it with a per-file
 *    loop, and type these sections unavailable at v4. See the report's findings.
 *
 * Status discipline (per the 2.3-B correction to the file.ts precedent): the
 * answer status and every per-section status are COVERAGE-DERIVED ONLY. A
 * truncated page with clean coverage returns status 'complete' with
 * exhausted:false and a non-null next cursor. Paging progress lives entirely in
 * page.exhausted / page.next, never in a status field.
 */

import type {
    ContinuationCursor, CoverageIssue, FactCoverage, FactDomain, PageInfo,
    QueryResult, ScopeGroup, ScopeModel, ScopeQuestion, ScopeSectionResult,
    ScopeSelector, UnavailabilityReason,
} from '../types.js';
import type { SessionEntry } from '../session.js';
import { PROVISIONAL_LIMITS } from '../limits.js';
import { canonicalJsonStringify, coverageBuilder } from '../evidence.js';

// ---------------------------------------------------------------------------
// Section algebra
// ---------------------------------------------------------------------------

type ScopeSectionName = NonNullable<ScopeQuestion['sections']>[number];

/** Canonical section order (the ScopeQuestion.sections union order). */
export const SCOPE_SECTION_ORDER: readonly ScopeSectionName[] = [
    'files', 'languages', 'modules', 'declarations', 'references', 'scopes',
    'imports', 'exports', 'structures', 'signatures', 'anchors', 'injections',
    'diagnostics', 'configuration', 'relations', 'bindings', 'coverage',
];

const SECTION_DOMAIN: Readonly<Record<ScopeSectionName, FactDomain>> = {
    files: 'file',
    languages: 'file',
    modules: 'module',
    declarations: 'declaration',
    references: 'reference',
    scopes: 'scope',
    imports: 'import',
    exports: 'export',
    structures: 'structure',
    signatures: 'signature',
    anchors: 'anchor',
    injections: 'injection',
    diagnostics: 'diagnostic',
    configuration: 'configuration',
    relations: 'relation',
    bindings: 'binding',
    coverage: 'file',
};

/**
 * Sections not servable set-oriented at schema v4.
 *  - v5+ semantic families: modules/exports/signatures/diagnostics/configuration.
 *  - v6 binding family: bindings.
 *  - v4-persisted per-file families with NO set-oriented COUNT aggregate and no
 *    representable ScopeGroup field: scopes/imports/anchors/injections/structures
 *    (reported to the integration lead, never worked around per-file).
 */
const V4_UNAVAILABLE: Readonly<Partial<Record<ScopeSectionName, UnavailabilityReason>>> = {
    modules: 'question_kind_unsupported',
    exports: 'question_kind_unsupported',
    signatures: 'question_kind_unsupported',
    diagnostics: 'question_kind_unsupported',
    configuration: 'question_kind_unsupported',
    bindings: 'question_requires_binding',
    scopes: 'question_kind_unsupported',
    imports: 'question_kind_unsupported',
    anchors: 'question_kind_unsupported',
    injections: 'question_kind_unsupported',
    structures: 'question_kind_unsupported',
};

// ---------------------------------------------------------------------------
// Scope resolution → canonical group list + frontier counts
// ---------------------------------------------------------------------------

interface EdgeCounts {
    total: number;
    unresolved: number;
}

const ZERO_EDGES: EdgeCounts = { total: 0, unresolved: 0 };

interface ResolvedScope {
    groups: ScopeGroup[];
    normalized: ScopeSelector;
    edges: EdgeCounts;
}

/** Scope prefix for the whole session scope ('' project mode, `scopeKey/` global). */
function projectPrefixOf(entry: SessionEntry): string {
    return entry.basis.scopeMode === 'global' ? `${entry.basis.scopeKey}/` : '';
}

function edgeCountsFromPrefix(entry: SessionEntry, prefix: string): EdgeCounts {
    let total = 0;
    let unresolved = 0;
    for (const row of entry.toolkit.edgeStats(prefix)) {
        total += row.count;
        if (row.legacyStorageState === 'unresolved') unresolved += row.count;
    }
    return { total, unresolved };
}

/** V4ScopeAggregateRow is structurally a ScopeGroup; copy to a plain, frozen shape. */
function rowToGroup(row: {
    key: string; fileCount: number; declarationCount: number; referenceCount: number;
    languages: readonly { language: string; fileCount: number }[];
}): ScopeGroup {
    return {
        key: row.key,
        fileCount: row.fileCount,
        declarationCount: row.declarationCount,
        referenceCount: row.referenceCount,
        languages: row.languages.map((l) => ({ language: l.language, fileCount: l.fileCount })),
    };
}

/**
 * Resolve a selector to its canonical group list and frontier counts through
 * set-oriented reads only. `{ outside: true }` is a file selector whose path is
 * not a pinned member (→ path_outside_scope). A directory selector that
 * resolves to nothing returns empty groups (a factual empty, never an error).
 */
function resolveScope(
    entry: SessionEntry,
    scope: Exclude<ScopeSelector, { kind: 'module' } | { kind: 'file' }>,
    needRelations: boolean,
): ResolvedScope {
    const projectPrefix = projectPrefixOf(entry);

    if (scope.kind === 'project') {
        const aggregates = entry.toolkit.aggregates(projectPrefix);
        return {
            groups: aggregates.directories.map(rowToGroup),
            normalized: { kind: 'project' },
            edges: needRelations ? edgeCountsFromPrefix(entry, projectPrefix) : ZERO_EDGES,
        };
    }

    if (scope.kind === 'directory') {
        const dirKey = entry.storeKeyFor(scope.path);
        const normalized: ScopeSelector = {
            kind: 'directory',
            path: dirKey ?? scope.path,
            recursive: scope.recursive,
        };
        // A directory that escapes the scope resolves to nothing: factual empty.
        if (dirKey === null) return { groups: [], normalized, edges: ZERO_EDGES };
        const prefix = dirKey === '' ? projectPrefix : `${dirKey}/`;
        const aggregates = entry.toolkit.aggregates(prefix);
        const all = aggregates.directories.map(rowToGroup);
        // Recursive: every directory under the prefix. Non-recursive: only the
        // directory itself (files whose immediate parent is exactly dirKey).
        const groups = scope.recursive ? all : all.filter((g) => g.key === dirKey);
        return {
            groups,
            normalized,
            edges: needRelations ? edgeCountsFromPrefix(entry, prefix) : ZERO_EDGES,
        };
    }

    // Unreachable: project and directory are the only remaining arms.
    throw new Error(`STORE_CORRUPT: scopeModel reached an unmapped selector ${JSON.stringify(scope)}`);
}

// ---------------------------------------------------------------------------
// Aggregate totals over the selected group list
// ---------------------------------------------------------------------------

interface ScopeTotals {
    fileCount: number;
    declarationCount: number;
    referenceCount: number;
    distinctLanguages: number;
}

function sumTotals(groups: readonly ScopeGroup[]): ScopeTotals {
    let fileCount = 0;
    let declarationCount = 0;
    let referenceCount = 0;
    const languages = new Set<string>();
    for (const g of groups) {
        fileCount += g.fileCount;
        declarationCount += g.declarationCount;
        referenceCount += g.referenceCount;
        for (const l of g.languages) languages.add(l.language);
    }
    return { fileCount, declarationCount, referenceCount, distinctLanguages: languages.size };
}

/** The exact aggregate a served section reports as its total metric. */
function sectionMetric(
    section: ScopeSectionName,
    totals: ScopeTotals,
    edges: EdgeCounts,
): number {
    switch (section) {
        case 'declarations': return totals.declarationCount;
        case 'references': return totals.referenceCount;
        case 'languages': return totals.distinctLanguages;
        case 'relations': return edges.total;
        // files / coverage and any other served section report file coverage.
        default: return totals.fileCount;
    }
}

// ---------------------------------------------------------------------------
// scopeModel
// ---------------------------------------------------------------------------

export function composeScopeModel(
    entry: SessionEntry,
    q: ScopeQuestion,
): QueryResult<ScopeModel> {
    // Deliberate runtime widening (`as`): the frozen contract excludes
    // file-grain selectors at compile time, but untyped (JS) callers can
    // still pass one — they get the typed refusal below, never a shadow
    // capability that would freeze into the contract.
    const scope = q.scope as ScopeSelector;
    if (scope.kind === 'module' || scope.kind === 'file') {
        return {
            status: 'failed',
            basis: entry.basis,
            failure: {
                code: 'INVALID_QUERY',
                retryable: false,
                detail: scope.kind === 'module'
                    ? 'module scope selectors require semantic profiles (Wave 5+); '
                        + 'narrow to a directory or project scope'
                    : 'file-grain questions belong to fileModel; '
                        + 'scopeModel serves directory and project scopes',
                correction: 'narrow_scope',
            },
        };
    }

    const requested = q.sections === undefined ? SCOPE_SECTION_ORDER : q.sections;
    const ordered = SCOPE_SECTION_ORDER.filter((s) => requested.includes(s));
    const limit = Math.max(1, Math.min(
        q.page?.limit ?? PROVISIONAL_LIMITS.pageDefaults.scope,
        PROVISIONAL_LIMITS.pageMaxima.scopeGroups,
    ));
    // Edge stats are prefix reads and prefixes are inherently recursive: a
    // non-recursive directory's relation count cannot be answered without a
    // key-list edge aggregate the v4 read set does not have. Serving the
    // recursive number under a non-recursive selector would be fabrication —
    // that section arm is typed unavailable instead (known-issues R10).
    const relationsUnservable = scope.kind === 'directory' && !scope.recursive;
    const needRelations = ordered.includes('relations') && !relationsUnservable;

    const resolved = resolveScope(entry, scope, needRelations);
    const { groups, normalized, edges } = resolved;

    // A capped session domain makes every enumeration a lower bound.
    const capped = entry.basis.coverage.includes('incomplete_cap');
    const totalKind: PageInfo['total']['kind'] = capped ? 'lower_bound' : 'exact';

    const queryDigest = entry.queryDigest('scopeModel', { scope: normalized, sections: ordered }, limit);

    // Continuation: absolute position into the canonical group ordering,
    // exactly like composeFileModel. The ordering (aggregate directory key
    // ascending) is stable under the pinned source domain.
    let resumeAfter = -1;
    if (q.page?.after !== undefined) {
        const acceptance = entry.cursors.accept(q.page.after, queryDigest);
        if (!acceptance.ok) {
            return { status: 'failed', basis: entry.basis, failure: acceptance.failure };
        }
        const parsed = Number(JSON.parse(acceptance.lastCanonicalKey));
        if (!Number.isInteger(parsed) || parsed < 0) {
            return {
                status: 'failed',
                basis: entry.basis,
                failure: {
                    code: 'INVALID_QUERY',
                    retryable: false,
                    detail: 'continuation key does not address this question\u2019s canonical group sequence',
                    correction: 'retry',
                },
            };
        }
        resumeAfter = parsed;
    }

    // Page the group list by absolute position.
    const pagedGroups: ScopeGroup[] = [];
    let truncated = false;
    let lastEmittedPosition = resumeAfter;
    for (let position = 0; position < groups.length; position++) {
        if (position <= resumeAfter) continue;
        if (pagedGroups.length >= limit) { truncated = true; break; }
        const group = groups[position];
        if (group === undefined) continue; // unreachable under a dense array; satisfies noUncheckedIndexedAccess
        pagedGroups.push(group);
        lastEmittedPosition = position;
    }

    const totals = sumTotals(groups);

    // Coverage + issues (coverage-derived status, never paging-derived).
    const coverage = coverageBuilder();
    const issues = new Set<CoverageIssue>();
    if (capped) issues.add('incomplete_cap');
    if (needRelations && edges.unresolved > 0) issues.add('unresolved_frontier');
    for (const section of ordered) coverage.request(SECTION_DOMAIN[section]);

    const sections: ScopeSectionResult[] = ordered.map((section) => {
        const domain = SECTION_DOMAIN[section];
        const reason = V4_UNAVAILABLE[section];
        if (reason !== undefined) {
            coverage.unavailable(domain, reason);
            return { section, status: 'unavailable', reason };
        }
        if (section === 'relations' && relationsUnservable) {
            coverage.unavailable(domain, 'question_kind_unsupported');
            return { section, status: 'unavailable', reason: 'question_kind_unsupported' };
        }
        coverage.complete(domain);
        return {
            section,
            // Per-section status is coverage-derived: only a capped (lower-bound)
            // enumeration is 'partial'; truncation never makes a section partial.
            status: capped ? 'partial' : 'complete',
            groups: pagedGroups,
            total: { kind: totalKind, value: sectionMetric(section, totals, edges) },
        };
    });

    for (const issue of issues) coverage.issue(issue);
    const cov: FactCoverage = coverage.build();

    const next: ContinuationCursor | null = truncated
        ? entry.cursors.issue(queryDigest, canonicalJsonStringify(lastEmittedPosition))
        : null;
    const page: PageInfo = {
        returned: pagedGroups.length,
        total: { kind: totalKind, value: groups.length },
        exhausted: !truncated,
        next,
    };

    const model: ScopeModel = {
        scope,
        sections,
        page,
        coverage: cov,
    };
    return {
        // Status is derived from coverage ONLY: partial iff a domain is
        // unavailable or an issue was recorded. A clean but truncated page is
        // 'complete' (progress lives in page.exhausted / page.next).
        status: cov.unavailable.length > 0 || cov.issues.length > 0 ? 'partial' : 'complete',
        basis: entry.basis,
        data: model,
        issues: cov.issues,
    };
}
