/**
 * POLARIS Task 2.3 — the fileModel composer and the shared fact assembly.
 *
 * Pure module: no SQL, no fs, no process work. Every persisted fact arrives
 * through the SessionEntry's bound toolkit (executing inside the entry
 * transaction); every projection is deterministic over those rows.
 *
 * This file also owns the row -> public-fact assembly the sibling composers
 * import: handles, ranges, occurrence facts, parent chains, contains
 * relations, and edge frontiers. One assembly, seven projections — the fact
 * ledger's lossless-projection column points here.
 *
 * Corruption discipline: v4 writers never persist NULL positions or invalid
 * JSON. Encountering them is store corruption, thrown with the STORE_CORRUPT
 * prefix and mapped to the typed operational failure at the session boundary
 * (the single catch site).
 */

import type {
    AnchorFact, ContinuationCursor, CoverageIssue, FactCoverage, FactDomain,
    FileIdentityFacts, FileModel, FileModelQuestion, FileSection,
    FileSectionResult, ImportBindingFact, ImportFact, InjectionFact,
    LocatedSymbol, OccurrenceFact, PageInfo, ProvenRelation, QueryResult,
    RelationFrontier, ScopeFact, SourceRange, StructureFact, StructuralProofStep,
    SymbolHandle, UnavailabilityReason,
} from '../types.js';
import type { SessionEntry } from '../session.js';
import type {
    V4AnchorFactRow, V4CompleteFileFactBundle, V4EdgeFactRow, V4ImportBindingFactRow,
    V4ImportFactRow, V4InjectionFactRow, V4ParentAncestryRow, V4ScopeFactRow,
    V4StructureFactRow, V4SymbolFactRow,
} from '../../db-adapter.js';
import { LOCKED_BOUNDS, PROVISIONAL_LIMITS } from '../limits.js';
import {
    canonicalJsonStringify, coverageBuilder, factKey,
} from '../evidence.js';

// ---------------------------------------------------------------------------
// Corruption + parsing discipline
// ---------------------------------------------------------------------------

export function storeCorrupt(detail: string): never {
    throw new Error(`STORE_CORRUPT: ${detail}`);
}

function requirePresent<T>(value: T | null | undefined, detail: string): T {
    if (value === null || value === undefined) storeCorrupt(detail);
    return value;
}

/** NULL/empty is a legitimate absent list; malformed text is corruption. */
export function parseJsonStringArray(text: string | null, context: string): string[] {
    if (text === null || text === '') return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        storeCorrupt(`${context}: unparseable JSON list`);
    }
    if (!Array.isArray(parsed)) storeCorrupt(`${context}: JSON list is not an array`);
    return parsed.map((v) => typeof v === 'string' ? v : JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Handles and ranges
// ---------------------------------------------------------------------------

export function factHandleOf(key: string): Extract<SymbolHandle, { kind: 'fact' }> {
    return { kind: 'fact', stableKey: key, factKey: key, snapshot: null, profile: null };
}

export function lineRangeOf(startLine: number, startColumn: number | null, endLine: number): SourceRange {
    return { precision: 'line', startLine, startColumn, endLine };
}

// ---------------------------------------------------------------------------
// The shared per-file assembly
// ---------------------------------------------------------------------------

export interface AssembledSymbol {
    row: V4SymbolFactRow;
    role: 'declaration' | 'reference';
    name: string;
    kind: string;
    line: number;
    endLine: number;
    column: number;
    key: string;
    handle: SymbolHandle;
    /** Dotted definition chain for declarations; null for references. */
    qualifiedName: string | null;
    /** Innermost-first parent fact keys (persisted parent IDs only). */
    parentChain: string[];
    owner: { stableKey: string; name: string; kind: string } | null;
    ownerSource: LocatedSymbol['parentChainSource'];
}

export interface FileAssembly {
    storeKey: string;
    sourceHash: string;
    oversized: boolean;
    lastIndexedAt: number;
    symbols: AssembledSymbol[];
    declarations: AssembledSymbol[];
    references: AssembledSymbol[];
    byInternalId: Map<number, AssembledSymbol>;
    scopes: V4ScopeFactRow[];
    imports: V4ImportFactRow[];
    importBindings: V4ImportBindingFactRow[];
    anchors: V4AnchorFactRow[];
    injections: V4InjectionFactRow[];
    structures: V4StructureFactRow[];
    edges: V4EdgeFactRow[];
}

export const TOO_LARGE_HASH_PREFIX = 'toolarge@';

function assembleSymbol(
    scopeKey: string,
    storeKey: string,
    sourceHash: string,
    row: V4SymbolFactRow,
): Omit<AssembledSymbol, 'qualifiedName' | 'parentChain' | 'owner' | 'ownerSource'> {
    const role = requirePresent(row.role, `symbol ${row.internalId} in ${storeKey} has no role`);
    const name = requirePresent(row.name, `symbol ${row.internalId} in ${storeKey} has no name`);
    const kind = requirePresent(row.kind, `symbol ${row.internalId} in ${storeKey} has no kind`);
    const line = requirePresent(row.line, `symbol ${name} in ${storeKey} has no line`);
    const endLine = row.endLine ?? line;
    const column = requirePresent(row.column, `symbol ${name}:${line} in ${storeKey} has no column`);
    const key = factKey({
        scopeKey,
        path: storeKey,
        sourceHash,
        family: role,
        occurrenceKey: `${role}:${name}:${kind}:${line}:${column}`,
        range: lineRangeOf(line, column, endLine),
        kind,
        name,
    });
    return { row, role, name, kind, line, endLine, column, key, handle: factHandleOf(key) };
}

/**
 * Assemble every persisted fact family for one pinned store key from a
 * single bundle read. Deterministic: rows arrive in the adapter's canonical
 * order and all derived structures preserve it.
 */
export function assembleFile(entry: SessionEntry, storeKey: string): FileAssembly | null {
    const bundle: V4CompleteFileFactBundle = entry.toolkit.bundle([storeKey]);
    const fileRow = bundle.files[0];
    if (fileRow === undefined || !fileRow.present) return null;
    const sourceHash = requirePresent(fileRow.hash, `present file ${storeKey} has no stored hash`);
    const scopeKey = entry.basis.scopeKey;

    const partial = bundle.symbols.map((row) => assembleSymbol(scopeKey, storeKey, sourceHash, row));
    const byInternalId = new Map(partial.map((s) => [s.row.internalId, s]));

    const symbols: AssembledSymbol[] = partial.map((s) => {
        // Persisted parent IDs only; cycles cannot outrun the locked depth.
        const chain: typeof partial = [];
        const seen = new Set<number>([s.row.internalId]);
        let cursor = s.row.parentInternalId;
        while (cursor !== null && chain.length < LOCKED_BOUNDS.ancestryDepth) {
            if (seen.has(cursor)) storeCorrupt(`parent cycle at symbol ${cursor} in ${storeKey}`);
            seen.add(cursor);
            const parent = byInternalId.get(cursor);
            if (parent === undefined) break; // parent outside this file's rows
            chain.push(parent);
            cursor = parent.row.parentInternalId;
        }
        const qualifiedName = s.role === 'declaration'
            ? [...chain.map((p) => p.name).reverse(), s.name].join('.')
            : null;
        const nearest = chain[0];
        return {
            ...s,
            qualifiedName,
            parentChain: chain.map((p) => p.key),
            owner: nearest === undefined
                ? null
                : { stableKey: nearest.key, name: nearest.name, kind: nearest.kind },
            ownerSource: nearest === undefined ? 'none' : 'parent_symbol_id',
        };
    });
    const assembledById = new Map(symbols.map((s) => [s.row.internalId, s]));

    return {
        storeKey,
        sourceHash,
        oversized: sourceHash.startsWith(TOO_LARGE_HASH_PREFIX),
        lastIndexedAt: fileRow.lastIndexed ?? 0,
        symbols,
        declarations: symbols.filter((s) => s.role === 'declaration'),
        references: symbols.filter((s) => s.role === 'reference'),
        byInternalId: assembledById,
        scopes: bundle.scopes,
        imports: bundle.imports,
        importBindings: bundle.importBindings,
        anchors: bundle.anchors,
        injections: bundle.injections,
        structures: bundle.structures,
        edges: bundle.edges,
    };
}

// ---------------------------------------------------------------------------
// Public-fact projections (shared by every composer)
// ---------------------------------------------------------------------------

export function occurrenceFactOf(sym: AssembledSymbol, storeKey: string): OccurrenceFact {
    return {
        handle: sym.handle,
        path: storeKey,
        role: sym.role,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        namespace: 'unknown', // v4 persists no namespace facts; never guessed
        range: lineRangeOf(sym.line, sym.column, sym.endLine),
        owner: sym.owner,
        ownerSource: sym.ownerSource,
        evidence: 'structural',
        tainted: false,
    };
}

export function locatedSymbolOf(sym: AssembledSymbol, storeKey: string): LocatedSymbol {
    return {
        handle: sym.handle,
        path: storeKey,
        name: sym.name,
        qualifiedName: sym.qualifiedName ?? sym.name,
        kind: sym.kind,
        range: lineRangeOf(sym.line, sym.column, sym.endLine),
        candidateBasis: 'exact_declaration',
        parentChain: sym.parentChain,
        parentChainSource: sym.ownerSource,
    };
}

export function scopeFactOf(row: V4ScopeFactRow, assembly: FileAssembly): ScopeFact {
    const startLine = requirePresent(row.startLine, `scope ${row.internalId} has no start line`);
    const endLine = row.endLine ?? startLine;
    const owner = assembly.byInternalId.get(row.symbolInternalId);
    return {
        kind: row.scopeKind ?? 'unknown',
        range: lineRangeOf(startLine, null, endLine),
        ownerStableKey: owner?.key ?? null,
    };
}

export function importFactsOf(assembly: FileAssembly): ImportFact[] {
    // Bindings attach by exact module source, then by line containment when
    // one module is imported through several statements. Deterministic:
    // bindings and imports both arrive in canonical position order.
    const claimed = new Set<V4ImportBindingFactRow>();
    return assembly.imports.map((imp) => {
        const module = imp.module ?? '';
        const startLine = imp.startLine ?? imp.line ?? 1;
        const endLine = imp.endLine ?? startLine;
        const bindings: ImportBindingFact[] = assembly.importBindings
            .filter((b) => !claimed.has(b) && b.source === module
                && b.line >= startLine && b.line <= endLine)
            .map((b) => {
                claimed.add(b);
                return {
                    importedName: b.importedName ?? b.localName,
                    localName: b.localName,
                    bindingKind: b.importKind,
                    typeOnly: b.isTypeOnly,
                    range: lineRangeOf(b.line, b.column, b.line),
                };
            });
        return {
            module,
            importedNames: parseJsonStringArray(imp.importedNamesJson, `imports ${module} in ${assembly.storeKey}`),
            range: lineRangeOf(startLine, null, endLine),
            bindings,
        };
    });
}

export function anchorFactOf(row: V4AnchorFactRow, assembly: FileAssembly): AnchorFact {
    const line = requirePresent(row.line, `anchor ${row.internalId} in ${assembly.storeKey} has no line`);
    return {
        kind: row.kind ?? 'unknown',
        priority: null, // v4 persists no anchor priority
        range: lineRangeOf(line, null, row.endLine ?? line),
    };
}

export function injectionFactOf(row: V4InjectionFactRow, assembly: FileAssembly): InjectionFact {
    const startLine = requirePresent(row.startLine, `injection ${row.internalId} in ${assembly.storeKey} has no start line`);
    return {
        language: row.injectedLanguage ?? 'unknown',
        range: lineRangeOf(startLine, null, row.endLine ?? startLine),
    };
}

export function structureFactOf(row: V4StructureFactRow, assembly: FileAssembly): StructureFact | null {
    const owner = assembly.byInternalId.get(row.symbolInternalId);
    if (owner === undefined) return null; // structure of a purged symbol row
    return {
        ownerStableKey: owner.key,
        parameters: parseJsonStringArray(row.paramsJson, `structure of ${owner.name} in ${assembly.storeKey}`),
        modifiers: parseJsonStringArray(row.modifiersJson, `structure of ${owner.name} in ${assembly.storeKey}`),
        declaredReturnType: row.returnText,
        extendsNames: [], // v4 persists no extends facts; v5 fills this
    };
}

/** v4's provable relations: containment from persisted parent IDs. */
export function containsRelationsOf(assembly: FileAssembly): ProvenRelation[] {
    const relations: ProvenRelation[] = [];
    for (const sym of assembly.declarations) {
        if (sym.owner === null) continue;
        const step: StructuralProofStep = {
            kind: 'containment',
            from: sym.owner.stableKey,
            to: sym.key,
            factKey: sym.key,
        };
        relations.push({
            kind: 'contains',
            source: factHandleOf(sym.owner.stableKey),
            target: factHandleOf(sym.key),
            grade: 'structural',
            proof: [step],
        });
    }
    return relations;
}

/**
 * Every persisted name edge surfaces as uncertainty. Legacy heuristic target
 * IDs are candidates, never matches; cross-file targets are located through
 * one batched ancestry read (depth-0 rows are the targets themselves).
 */
export function frontierOf(entry: SessionEntry, assembly: FileAssembly): RelationFrontier[] {
    const targetIds = [...new Set(
        assembly.edges
            .map((e) => e.legacyHeuristicTargetInternalId)
            .filter((id): id is number => id !== null),
    )];
    const targetRows = targetIds.length === 0 ? [] : entry.toolkit.ancestry(targetIds);
    const targetsBySeed = new Map<number, V4ParentAncestryRow[]>();
    for (const row of targetRows) {
        const rows = targetsBySeed.get(row.seedInternalId);
        if (rows === undefined) targetsBySeed.set(row.seedInternalId, [row]);
        else rows.push(row);
    }

    const locateTarget = (id: number): LocatedSymbol | null => {
        const rows = targetsBySeed.get(id);
        const self = rows?.find((r) => r.depth === 0);
        if (rows === undefined || self === undefined) return null; // target purged since edge write
        const name = self.name ?? 'unknown';
        const line = self.line ?? 1;
        const column = self.column;
        const chain = rows
            .filter((r) => r.depth > 0)
            .sort((a, b) => a.depth - b.depth);
        const key = factKey({
            scopeKey: entry.basis.scopeKey,
            path: self.filePath ?? 'unknown',
            sourceHash: 'legacy', // heuristic candidates are not proof-bearing
            family: 'declaration',
            occurrenceKey: `declaration:${name}:${self.kind ?? 'unknown'}:${line}:${column ?? -1}`,
            range: lineRangeOf(line, column, self.endLine ?? line),
            kind: self.kind ?? 'unknown',
            name,
        });
        return {
            handle: factHandleOf(key),
            path: self.filePath ?? 'unknown',
            name,
            qualifiedName: [...chain.map((r) => r.name ?? 'unknown').reverse(), name].join('.'),
            kind: self.kind ?? 'unknown',
            range: lineRangeOf(line, column, self.endLine ?? line),
            candidateBasis: 'heuristic_name',
            parentChain: [],
            parentChainSource: chain.length > 0 ? 'parent_symbol_id' : 'none',
        };
    };

    // Group edges by (source container, referenced name, kind) preserving
    // canonical source order; count duplicates instead of dropping them.
    const groups = new Map<string, { source: AssembledSymbol; referencedName: string;
        referenceKind: string; count: number; targetIds: Set<number> }>();
    for (const edge of assembly.edges) {
        const source = assembly.byInternalId.get(edge.containerInternalId);
        if (source === undefined) continue; // container purged mid-history
        const referencedName = edge.referencedName ?? '';
        const groupKey = `${source.row.internalId}\u001f${referencedName}\u001f${edge.referenceKind}`;
        const group = groups.get(groupKey);
        if (group === undefined) {
            groups.set(groupKey, {
                source, referencedName, referenceKind: edge.referenceKind, count: 1,
                targetIds: new Set(edge.legacyHeuristicTargetInternalId === null
                    ? [] : [edge.legacyHeuristicTargetInternalId]),
            });
        } else {
            group.count += 1;
            if (edge.legacyHeuristicTargetInternalId !== null) {
                group.targetIds.add(edge.legacyHeuristicTargetInternalId);
            }
        }
    }

    return [...groups.values()].map((g) => {
        const candidates = [...g.targetIds]
            .map(locateTarget)
            .filter((c): c is LocatedSymbol => c !== null);
        return {
            source: locatedSymbolOf(g.source, assembly.storeKey),
            referencedName: g.referencedName,
            referenceKind: g.referenceKind,
            count: g.count,
            candidates,
            reason: candidates.length > 0 ? 'legacy_heuristic' as const : 'name_only' as const,
        };
    });
}

// ---------------------------------------------------------------------------
// fileModel
// ---------------------------------------------------------------------------

export const FILE_SECTION_ORDER: readonly FileSection[] = [
    'identity', 'declarations', 'references', 'scopes', 'imports', 'exports',
    'structures', 'signatures', 'anchors', 'injections', 'diagnostics',
    'module', 'configuration', 'relations', 'bindings', 'coverage',
];

const SECTION_DOMAIN: Readonly<Record<FileSection, FactDomain>> = {
    identity: 'file',
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
    module: 'module',
    configuration: 'configuration',
    relations: 'relation',
    bindings: 'binding',
    coverage: 'file',
};

/** Sections whose fact families do not exist at schema v4. */
const V4_UNAVAILABLE: Readonly<Partial<Record<FileSection, UnavailabilityReason>>> = {
    exports: 'question_kind_unsupported',
    signatures: 'question_kind_unsupported',
    diagnostics: 'question_kind_unsupported',
    module: 'question_kind_unsupported',
    configuration: 'question_kind_unsupported',
    bindings: 'question_requires_binding',
};

interface BuiltSection {
    result: FileSectionResult;
    /** Facts countable against the page budget (meta sections cost 0). */
    factCount: number;
}

export function composeFileModel(
    entry: SessionEntry,
    questionPath: string,
    q: FileModelQuestion | undefined,
): QueryResult<FileModel> {
    const storeKey = entry.storeKeyFor(questionPath);
    const member = storeKey === null ? undefined : entry.memberByKey.get(storeKey);
    if (storeKey === null || member === undefined) {
        return {
            status: 'unavailable',
            basis: entry.basis,
            reason: 'path_outside_scope',
            issues: [],
        };
    }

    const requested = q?.sections === undefined ? FILE_SECTION_ORDER : q.sections;
    const ordered = FILE_SECTION_ORDER.filter((s) => requested.includes(s));
    const limit = Math.max(1, Math.min(
        q?.page?.limit ?? PROVISIONAL_LIMITS.pageDefaults.fileModel,
        PROVISIONAL_LIMITS.pageMaxima.fileFacts,
    ));
    const queryDigest = entry.queryDigest('fileModel', { path: storeKey, sections: ordered }, limit);

    // Continuation: position into the canonical (section, fact) sequence.
    let resumeAfter = -1;
    if (q?.page?.after !== undefined) {
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
    for (const section of ordered) coverage.request(SECTION_DOMAIN[section]);

    // Non-present members answer honestly without fabricating certainty:
    // unsupported files get typed unavailable sections; unreadable files get
    // empty facts under an incomplete_facts issue (we know nothing and say so).
    const assembly = member.status === 'present' ? assembleFile(entry, storeKey) : null;

    const sections: BuiltSection[] = [];
    const push = (result: FileSectionResult, factCount: number): void => {
        sections.push({ result, factCount });
    };

    for (const section of ordered) {
        const domain = SECTION_DOMAIN[section];
        const v4Reason = V4_UNAVAILABLE[section];
        if (v4Reason !== undefined) {
            coverage.unavailable(domain, v4Reason);
            push({ section, status: 'unavailable', reason: v4Reason }, 0);
            continue;
        }
        if (member.status === 'unsupported') {
            coverage.unavailable(domain, 'unsupported_language');
            push({ section, status: 'unavailable', reason: 'unsupported_language' }, 0);
            continue;
        }
        if (assembly === null) {
            // unreadable, or present in the domain but absent from the store
            issues.add('incomplete_facts');
            coverage.complete(domain);
            switch (section) {
                case 'identity':
                    push({
                        section: 'identity', status: 'partial',
                        facts: {
                            path: storeKey,
                            language: entry.languageOf(storeKey),
                            sourceHash: '',
                            oversized: false,
                            lastIndexedAt: 0,
                        },
                    }, 1);
                    break;
                case 'relations':
                    push({ section: 'relations', status: 'partial', facts: { explicit: [], frontier: [] } }, 0);
                    break;
                case 'coverage':
                    break; // emitted last from the builder
                default:
                    push({ section, status: 'partial', facts: [] } as FileSectionResult, 0);
            }
            continue;
        }

        coverage.complete(domain);
        if (assembly.oversized) issues.add('source_file_too_large');
        switch (section) {
            case 'identity': {
                const facts: FileIdentityFacts = {
                    path: storeKey,
                    language: entry.languageOf(storeKey),
                    sourceHash: assembly.sourceHash,
                    oversized: assembly.oversized,
                    lastIndexedAt: assembly.lastIndexedAt,
                };
                push({ section, status: 'complete', facts }, 1);
                break;
            }
            case 'declarations': {
                const facts = assembly.declarations.map((s) => occurrenceFactOf(s, storeKey));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'references': {
                const facts = assembly.references.map((s) => occurrenceFactOf(s, storeKey));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'scopes': {
                const facts = assembly.scopes.map((row) => scopeFactOf(row, assembly));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'imports': {
                const facts = importFactsOf(assembly);
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'structures': {
                const facts = assembly.structures
                    .map((row) => structureFactOf(row, assembly))
                    .filter((f): f is StructureFact => f !== null);
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'anchors': {
                const facts = assembly.anchors.map((row) => anchorFactOf(row, assembly));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'injections': {
                const facts = assembly.injections.map((row) => injectionFactOf(row, assembly));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'relations': {
                const explicit = containsRelationsOf(assembly);
                const frontier = frontierOf(entry, assembly);
                if (frontier.length > 0) issues.add('unresolved_frontier');
                push({
                    section, status: 'complete',
                    facts: { explicit, frontier },
                }, explicit.length + frontier.length);
                break;
            }
            case 'coverage':
                break; // emitted last from the builder
            default:
                storeCorrupt(`fileModel reached an unmapped section ${section}`);
        }
    }

    // Page over the canonical fact sequence: array-shaped sections only join
    // the position stream (object-shaped sections — relations — are served
    // whole on every page and counted in totals but never split). Resume is
    // by absolute position, stable under the pinned domain digest.
    let consumed = 0;
    let position = 0;
    let lastEmittedPosition = resumeAfter;
    let truncated = false;
    const paged: FileSectionResult[] = [];
    for (const built of sections) {
        const r = built.result;
        if (r.status === 'unavailable' || !Array.isArray((r as { facts?: unknown }).facts)) {
            paged.push(r);
            continue;
        }
        const facts = (r as { facts: readonly unknown[] }).facts;
        const kept: unknown[] = [];
        let dropped = false;
        for (const fact of facts) {
            const factPosition = position;
            position += 1;
            if (factPosition <= resumeAfter) continue;       // before the cursor
            if (consumed >= limit) { dropped = true; truncated = true; continue; }
            kept.push(fact);
            consumed += 1;
            lastEmittedPosition = factPosition;
        }
        const status = dropped || (resumeAfter >= 0 && kept.length < facts.length)
            ? 'partial' : r.status;
        paged.push({ ...r, status, facts: kept } as FileSectionResult);
    }

    const totalFacts = sections.reduce((sum, s) => sum + s.factCount, 0);
    for (const issue of issues) coverage.issue(issue);
    const cov: FactCoverage = coverage.build();
    if (ordered.includes('coverage')) {
        paged.push({ section: 'coverage', status: 'complete', facts: cov });
    }

    const next: ContinuationCursor | null = truncated
        ? entry.cursors.issue(queryDigest, canonicalJsonStringify(lastEmittedPosition))
        : null;
    const page: PageInfo = {
        returned: consumed,
        total: { kind: 'exact', value: totalFacts },
        exhausted: !truncated,
        next,
    };

    const model: FileModel = {
        path: storeKey,
        sections: paged,
        page,
        coverage: cov,
    };
    return {
        status: truncated || issues.size > 0 || cov.unavailable.length > 0 ? 'partial' : 'complete',
        basis: entry.basis,
        data: model,
        issues: cov.issues,
    };
}
