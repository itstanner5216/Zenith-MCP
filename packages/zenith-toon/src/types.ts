export interface StructureBlock {
  name: string;
  kind: string;
  type: string;
  startLine: number;     // 0-based (NOT start_line)
  endLine: number;       // 0-based inclusive (NOT end_line)
  exported: boolean;
  anchors: Anchor[];
  priority?: number;
}

export interface Anchor {
  startLine: number;
  endLine: number;
  kind: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// AST-aware SageRank edges
// ---------------------------------------------------------------------------

/**
 * Represents a directed edge in the AST call/reference graph.
 * Used to augment SageRank's text-similarity graph with structural relationships.
 */
export interface ASTEdge {
  /** Source block index (the caller/referencer) */
  from: number;
  /** Target block index (the callee/referenced) */
  to: number;
  /** Edge weight (1.0 for calls, 0.5 for type refs, etc.) */
  weight: number;
  /** Edge type for debugging/analysis */
  kind?: 'call' | 'reference' | 'type_ref' | 'import' | 'inherit';
}

/**
 * Result from building AST edges for a set of blocks.
 */
export interface ASTEdgeResult {
  /** Edges between blocks in this file */
  edges: ASTEdge[];
  /** Names of external symbols referenced (not defined in this file) */
  externalRefs: string[];
  /** Statistics */
  stats: {
    totalEdges: number;
    callEdges: number;
    typeRefEdges: number;
  };
}

// ---------------------------------------------------------------------------
// Compression context — structural data passed from caller to toon
// ---------------------------------------------------------------------------

/**
 * Enriched context for structured source compression.
 *
 * Toon owns the type — MCP fills it from its own stores.
 * All fields optional; toon degrades gracefully when absent.
 */
export interface CompressionContext {
  /** Pre-built AST edges between blocks in this file */
  astEdges?: ASTEdge[];
  /** Symbols this file exports (used to boost block priority) */
  exportedSymbols?: string[];
  /** Files this file imports from (used for cross-file relevance) */
  importedFiles?: string[];
  /** Caller → callee pairs with call counts (supplementary graph signal) */
  callGraph?: Array<{ caller: string; callee: string; weight: number }>;
}

// ---------------------------------------------------------------------------
// compressFile entrypoint contract — raw facts in, compressed string out
// ---------------------------------------------------------------------------

/**
 * Raw structural facts about a single file, gathered by the consumer.
 * TOON owns all shaping/compression decisions; the consumer only gathers facts.
 */
export interface RawFileFacts {
    path: string;                 // repo-relative; TOON does not read the filesystem
    langName: string | null;      // tree-sitter language name, or null if unsupported
    defs: Array<{
        name: string;
        kind: 'def';              // always 'def' on this payload
        type: string;             // e.g. 'function', 'method', 'class'
        line: number;             // 1-based
        endLine: number;          // 1-based
        visibility: string | null;
        captureTag: string | null;
    }>;
    edges: Array<{ callerName: string; calleeName: string; callCount: number }>; // raw count; no sqrt
    anchors: Array<{ symbolName: string; kind: string; line: number; text: string }>; // 1-based
    imports: Array<{ module: string; importedNames: string[]; line: number }>;
    injections: Array<{ injectedLang: string; startLine: number; endLine: number }>; // verbatim ranges; Priority 0
}

export interface CompressFileRequest {
    source: string;
    maxChars: number;             // ceiling only; TOON floors at 70% internally
    facts: RawFileFacts;
}

// ---------------------------------------------------------------------------
// config shapes
// ---------------------------------------------------------------------------

export interface BudgetTier {
  percentile: number;
  tier_name: string;
}

export interface FieldMatcher {
  field_path: string | null;
  field_pattern: string | null;
  min_length: number | null;
  max_length: number | null;
}

export interface CodecConfig {
  strategy: string;
  budget: number | null;
}

export interface EncoderRule {
  matcher: FieldMatcher;
  codec: CodecConfig;
}

export interface ArrayCodecConfig {
  enabled: boolean;
  threshold: number;
  sample_size: number;
}

export interface StringCodecConfig {
  enabled: boolean;
  default_budget: number;
  min_length: number;
  parse_json: boolean;
  stack_trace_max_user_frames: number;
}

export interface DedupConfig {
  enabled: boolean;
  scope: string;
  maxsize: number;
}

export interface BMXConfig {
  enabled: boolean;
  mode: string;
  query: string | null;
  core_fraction: number;
  gini_threshold: number;
  tiers: BudgetTier[];
}

export interface ToonConfig {
  enabled: boolean;
  preserve_rules: FieldMatcher[];
  encode_rules: EncoderRule[];
  default_codec: CodecConfig | null;
  array: ArrayCodecConfig;
  string: StringCodecConfig;
  dedup: DedupConfig;
  bmx: BMXConfig;
  emit_markers: boolean;
  emit_stats: boolean;
}

// ---------------------------------------------------------------------------
// dedup shapes
// ---------------------------------------------------------------------------

export interface DedupStats {
  exact: number;
  near: number;
  template: number;
}

/** Computed total of all removed entries across dedup tiers */
export function dedupStatsTotal(stats: DedupStats): number {
  return stats.exact + stats.near + stats.template;
}

export interface TemplateInfo {
  pattern: string;
  count: number;
  sample: unknown;
}

/**
 * Full TemplateInfo as used internally —
 * tracks first/last content for template collapsing.
 */
export interface TemplateInfoFull {
  first_content: unknown;
  last_content: unknown;
  count: number;
  first_index: number;
  last_index: number;
}

/** Entry metadata dict as produced by the deduplicator pass. */
export interface EntryMeta {
  content: unknown;
  type: string;
  index: number;
  template_id: string | null;
  __toon_template?: boolean;
  template_count?: number;
  template_first?: unknown;
  template_last?: unknown;
}

export interface DedupResult {
  entries: EntryMeta[];
  dedup_stats: DedupStats;
  templates: Map<string, TemplateInfoFull>;
}

// ---------------------------------------------------------------------------
// pipeline shapes
// ---------------------------------------------------------------------------

export interface CompressConfig {
  core_fraction_method: string;
  core_fraction_fixed: number;
  gini_threshold: number;
  hubness_z_threshold: number;
  redundancy_r_threshold: number;
  dedup_scope: string;
  dedup_maxsize: number;
  string_budget_ratio: number;
  stack_trace_max_user_frames: number;
  tier_ratios: Record<string, number>;
  min_entries_for_scoring: number;
  sagerank_top_k: number;
  preserve_fields: ReadonlySet<string>;
  encode_fields: ReadonlySet<string>;
}

export interface ScoredEntries {
  entries: EntryMeta[];
  scores: number[];
  tiers: string[];
  core_indices: number[];
  scoring_stats: Record<string, unknown>;
}

export interface CompressedOutput {
  entries: unknown[];
  budget_used: number;
  stats: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// encoder shapes
// ---------------------------------------------------------------------------

/**
 * TOON metadata summary for compressed arrays.
 * Field names match the toon encoder output format.
 */
export interface ToonArrayMeta {
  __toon: true;
  count: number;
  sample: unknown[];
}

/** Template marker emitted by pipeline Stage 3. */
export interface ToonTemplateMeta {
  __toon_template: true;
  count: number;
  first: unknown;
  last: unknown;
}

// ---------------------------------------------------------------------------
// Utility: type guards
// ---------------------------------------------------------------------------

export function isToonArrayMeta(v: unknown): v is ToonArrayMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['__toon'] === true &&
    typeof (v as Record<string, unknown>)['count'] === 'number' &&
    Array.isArray((v as Record<string, unknown>)['sample'])
  );
}

export function isToonTemplateMeta(v: unknown): v is ToonTemplateMeta {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['__toon_template'] === true &&
    typeof (v as Record<string, unknown>)['count'] === 'number'
  );
}
