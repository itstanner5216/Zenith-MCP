import { defineConfig } from 'vitest/config';

// Suite-wide budgets (POLARIS Wave 1, 2026-07-15): the default 5s per-test
// timeout was exactly at the margin for first-in-file tool registration tests,
// which pay the tree-sitter wasm + dist import cost under full-suite parallel
// CPU load (the POLARIS performance probes index a generated 5,000-file corpus
// concurrently). These are integration tests over real parsers and databases;
// 20s is headroom, not license — anything that genuinely hangs still fails.
export default defineConfig({
    test: {
        testTimeout: 20_000,
        hookTimeout: 30_000,
    },
});
