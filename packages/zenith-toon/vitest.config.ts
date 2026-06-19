import { defineConfig } from 'vitest/config';

// Constraint-enforcement suite for zenith-toon.
//
// Tests import the package source directly (NodeNext `.js` specifiers resolve to
// the `.ts` sources under Vitest), so the suite gates the real implementation
// without requiring a prior `tsc` build. The static-source guards additionally
// read sibling-package files (zenith-mcp) straight off disk.
export default defineConfig({
  test: {
    include: ['tests/constraints/**/*.test.ts'],
    environment: 'node',
    // The constraint suite is deterministic and self-contained; fail fast on the
    // first Priority-0 violation so CI output points straight at the drift.
    bail: 1,
    passWithNoTests: false,
    reporters: ['default'],
  },
});
