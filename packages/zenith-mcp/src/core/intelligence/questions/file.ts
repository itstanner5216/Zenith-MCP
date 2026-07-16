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
    LocatedSymbol, NonEmpty, OccurrenceFact, PageInfo, ProvenRelation, QueryResult,
    RelationFrontier, ScopeFact, ScopeMemberFact, SourceRange, StructureFact,
    StructuralProofStep, SymbolHandle, UnavailabilityReason,
} from '../types.js';
import type { SessionEntry } from '../session.js';
import type {
    V4AnchorFactRow, V4CompleteFileFactBundle, V4EdgeFactRow, V4ImportBindingFactRow,
    V4ImportFactRow, V4InjectionFactRow, V4ParentAncestryRow, V4ScopeFactRow,
    V4StructureFactRow, V4SymbolFactRow,
} from '../../db-adapter.js';
import { LOCKED_BOUNDS, PROVISIONAL_LIMITS } from '../limits.js';
import {
    canonicalJsonStringify, compareCandidates, coverageBuilder, factKey,
} from '../evidence.js';

// ---------------------------------------------------------------------------
// Corruption + parsing discipline
// ---------------------------------------------------------------------------

export function storeCorrupt(detail: string): never {
    throw new Error(`STORE_CORRUPT: ${detail}`);
}

/** Decode an internal store key to the allowed-root-relative public path (A5). */
export function publicPathOf(address: { fromStoreKey(storeKey: string): string | null }, storeKey: string): string {
    // A non-decodable key on a public path is store corruption, never a silent
    // re-leak of the internal key (fail loud per the typed-failure discipline).
    const publicPath = address.fromStoreKey(storeKey);
    if (publicPath === null) storeCorrupt(`store key does not decode to a public path`);
    return publicPath;
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
    return parsed.map((v) => {
        if (typeof v !== 'string') storeCorrupt(`${context}: JSON list member is not a string`);
        return v;
    });
}

/** Parse a persisted [{name,line,column}] scope-member list into faithful
 * facts. NULL/empty is a legitimate absent list; malformed text is corruption. */
export function parseScopeMembers(text: string | null, context: string): ScopeMemberFact[] {
    if (text === null || text === '') return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        storeCorrupt(`${context}: unparseable JSON member list`);
    }
    if (!Array.isArray(parsed)) storeCorrupt(`${context}: JSON member list is not an array`);
    return parsed.map((entry) => {
        if (entry === null || typeof entry !== 'object') {
            storeCorrupt(`${context}: scope member is not an object`);
        }
        const record = entry as { name?: unknown; line?: unknown; column?: unknown };
        const name = typeof record.name === 'string'
            ? record.name : storeCorrupt(`${context}: scope member has no name`);
        const line = typeof record.line === 'number'
            ? record.line : storeCorrupt(`${context}: scope member ${name} has no line`);
        const column = typeof record.column === 'number' ? record.column : null;
        return { name, range: lineRangeOf(line, column, line) };
    });
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
        // A14: a depth-capped or missing-parent walk (cursor !== null at exit)
        // cannot assert a complete qualified name — claim it only at the root.
        const ancestryComplete = cursor === null;
        const qualifiedName = s.role === 'declaration' && ancestryComplete
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

export function occurrenceFactOf(sym: AssembledSymbol, publicPath: string): OccurrenceFact {
    return {
        handle: sym.handle,
        path: publicPath,
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
        visibility: sym.row.visibility,
    };
}

export function locatedSymbolOf(sym: AssembledSymbol, publicPath: string): LocatedSymbol {
    return {
        handle: sym.handle,
        path: publicPath,
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
        parameters: parseScopeMembers(row.parametersJson, `scope ${row.internalId} params in ${assembly.storeKey}`),
        locals: parseScopeMembers(row.localsJson, `scope ${row.internalId} locals in ${assembly.storeKey}`),
    };
}

export function importFactsOf(assembly: FileAssembly): ImportFact[] {
    // Bindings attach by exact module source, then by line containment when
    // one module is imported through several statements. Deterministic:
    // bindings and imports both arrive in canonical position order.
    const claimed = new Set<V4ImportBindingFactRow>();
    const bindingFactOf = (b: V4ImportBindingFactRow): ImportBindingFact => ({
        importedName: b.importedName ?? b.localName,
        localName: b.localName,
        bindingKind: b.importKind,
        typeOnly: b.isTypeOnly,
        range: lineRangeOf(b.line, b.column, b.line),
    });
    const statements: ImportFact[] = assembly.imports.map((imp) => {
        const module = imp.module ?? '';
        const startLine = imp.startLine ?? imp.line ?? 1;
        const endLine = imp.endLine ?? startLine;
        const bindings: ImportBindingFact[] = assembly.importBindings
            .filter((b) => !claimed.has(b) && b.source === module
                && b.line >= startLine && b.line <= endLine)
            .map((b) => {
                claimed.add(b);
                return bindingFactOf(b);
            });
        return {
            origin: 'statement',
            module,
            importedNames: parseJsonStringArray(imp.importedNamesJson, `imports ${module} in ${assembly.storeKey}`),
            range: lineRangeOf(startLine, null, endLine),
            bindings,
        };
    });
    // Bindings matching no statement span are surfaced faithfully, grouped by
    // source in canonical order, rather than silently dropped (plan
    // §Authoritative fact ledger; import_binding is fileModel.imports[].bindings).
    const bindingOnly = new Map<string, V4ImportBindingFactRow[]>();
    for (const b of assembly.importBindings) {
        if (claimed.has(b)) continue;
        const rows = bindingOnly.get(b.source);
        if (rows === undefined) bindingOnly.set(b.source, [b]);
        else rows.push(b);
    }
    const bindingGroups: ImportFact[] = [...bindingOnly.entries()].map(([source, rows]) => {
        let startLine = rows[0]?.line ?? 1;
        let endLine = startLine;
        for (const b of rows) {
            if (b.line < startLine) startLine = b.line;
            if (b.line > endLine) endLine = b.line;
        }
        return {
            origin: 'binding_only',
            module: source,
            importedNames: [],
            range: lineRangeOf(startLine, null, endLine),
            bindings: rows.map(bindingFactOf),
        };
    });
    return [...statements, ...bindingGroups];
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
        hostLanguage: row.hostLanguage,
        range: lineRangeOf(startLine, null, row.endLine ?? startLine),
        // Faithful exact bytes when both persisted; never invented from lines.
        byteRange: row.startByte !== null && row.endByte !== null
            ? { startByte: row.startByte, endByte: row.endByte }
            : null,
    };
}

/** Orphan structures (owner symbol row absent) are surfaced with a null owner
 * key rather than silently dropped — plan §Authoritative fact ledger. */
export function structureFactOf(row: V4StructureFactRow, assembly: FileAssembly): StructureFact {
    const owner = assembly.byInternalId.get(row.symbolInternalId);
    const label = owner?.name ?? row.name ?? `symbol#${row.symbolInternalId}`;
    return {
        ownerStableKey: owner?.key ?? null,
        parameters: parseJsonStringArray(row.paramsJson, `structure of ${label} in ${assembly.storeKey}`),
        modifiers: parseJsonStringArray(row.modifiersJson, `structure of ${label} in ${assembly.storeKey}`),
        declaredReturnType: row.returnText,
        decorators: parseJsonStringArray(row.decoratorsJson, `structure of ${label} in ${assembly.storeKey}`),
        generics: row.genericsText,
        parentKind: row.parentKind,
        parentName: row.parentName,
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
        // A candidate handle must be the target's REAL persisted fact key —
        // same inputs assembleSymbol would use — never a fabricated hash/role.
        // A row missing any identity input is not a resolvable fact.
        const keyOf = (row: V4ParentAncestryRow): string | null => {
            if (row.hash === null || row.role === null || row.filePath === null
                || row.name === null || row.kind === null
                || row.line === null || row.column === null) {
                return null;
            }
            return factKey({
                scopeKey: entry.basis.scopeKey,
                path: row.filePath,
                sourceHash: row.hash,
                family: row.role,
                occurrenceKey: `${row.role}:${row.name}:${row.kind}:${row.line}:${row.column}`,
                range: lineRangeOf(row.line, row.column, row.endLine ?? row.line),
                kind: row.kind,
                name: row.name,
            });
        };
        const key = keyOf(self);
        if (key === null || self.name === null || self.kind === null
            || self.line === null || self.filePath === null) {
            return null;
        }
        const chain = rows
            .filter((r) => r.depth > 0)
            .sort((a, b) => a.depth - b.depth);
        // Computed ancestors: real persisted parent fact keys, innermost-first.
        // (res-5 A15: keys stay RAW store-key identity — byte-identical to
        // assembleSymbol minting; res-2 A5 decode applies to PUBLIC fields only.)
        const parentChain: string[] = [];
        for (const ancestor of chain) {
            const ancestorKey = keyOf(ancestor);
            if (ancestorKey !== null) parentChain.push(ancestorKey);
        }
        return {
            handle: factHandleOf(key),
            // N6 closure (A5×A15): the public candidate path decodes the
            // store key; hard-fails STORE_CORRUPT rather than re-leaking.
            path: publicPathOf(entry.address, self.filePath),
            name: self.name,
            // N11 (pending owner): the candidate type's qualifiedName is
            // non-nullable, so a truncated walk still joins here — applying
            // A14's claim-strip at this site needs a one-field type amendment.
            qualifiedName: [...chain.map((r) => r.name ?? 'unknown').reverse(), self.name].join('.'),
            kind: self.kind,
            range: lineRangeOf(self.line, self.column, self.endLine ?? self.line),
            candidateBasis: 'heuristic_name',
            parentChain,
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
            .filter((c): c is LocatedSymbol => c !== null)
            // Canonical candidate order (plan Decision 26) via the shared
            // engine. Heuristic candidates share proofGrade/qualifier/distance,
            // so the effective order is (sameFile desc, path, line, column,
            // handle.stableKey) — deterministic, never insertion order.
            .sort((a, b) => compareCandidates(
                {
                    symbol: a, proofGrade: 'text', qualifierVerified: false,
                    sameFile: a.path === assembly.storeKey, nearDistance: null,
                    line: a.range.startLine, column: a.range.startColumn ?? 0,
                },
                {
                    symbol: b, proofGrade: 'text', qualifierVerified: false,
                    sameFile: b.path === assembly.storeKey, nearDistance: null,
                    line: b.range.startLine, column: b.range.startColumn ?? 0,
                },
            ));
        return {
            source: locatedSymbolOf(g.source, publicPathOf(entry.address, assembly.storeKey)),
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

const SECTION_DOMAINS: Readonly<Record<FileSection, NonEmpty<FactDomain>>> = {
    identity: ['file'],
    declarations: ['declaration'],
    references: ['reference'],
    scopes: ['scope'],
    imports: ['import', 'import_binding'],
    exports: ['export'],
    structures: ['structure'],
    signatures: ['signature'],
    anchors: ['anchor'],
    injections: ['injection'],
    diagnostics: ['diagnostic'],
    module: ['module'],
    configuration: ['configuration'],
    relations: ['relation'],
    bindings: ['binding'],
    coverage: ['file'],
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
    const publicPath = publicPathOf(entry.address, storeKey);

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
    for (const section of ordered) {
        for (const domain of SECTION_DOMAINS[section]) coverage.request(domain);
    }

    // Non-present members answer honestly without fabricating certainty:
    // unsupported files get typed unavailable sections; unreadable files get
    // empty facts under an incomplete_facts issue (we know nothing and say so).
    const assembly = member.status === 'present' ? assembleFile(entry, storeKey) : null;
    // A14: a declaration whose parent walk truncated cannot state a qualified
    // name (null); surface that as an incomplete-facts caveat on the answer.
    if (assembly !== null && assembly.declarations.some((d) => d.qualifiedName === null)) {
        issues.add('incomplete_facts');
    }

    const sections: BuiltSection[] = [];
    const push = (result: FileSectionResult, factCount: number): void => {
        sections.push({ result, factCount });
    };

    for (const section of ordered) {
        const domains = SECTION_DOMAINS[section];
        const v4Reason = V4_UNAVAILABLE[section];
        if (v4Reason !== undefined) {
            for (const domain of domains) coverage.unavailable(domain, v4Reason);
            push({ section, status: 'unavailable', reason: v4Reason }, 0);
            continue;
        }
        if (member.status === 'unsupported') {
            for (const domain of domains) coverage.unavailable(domain, 'unsupported_language');
            push({ section, status: 'unavailable', reason: 'unsupported_language' }, 0);
            continue;
        }
        if (assembly === null) {
            // A8 (N7 Option A): present in the domain but absent/unreadable in
            // the store — no facts exist, so every requested domain is
            // unavailable, never falsely complete (also removes the raw
            // storeKey identity fallback that leaked here pre-merge).
            for (const domain of domains) coverage.unavailable(domain, 'source_unreadable');
            if (section !== 'coverage') {
                push({ section, status: 'unavailable', reason: 'source_unreadable' } as FileSectionResult, 0);
            }
            continue;
        }

        // A8 (N7 Option A): an oversized source preserves stale prior rows;
        // withhold parse-dependent content as unavailable instead of projecting
        // it complete. Identity (path/language/hash) is still known and honest.
        if (assembly.oversized && section !== 'identity' && section !== 'coverage') {
            for (const domain of domains) coverage.unavailable(domain, 'source_file_too_large');
            push({ section, status: 'unavailable', reason: 'source_file_too_large' } as FileSectionResult, 0);
            continue;
        }
        for (const domain of domains) coverage.complete(domain);
        if (assembly.oversized) issues.add('source_file_too_large');
        switch (section) {
            case 'identity': {
                const facts: FileIdentityFacts = {
                    path: publicPath,
                    language: entry.languageOf(storeKey),
                    sourceHash: assembly.sourceHash,
                    oversized: assembly.oversized,
                };
                push({ section, status: 'complete', facts }, 1);
                break;
            }
            case 'declarations': {
                const facts = assembly.declarations.map((s) => occurrenceFactOf(s, publicPath));
                push({ section, status: 'complete', facts }, facts.length);
                break;
            }
            case 'references': {
                const facts = assembly.references.map((s) => occurrenceFactOf(s, publicPath));
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
                    .map((row) => structureFactOf(row, assembly));
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

    // Page over the canonical fact sequence. Every enumerable fact occupies
    // one stable cursor position: array-shaped sections contribute one position
    // per element; object-shaped sections (identity, relations) contribute
    // exactly one position and are emitted WHOLE on that single page — never
    // replayed (plan Decision 24; mirrors locationAt's one-position relation
    // fact). On any other page the object section is present but empty. An
    // emitted object section adds its full factCount to `consumed`, so
    // `returned` reconciles with `total`. Resume is by absolute position,
    // stable under the pinned domain digest.
    let consumed = 0;
    let position = 0;
    let lastEmittedPosition = resumeAfter;
    let truncated = false;
    const paged: FileSectionResult[] = [];
    for (const built of sections) {
        const r = built.result;
        if (r.status === 'unavailable') {
            paged.push(r);                              // typed-unavailable: not a position
            continue;
        }
        const facts = (r as { facts?: unknown }).facts;
        if (Array.isArray(facts)) {
            const kept: unknown[] = [];
            for (const fact of facts) {
                const factPosition = position;
                position += 1;
                if (factPosition <= resumeAfter) continue;       // before the cursor
                if (consumed >= limit) { truncated = true; continue; }
                kept.push(fact);
                consumed += 1;
                lastEmittedPosition = factPosition;
            }
            // Plan payload rule (§Question contracts): status is coverage-derived
            // only — paging progress lives exclusively in `page.exhausted`/`next`,
            // so a page-cut section keeps its coverage status with facts elided.
            paged.push({ ...r, facts: kept } as FileSectionResult);
            continue;
        }
        // Object-shaped enumerable section: one atomic cursor position.
        const objectPosition = position;
        position += 1;
        let emitWhole = false;
        if (objectPosition <= resumeAfter) {
            // already emitted on an earlier page → present but empty
        } else if (consumed >= limit) {
            truncated = true;                           // deferred to a later page
        } else {
            emitWhole = true;
        }
        if (emitWhole) {
            consumed += built.factCount;                // reconciles returned with total
            lastEmittedPosition = objectPosition;
            paged.push(r);                              // whole, exactly once
        } else if (r.section === 'relations') {
            paged.push({ ...r, facts: { explicit: [], frontier: [] } });
        } else if (r.section === 'identity') {
            paged.push({ ...r, facts: null });          // "not on this page", never unavailable
        } else {
            storeCorrupt(`fileModel object-shaped section ${r.section} has no empty projection`);
        }
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
        path: publicPath,
        sections: paged,
        page,
        coverage: cov,
    };
    return {
        // Plan payload rule: never infer `partial` from a non-exhausted page —
        // status derives from FactCoverage alone (issues + unavailable domains).
        status: issues.size > 0 || cov.unavailable.length > 0 ? 'partial' : 'complete',
        basis: entry.basis,
        data: model,
        issues: cov.issues,
    };
}
