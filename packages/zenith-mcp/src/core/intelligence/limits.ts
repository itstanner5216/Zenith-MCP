/**
 * POLARIS Decision 22 structural bounds.
 * These values are fixed by correctness and are never capacity-settled.
 */
export const LOCKED_BOUNDS = {
    ancestryDepth: 64,
    relationDepth: {
        min: 1,
        max: 5,
        default: 1,
    },
    sqlIdNameChunkSize: 100,
    persistenceBatchSize: 250,
} as const;

/**
 * POLARIS Decision 23 provisional safety and page limits.
 * Wave 7 settles them with max(provisional, nextPowerOfTwo(4 * observedP99)).
 */
export const PROVISIONAL_LIMITS = {
    sourceFileBytes: 16 * 1024 * 1024,
    workspaceFiles: 5_000,
    textFloorBytes: 64 * 1024 * 1024,
    relationTraversalNodes: 500,
    semanticUnitFiles: 512,
    retainedInactiveSnapshots: 7,
    retentionAgeHours: 24,
    pageMaxima: {
        candidates: 24,
        fileFacts: 500,
        occurrences: 200,
        scopeGroups: 200,
        contextRanges: 64,
    },
    pageDefaults: {
        fileModel: 500,
        occurrences: 200,
        scope: 200,
        context: 64,
    },
} as const;

/*
 * core/symbol-index.ts currently exports its own
 * PROVISIONAL_MAX_SOURCE_BYTES value of 16 MiB. Task 2.1 integration
 * re-points that export here; this contract-freeze slice does not import
 * or modify symbol-index.ts.
 *
 * The settlement-formula reference implementation lives in
 * tests/polaris-performance.test.js.
 */
