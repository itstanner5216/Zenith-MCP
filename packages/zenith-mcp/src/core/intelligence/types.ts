/**
 * POLARIS Task 2.1 contract freeze from the Public contracts section,
 * the RelationAnswer ProvenRelation/RelationFrontier block, and the
 * Two-stage edit advisory section of AST_INTELLIGENCE_SYNTHESIS.md.
 *
 * These public types are re-exported only by ast-intelligence.ts during
 * Task 2.1 integration.
 */

export type EvidenceGrade = 'text' | 'structural' | 'binding';

export type SemanticNamespace =
    | 'value' | 'type' | 'module' | 'package' | 'label' | 'macro' | 'unknown';

export type SourcePosition =
    | { kind: 'byte'; byte: number }
    | { kind: 'line_column'; line: number; column: number };

export interface ExactSourceRange {
    precision: 'byte';
    startByte: number;
    endByte: number; // half-open
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export type SourceRange = ExactSourceRange | {
    precision: 'line';
    startLine: number;
    startColumn: number | null;
    endLine: number; // inclusive
};

export type BindingBasis =
    | 'declaration_self'
    | 'lexical_scope'
    | 'explicit_import'
    | 'explicit_reexport'
    | 'qualified_namespace'
    | 'direct_member'
    | 'language_global';

export type CandidateBasis =
    | BindingBasis
    | 'exact_declaration'
    | 'parent_containment'
    | 'heuristic_name'
    | 'text_occurrence';

export interface BindingProofStep {
    kind: 'declaration' | 'scope' | 'module' | 'import' | 'export'
        | 'reexport' | 'member' | 'prelude';
    from: string;    // stable handle/module/scope key
    to: string;      // stable handle/module/scope key
    factKey: string; // stable persisted fact key
}

export type NonEmpty<T> = readonly [T, ...T[]];

export interface SnapshotIdentity {
    scopeKey: string;
    snapshotKey: string;
    engineVersion: number;
    profileSetHash: string;
}

export type SymbolHandle =
    | { kind: 'semantic'; stableKey: string; semanticKey: string;
        snapshot: SnapshotIdentity; profile: { id: string; version: number } }
    | { kind: 'fact'; stableKey: string; factKey: string;
        snapshot: null; profile: null }
    | { kind: 'text'; stableKey: string; textKey: string;
        snapshot: null; profile: null };

export interface LocatedSymbol {
    handle: SymbolHandle;
    path: string;                      // scope-relative, never absolute and never a SQLite id
    name: string;
    qualifiedName: string;
    kind: string;
    range: SourceRange;
    candidateBasis: CandidateBasis;
    parentChain: readonly string[];    // stable fact/semantic keys, never DB IDs
    parentChainSource: 'parent_symbol_id' | 'exact_scope' | 'line_fallback' | 'none';
}

export type ProvableSymbolHandle = Exclude<SymbolHandle, { kind: 'text' }>;
export type ResolvedLocatedSymbol = LocatedSymbol & { handle: ProvableSymbolHandle };

export type ResolutionAnswer =
    | {
        status: 'resolved';
        target: ResolvedLocatedSymbol;
        basis: BindingBasis;
        proof: NonEmpty<BindingProofStep>;
        candidates: readonly [];
        resolvedThrough: number;
        stoppedAt: null;
      }
    | {
        status: 'ambiguous';
        target: null;
        basis: null;
        proof: readonly BindingProofStep[];
        candidates: NonEmpty<LocatedSymbol>;
        resolvedThrough: number;
        stoppedAt: number | null;
      }
    | {
        status: 'unresolved';
        target: null;
        basis: null;
        proof: readonly BindingProofStep[];
        candidates: readonly LocatedSymbol[];
        reason: 'not_declared' | 'not_visible' | 'module_not_found'
            | 'namespace_mismatch' | 'incomplete_facts' | 'parse_tainted';
        resolvedThrough: number;
        stoppedAt: number | null;
      }
    | {
        status: 'external';
        target: null;
        basis: null;
        proof: readonly BindingProofStep[];
        candidates: readonly [];
        reason: 'external_module' | 'external_prelude' | 'outside_workspace';
        resolvedThrough: number;
        stoppedAt: number | null;
      }
    | {
        status: 'unsupported';
        target: null;
        basis: null;
        proof: readonly [];
        candidates: readonly LocatedSymbol[];
        reason: 'unsupported_language' | 'unsupported_construct'
            | 'requires_type_information' | 'global_structural_only';
        resolvedThrough: number;
        stoppedAt: number | null;
      };

export type CoverageIssue =
    | 'incomplete_cap'
    | 'incomplete_walk'
    | 'incomplete_facts'
    | 'parse_tainted'
    | 'global_structural_only'
    | 'legacy_global_scope_ambiguous'
    | 'unresolved_frontier'
    | 'safety_cap_candidates'
    | 'safety_cap_file_model'
    | 'safety_cap_scope_model'
    | 'safety_cap_relations'
    | 'safety_cap_context'
    | 'text_floor_partial'
    | 'semantic_pending'
    | 'semantic_unit_too_large'
    | 'source_file_too_large'
    | 'corrupt_fact_repaired';

export interface SessionBasis {
    scopeKey: string;
    scopeMode: 'project' | 'global';
    evidenceCeiling: EvidenceGrade;
    sourceDomain: {
        digest: string;
        fileCount: number;
        contentDigest: string | null;
        contentFileCount: number;
    };
    snapshot: SnapshotIdentity | null;
    coverage: readonly CoverageIssue[];
    openedAt: number;
    expiresAt: number;
    hardExpiresAt: number;
}

export type UnavailabilityReason =
    | 'path_outside_scope'
    | 'unsupported_language'
    | 'question_requires_binding'
    | 'question_requires_position'
    | 'regex_unsupported'
    | 'question_kind_unsupported';

export type OperationalFailureCode =
    | 'FUTURE_SCHEMA'
    | 'STORE_CORRUPT'
    | 'FRESHNESS_FAILED'
    | 'INPUT_CHANGED'
    | 'SESSION_EXPIRED'
    | 'SESSION_CLOSED'
    | 'CANCELLED'
    | 'INVALID_QUERY';

export interface CoveredAnswer {
    coverage: FactCoverage;
}

export interface OperationalFailure {
    code: OperationalFailureCode;
    retryable: boolean;
    detail: string;
    correction: 'reopen_session' | 'register_project' | 'narrow_scope'
        | 'supply_position' | 'retry' | 'repair_store';
}

export type QueryResult<T extends CoveredAnswer> =
    | { status: 'complete' | 'partial'; basis: SessionBasis; data: T; issues: readonly CoverageIssue[] }
    | { status: 'unavailable'; basis: SessionBasis; reason: UnavailabilityReason; issues: readonly CoverageIssue[] }
    | { status: 'failed'; basis: SessionBasis | null; failure: OperationalFailure };

declare const continuationCursorBrand: unique symbol;
export type ContinuationCursor = string & {
    readonly [continuationCursorBrand]: true;
};

export interface PageRequest {
    limit?: number;
    after?: ContinuationCursor;
}

export interface PageInfo {
    returned: number;
    total: { kind: 'exact'; value: number } | { kind: 'lower_bound'; value: number };
    exhausted: boolean;
    next: ContinuationCursor | null;
}

export type FactDomain =
    | 'file' | 'declaration' | 'reference' | 'scope' | 'import'
    | 'import_binding' | 'export' | 'structure' | 'signature'
    | 'anchor' | 'injection' | 'diagnostic' | 'module'
    | 'configuration' | 'relation' | 'binding';

export type FileSection =
    | 'identity' | 'declarations' | 'references' | 'scopes' | 'imports'
    | 'exports' | 'structures' | 'signatures' | 'anchors' | 'injections' | 'diagnostics'
    | 'module' | 'configuration' | 'relations' | 'bindings' | 'coverage';

export interface FileModelQuestion {
    sections?: NonEmpty<FileSection>; // omitted means every section
    page?: PageRequest;               // default 500, max settled in Wave 7
}

export interface LocationQuestion {
    at: SourcePosition | SourceRange;
    include?: NonEmpty<'enclosing' | 'occurrences' | 'diagnostics' | 'injections' | 'relations'>;
    page?: PageRequest;
}

export interface ResolveQuestion {
    occurrence: { referenceKey: string } | { at: SourcePosition };
    candidatePage?: PageRequest;
}

export type ScopeSelector =
    | { kind: 'file'; path: string }
    | { kind: 'directory'; path: string; recursive: boolean }
    | { kind: 'module'; moduleKey: string }
    | { kind: 'project' };

export type NamePredicate =
    | { mode: 'exact'; value: string }
    | { mode: 'prefix'; value: string }
    | { mode: 'regex'; pattern: string; flags: '' | 'i' };

export interface DeclaredStructurePredicate {
    parentKinds?: NonEmpty<string>;
    modifiersAll?: NonEmpty<string>;
    parameterNamesAll?: NonEmpty<string>;
    declaredReturnType?: { mode: 'exact' | 'prefix'; value: string };
}

export interface OccurrenceQuestion {
    scope: ScopeSelector;
    role: 'declaration' | 'reference' | 'import' | 'export' | 'any';
    name?: NamePredicate;
    qualifiedName?: string;
    moduleSpecifier?: NamePredicate;
    kinds?: NonEmpty<string>;
    namespaces?: NonEmpty<SemanticNamespace>;
    ownerStableKey?: string;
    structure?: DeclaredStructurePredicate;
    tainted?: boolean;
    visibility?: NonEmpty<'local' | 'module' | 'package' | 'public' | 'unknown'>;
    resolution?: NonEmpty<'resolved' | 'ambiguous' | 'unresolved' | 'external' | 'unsupported'>;
    page?: PageRequest; // default 200, max settled in Wave 7
}

export interface ScopeQuestion {
    scope: Exclude<ScopeSelector, { kind: 'file' }>;
    sections?: NonEmpty<'files' | 'languages' | 'modules' | 'declarations'
        | 'references' | 'scopes' | 'imports' | 'exports' | 'structures'
        | 'signatures' | 'anchors' | 'injections' | 'diagnostics'
        | 'configuration' | 'relations' | 'bindings' | 'coverage'>;
    page?: PageRequest; // default 200, max settled in Wave 7
}

export type RelationKind =
    | 'contains' | 'calls' | 'imports' | 'exports' | 'reexports'
    | 'extends' | 'implements' | 'aliases';

export interface RelationQuestion {
    start: { handle: SymbolHandle } | { path: string; at: SourcePosition };
    direction: 'incoming' | 'outgoing' | 'both';
    kinds?: NonEmpty<RelationKind>;
    depth?: 1 | 2 | 3 | 4 | 5;
    includeFrontier?: boolean; // default true
    page?: PageRequest;
}

export type ContextReason =
    | 'exact_occurrence' | 'declaration_header' | 'declaration_body'
    | 'enclosing_scope' | 'import_proof' | 'export_proof'
    | 'anchor' | 'diagnostic' | 'direct_relation_endpoint';

export interface ContextQuestion {
    anchor: { handle: SymbolHandle } | { path: string; at: SourcePosition | SourceRange };
    reasons?: NonEmpty<ContextReason>; // omitted means every factually available reason
    page?: PageRequest;
}

export type SessionFreshness =
    | { mode: 'disk' }
    | { mode: 'content'; files: readonly { path: string; content: string }[] };

export interface OpenSessionRequest {
    anchor: string;
    domain: ScopeSelector;
    freshness: SessionFreshness;
}

export interface FactCoverage {
    requested: readonly FactDomain[];
    complete: readonly FactDomain[];
    unavailable: readonly { domain: FactDomain; reason: UnavailabilityReason }[];
    tainted: boolean;
    issues: readonly CoverageIssue[];
}

/**
 * PROVISIONAL pending Task 2.1 integration review.
 * Structural analogue of BindingProofStep required by ProvenRelation.
 */
export interface StructuralProofStep {
    kind: 'containment' | 'declaration';
    from: string;    // stable handle/module/scope key
    to: string;      // stable handle/module/scope key
    factKey: string; // stable persisted fact key
}

export interface ProvenRelation {
    kind: 'contains' | 'calls' | 'imports' | 'exports' | 'reexports'
        | 'extends' | 'implements' | 'aliases';
    source: ProvableSymbolHandle;
    target: ProvableSymbolHandle;
    grade: 'structural' | 'binding';
    proof: NonEmpty<BindingProofStep | StructuralProofStep>;
}

export interface RelationFrontier {
    source: LocatedSymbol;
    referencedName: string;
    referenceKind: string;
    count: number;
    candidates: readonly LocatedSymbol[];
    reason: 'name_only' | 'legacy_heuristic' | 'ambiguous'
        | 'unresolved' | 'unsupported' | 'parse_tainted';
}

export interface AppliedByteEdit {
    beforeStart: number;
    beforeEnd: number;  // half-open
    afterStart: number;
    afterEnd: number;   // half-open
}

export interface EditBaselineInput {
    path: string;
    content: string;
}

export interface EditAfterInput {
    path: string;
    content: string;
    changes: readonly AppliedByteEdit[];
}

declare const editBaselineTokenBrand: unique symbol;
export interface EditBaselineToken {
    readonly [editBaselineTokenBrand]: true;
    readonly id: string;               // opaque, process-local, single-use
    readonly capturedAt: number;
    readonly hardExpiresAt: number;    // capturedAt + 10 minutes
}

export type AdvisoryType =
    | 'introduced_parse_breakage'
    | 'removed_import_still_called'
    | 'introduced_unreachable_after_return';

export interface EditAdvisoryBase {
    path: string;
    range: ExactSourceRange;
    factKey: string;
}

export type EditAdvisory =
    | (EditAdvisoryBase & { type: 'introduced_parse_breakage'; detail: {
          diagnosticKind: 'ERROR' | 'MISSING'; diagnosticKey: string;
      } })
    | (EditAdvisoryBase & { type: 'removed_import_still_called'; detail: {
          importDeclarationKey: string; referenceKey: string;
          unresolvedReason: 'not_declared' | 'module_not_found';
      } })
    | (EditAdvisoryBase & { type: 'introduced_unreachable_after_return'; detail: {
          returnRange: ExactSourceRange; statementKind: string;
      } });

export type EditBaselineCaptureResult =
    | { status: 'captured'; baseline: EditBaselineToken; coverage: FactCoverage }
    | { status: 'unavailable'; reason: UnavailabilityReason; issues: readonly CoverageIssue[] };

export type EditAdvisoryResult =
    | { status: 'complete' | 'partial'; advisories: readonly EditAdvisory[];
        suppressedCount: number; coverage: FactCoverage; issues: readonly CoverageIssue[] }
    | { status: 'unavailable'; advisories: readonly []; suppressedCount: 0;
        reason: 'expired' | 'consumed' | 'invalid_change_map'
            | 'freshness_failed' | 'semantic_unavailable'; issues: readonly CoverageIssue[] };

/**
 * Completed by Task 2.1 integration (below): AstSession, OpenSessionResult,
 * ResolutionResult, OccurrenceFact, FileModel, LocationModel,
 * OccurrenceAnswer, RelationAnswer, ScopeModel, ContextAnswer, FsContext,
 * and the compile-time fact ledger. The three facade functions
 * (openAstSession, captureEditBaseline, evaluateEditAdvisories) live in
 * ast-intelligence.ts.
 */

// ---------------------------------------------------------------------------
// Task 2.1 integration — facade context and occurrence facts
// ---------------------------------------------------------------------------

/**
 * The capability surface the facade needs from the MCP server context. The
 * same structural shape the server hands ProjectContext; the facade never
 * sees the server itself.
 */
export interface FsContext {
    getAllowedDirectories(): string[];
    validatePath(p: string): Promise<string>;
}

/**
 * One persisted occurrence — a declaration, reference, import, or export
 * fact — as projected through any public answer. v4 rows carry line/column
 * precision (range.precision 'line'); v5 upgrades to byte-exact ranges
 * without changing this shape.
 */
export interface OccurrenceFact {
    handle: SymbolHandle;
    path: string;                       // scope-relative store key
    role: 'declaration' | 'reference' | 'import' | 'export';
    name: string;
    qualifiedName: string | null;
    kind: string;
    namespace: SemanticNamespace;
    range: SourceRange;
    owner: { stableKey: string; name: string; kind: string } | null;
    ownerSource: LocatedSymbol['parentChainSource'];
    evidence: EvidenceGrade;
    tainted: boolean;
}

// ---------------------------------------------------------------------------
// Task 2.1 integration — the seven answer payloads
// ---------------------------------------------------------------------------

/** File identity facts (ledger row: file identity/language/hashes/coverage). */
export interface FileIdentityFacts {
    path: string;
    language: string | null;
    sourceHash: string;                 // exact stored content hash or versioned sentinel
    oversized: boolean;                 // hash is the too-large sentinel
    lastIndexedAt: number;
}

export interface ScopeFact {
    kind: string;
    range: SourceRange;
    ownerStableKey: string | null;
}

export interface ImportBindingFact {
    importedName: string;
    localName: string;
    bindingKind: string;
    typeOnly: boolean;
    range: SourceRange;
}

export interface ImportFact {
    module: string;
    importedNames: readonly string[];
    range: SourceRange;
    bindings: readonly ImportBindingFact[];
}

export interface AnchorFact {
    kind: string;
    priority: number | null;
    range: SourceRange;
}

export interface InjectionFact {
    language: string;
    range: SourceRange;
}

export interface StructureFact {
    ownerStableKey: string;
    parameters: readonly string[];
    modifiers: readonly string[];
    declaredReturnType: string | null;
    extendsNames: readonly string[];
}

/** v5+ (ast_diagnostics); every v4 projection reports it unavailable. */
export interface DiagnosticFact {
    kind: 'ERROR' | 'MISSING';
    range: SourceRange;
    detail: string;
}

/** v5+ (ast_exports); every v4 projection reports it unavailable. */
export interface ExportFact {
    exportedName: string;
    localName: string | null;
    moduleSpecifier: string | null;
    form: string;
    typeOnly: boolean;
    range: SourceRange;
}

export interface RelationFacts {
    explicit: readonly ProvenRelation[];
    frontier: readonly RelationFrontier[];
}

/**
 * Exactly one tagged result per requested FileSection — omission is not a
 * state. A section that cannot be served at the current schema/evidence level
 * is present with status 'unavailable' and a typed reason.
 */
export type FileSectionResult =
    | { section: 'identity'; status: 'complete' | 'partial'; facts: FileIdentityFacts }
    | { section: 'declarations'; status: 'complete' | 'partial'; facts: readonly OccurrenceFact[] }
    | { section: 'references'; status: 'complete' | 'partial'; facts: readonly OccurrenceFact[] }
    | { section: 'scopes'; status: 'complete' | 'partial'; facts: readonly ScopeFact[] }
    | { section: 'imports'; status: 'complete' | 'partial'; facts: readonly ImportFact[] }
    | { section: 'exports'; status: 'complete' | 'partial'; facts: readonly ExportFact[] }
    | { section: 'structures'; status: 'complete' | 'partial'; facts: readonly StructureFact[] }
    | { section: 'signatures'; status: 'complete' | 'partial'; facts: readonly StructureFact[] }
    | { section: 'anchors'; status: 'complete' | 'partial'; facts: readonly AnchorFact[] }
    | { section: 'injections'; status: 'complete' | 'partial'; facts: readonly InjectionFact[] }
    | { section: 'diagnostics'; status: 'complete' | 'partial'; facts: readonly DiagnosticFact[] }
    | { section: 'module'; status: 'complete' | 'partial'; facts: { moduleKey: string } }
    | { section: 'configuration'; status: 'complete' | 'partial'; facts: { configHash: string } }
    | { section: 'relations'; status: 'complete' | 'partial'; facts: RelationFacts }
    | { section: 'bindings'; status: 'complete' | 'partial'; facts: readonly OccurrenceFact[] }
    | { section: 'coverage'; status: 'complete' | 'partial'; facts: FactCoverage }
    | { section: FileSection; status: 'unavailable'; reason: UnavailabilityReason };

export interface FileModel extends CoveredAnswer {
    path: string;
    sections: readonly FileSectionResult[];
    page: PageInfo;
}

/** A fact intersecting the queried point/range, tagged by domain. */
export type LocatedFact =
    | { kind: 'occurrence'; fact: OccurrenceFact }
    | { kind: 'scope'; fact: ScopeFact }
    | { kind: 'anchor'; fact: AnchorFact }
    | { kind: 'injection'; fact: InjectionFact }
    | { kind: 'diagnostic'; fact: DiagnosticFact }
    | { kind: 'relation'; fact: RelationFacts };

export interface LocationModel extends CoveredAnswer {
    path: string;
    at: SourcePosition | SourceRange;
    /** Innermost-first containment chain at the queried location. */
    enclosing: readonly LocatedSymbol[];
    facts: readonly LocatedFact[];
    page: PageInfo;
}

export interface ResolutionResult extends CoveredAnswer {
    occurrence: OccurrenceFact | null;
    resolution: ResolutionAnswer;
    candidatePage: PageInfo;
}

export interface TextCandidate {
    path: string;
    range: SourceRange;
    literal: string;
    /** Text candidates are candidate evidence only — never matches. */
    handle: Extract<SymbolHandle, { kind: 'text' }>;
}

export interface CoverageProof {
    scopeKey: string;
    fileDomainDigest: string;
    fileCount: number;
    contentDigest: string | null;
    contentFileCount: number;
    scannedBytes: number;
    scanner: 'rg' | 'in_process' | 'none';
    complete: boolean;
}

export interface OccurrenceAnswer extends CoveredAnswer {
    matches: readonly OccurrenceFact[];
    textCandidates: readonly TextCandidate[];
    totalPersisted: PageInfo['total'];
    page: PageInfo;
    coverageProof: CoverageProof | null;
}

export interface RelationAnswer extends CoveredAnswer {
    relations: readonly ProvenRelation[];
    frontier: readonly RelationFrontier[];
    page: PageInfo;
}

export interface ScopeGroup {
    /** Grouping key: store-key directory, language name, or module key. */
    key: string;
    fileCount: number;
    declarationCount: number;
    referenceCount: number;
    languages: readonly { language: string; fileCount: number }[];
}

export type ScopeSectionResult =
    | { section: NonNullable<ScopeQuestion['sections']>[number]; status: 'complete' | 'partial';
        groups: readonly ScopeGroup[]; total: PageInfo['total'] }
    | { section: NonNullable<ScopeQuestion['sections']>[number]; status: 'unavailable';
        reason: UnavailabilityReason };

export interface ScopeModel extends CoveredAnswer {
    scope: ScopeSelector;
    sections: readonly ScopeSectionResult[];
    page: PageInfo;
}

export interface ContextRange {
    path: string;
    range: SourceRange;
    reason: ContextReason;
    ownerStableKey: string | null;
}

export interface ContextAnswer extends CoveredAnswer {
    ranges: readonly ContextRange[];
    page: PageInfo;
}

// ---------------------------------------------------------------------------
// Task 2.1 integration — the frozen session algebra
// ---------------------------------------------------------------------------

export interface AstSession {
    readonly basis: SessionBasis;
    fileModel(path: string, q?: FileModelQuestion): Promise<QueryResult<FileModel>>;
    locationAt(path: string, q: LocationQuestion): Promise<QueryResult<LocationModel>>;
    resolveAt(path: string, q: ResolveQuestion): Promise<QueryResult<ResolutionResult>>;
    queryOccurrences(q: OccurrenceQuestion): Promise<QueryResult<OccurrenceAnswer>>;
    traceRelations(q: RelationQuestion): Promise<QueryResult<RelationAnswer>>;
    scopeModel(q: ScopeQuestion): Promise<QueryResult<ScopeModel>>;
    contextFor(q: ContextQuestion): Promise<QueryResult<ContextAnswer>>;
    close(): void;
}

export type OpenSessionResult =
    | { status: 'opened'; session: AstSession }
    | { status: 'failed'; failure: OperationalFailure;
        updated: readonly string[]; unchanged: readonly string[]; failedPath: string | null };

// ---------------------------------------------------------------------------
// Task 2.1 integration — compile-time exhaustive fact ledger
// ---------------------------------------------------------------------------

export type SessionQueryName =
    | 'fileModel' | 'locationAt' | 'resolveAt' | 'queryOccurrences'
    | 'traceRelations' | 'scopeModel' | 'contextFor';

/** Every persisted v4 fact family. v5/v6 tasks EXTEND this union; the two
 * Record maps below then fail to compile until the new family is routed. */
export type PersistenceFamily =
    | 'files' | 'symbols' | 'edges' | 'symbol_structures' | 'anchors'
    | 'imports' | 'import_bindings' | 'injections' | 'local_scopes';

export interface FactLedgerEntry {
    /** The lossless typed projection named by the plan's ledger table. */
    losslessProjection: string;
    /** Every public query that may serve this domain. */
    owners: NonEmpty<SessionQueryName>;
    /** First schema version at which the domain has persisted rows. */
    availableFrom: 4 | 5 | 6;
}

/**
 * The authoritative fact ledger (plan § Authoritative fact ledger) as a
 * compile-time exhaustive map: adding a FactDomain member without routing it
 * here is a type error, as is removing a projection owner a test pins.
 */
export const FACT_LEDGER: Readonly<Record<FactDomain, FactLedgerEntry>> = {
    file: { losslessProjection: 'fileModel.identity/coverage', availableFrom: 4,
        owners: ['fileModel', 'scopeModel'] },
    declaration: { losslessProjection: 'fileModel.declarations', availableFrom: 4,
        owners: ['fileModel', 'queryOccurrences', 'locationAt', 'resolveAt', 'scopeModel', 'contextFor'] },
    reference: { losslessProjection: 'fileModel.references', availableFrom: 4,
        owners: ['fileModel', 'queryOccurrences', 'locationAt', 'resolveAt', 'traceRelations', 'contextFor'] },
    scope: { losslessProjection: 'fileModel.scopes', availableFrom: 4,
        owners: ['fileModel', 'locationAt', 'queryOccurrences', 'contextFor'] },
    import: { losslessProjection: 'fileModel.imports', availableFrom: 4,
        owners: ['fileModel', 'queryOccurrences', 'resolveAt', 'traceRelations', 'scopeModel', 'contextFor'] },
    import_binding: { losslessProjection: 'fileModel.imports[].bindings', availableFrom: 4,
        owners: ['fileModel', 'queryOccurrences', 'resolveAt', 'traceRelations', 'scopeModel', 'contextFor'] },
    export: { losslessProjection: 'fileModel.exports', availableFrom: 5,
        owners: ['fileModel', 'queryOccurrences', 'resolveAt', 'traceRelations', 'scopeModel'] },
    structure: { losslessProjection: 'fileModel.structures', availableFrom: 4,
        owners: ['fileModel', 'locationAt', 'queryOccurrences', 'contextFor'] },
    signature: { losslessProjection: 'fileModel.signatures', availableFrom: 5,
        owners: ['fileModel', 'locationAt', 'queryOccurrences', 'contextFor'] },
    anchor: { losslessProjection: 'fileModel.anchors', availableFrom: 4,
        owners: ['fileModel', 'locationAt', 'contextFor', 'scopeModel'] },
    injection: { losslessProjection: 'fileModel.injections', availableFrom: 4,
        owners: ['fileModel', 'locationAt', 'contextFor', 'scopeModel'] },
    diagnostic: { losslessProjection: 'fileModel.diagnostics', availableFrom: 5,
        owners: ['fileModel', 'locationAt', 'scopeModel'] },
    module: { losslessProjection: 'fileModel.module', availableFrom: 5,
        owners: ['fileModel', 'scopeModel', 'resolveAt'] },
    configuration: { losslessProjection: 'fileModel.configuration', availableFrom: 5,
        owners: ['fileModel', 'scopeModel', 'resolveAt'] },
    relation: { losslessProjection: 'fileModel.relations (explicit + frontier)', availableFrom: 4,
        owners: ['fileModel', 'traceRelations', 'locationAt', 'scopeModel', 'contextFor'] },
    binding: { losslessProjection: 'resolveAt proof / fileModel.bindings', availableFrom: 6,
        owners: ['resolveAt', 'fileModel', 'queryOccurrences', 'traceRelations', 'scopeModel', 'contextFor'] },
};

/**
 * Every persisted family names the fact domains it feeds. A new table cannot
 * ship without declaring its public story — the map fails to compile.
 */
export const PERSISTENCE_FAMILY_DOMAINS: Readonly<Record<PersistenceFamily, NonEmpty<FactDomain>>> = {
    files: ['file'],
    symbols: ['declaration', 'reference', 'scope'],
    edges: ['relation', 'reference'],
    symbol_structures: ['structure', 'signature'],
    anchors: ['anchor'],
    imports: ['import'],
    import_bindings: ['import_binding'],
    injections: ['injection'],
    local_scopes: ['scope'],
};
