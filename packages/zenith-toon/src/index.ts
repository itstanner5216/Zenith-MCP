// zenith-toon — Token-Optimized Output Normalization
//
// A compression library for making codebase scanning cheap. When a model is
// orienting in a codebase (understanding structure, finding relationships),
// it should not pay full token cost for content that's largely noise.
//
// Architecture:
//   Layer 1 (LIVE): String codecs — compressString(), compressSourceStructured()
//     Content-type-aware compression of single strings. Language-aware when the
//     consumer provides tree-sitter structure (see compressSourceStructured).
//
//   Layer 2 (WIRING IN PROGRESS): Multi-entry pipeline — compress()
//     For inputs that are lists/objects: dedup → score → tier → budget → per-entry codec.
//     Components: Deduplicator, BMXPlusIndex, SageRank, BudgetAllocator, encodeRecursive.
//
//   Layer 3: Config & routing — ToonConfig, PRESETS, routeField()
//     Rule-based field routing for dict-shaped entries in the pipeline.
//
// Language awareness is provided by the consumer via the `structure` parameter
// to compressSourceStructured(). In Zenith-MCP, this comes from:
//   src/core/tree-sitter/compression-structure.ts (17 languages with anchor rules)
//   src/core/tree-sitter/languages.ts (43 grammar mappings)

// ---------------------------------------------------------------------------
// Legacy API (backward-compatible)
// ---------------------------------------------------------------------------
export { encodeOutput, encodeRecursive } from './encoder.js';

// ---------------------------------------------------------------------------
// Full Pipeline API
// ---------------------------------------------------------------------------
export { compress, CompressConfig, TOONCompressor } from './pipeline.js';
export type { ScoredEntries, CompressedOutput } from './pipeline.js';

// ---------------------------------------------------------------------------
// String codec public API
// ---------------------------------------------------------------------------
export { compressString, compressSourceStructured } from './string-codec.js';

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
export { BMXPlusIndex } from './bmx-plus.js';
export { SageRank } from './sagerank.js';
export type { SageResult } from './sagerank.js';

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------
export { Deduplicator } from './dedup.js';
export type { DedupStats, DedupResult, TemplateInfo } from './dedup.js';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------
export { BudgetAllocator } from './budget.js';
export type { BudgetAllocation } from './budget.js';

// ---------------------------------------------------------------------------
// Router & Presets
// ---------------------------------------------------------------------------
export { fieldMatcherMatches, routeField } from './router.js';
export { PRESETS } from './presets.js';

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------
export {
  defaultToonConfig,
  toonConfigPreset,
  toonConfigFromCompressConfig,
  defaultBudgetTier,
  defaultFieldMatcher,
  defaultCodecConfig,
  defaultArrayCodecConfig,
  defaultStringCodecConfig,
  defaultDedupConfig,
  defaultBMXConfig,
} from './config.js';
export type {
  BudgetTier,
  FieldMatcher,
  CodecConfig,
  EncoderRule,
  ArrayCodecConfig,
  StringCodecConfig,
  DedupConfig,
  BMXConfig,
  ToonConfig,
} from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type {
  StructureBlock,
  Anchor,
  EntryMeta,
  TemplateInfoFull,
  CompressConfig as CompressConfigShape,
  ToonArrayMeta,
  ToonTemplateMeta,
} from './types.js';
export { isToonArrayMeta, isToonTemplateMeta, dedupStatsTotal } from './types.js';

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
export {
  normalizeValue,
  blake2bHash,
  canonicalJson,
  estimateTokens,
  estimateTokensObj,
  flattenToText,
  computeGini,
  findKneedle,
  pearsonR,
  NORMALIZERS,
  TIMESTAMP_RE,
  UUID_RE,
  IP_RE,
  BIGNUM_RE,
  B64_RE,
} from './utils.js';
