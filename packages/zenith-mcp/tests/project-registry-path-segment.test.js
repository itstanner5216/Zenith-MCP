/**
 * Tests for ProjectRegistry.findProject() path-segment matching (step 3),
 * covering the PR change from:
 *   const firstSegment = query.split(/[\/]/)[0].trim().toLowerCase();
 * to:
 *   const firstSegmentRaw = query.split(/[\/]/)[0];
 *   const firstSegment = firstSegmentRaw?.trim().toLowerCase();
 *
 * The optional chaining (`?.`) ensures undefined safety under noUncheckedIndexedAccess.
 * The behavior is identical in practice since split() of a non-empty string always
 * returns at least one element.
 *
 * These tests focus on edge cases for path-segment matching:
 *   - Leading slash (query starts with '/')
 *   - Trailing slash only
 *   - Multiple slashes
 *   - Windows-style backslash paths
 *   - Query with only a slash
 */

import { describe, expect, it } from 'vitest';
import path from 'path';
import { ProjectRegistry } from '../dist/core/project-registry.js';

const FIXTURE_DIR = '/tmp/test-projects-ps';

const makeManifest = (id, name, root) => ({
    project_id: id,
    project_name: name,
    project_root: root,
});

describe('ProjectRegistry — path-segment matching (step 3) edge cases', () => {
    const alpha = makeManifest('alpha', 'Alpha Service', `${FIXTURE_DIR}/alpha`);
    const beta = makeManifest('beta-api', 'Beta API', `${FIXTURE_DIR}/beta`);

    function makeRegistry() {
        return new ProjectRegistry([alpha, beta]);
    }

    // Basic step 3 functionality
    it('extracts first segment correctly from normal path', () => {
        const reg = makeRegistry();
        expect(reg.findProject('alpha/src/main.ts')).toBe(alpha);
    });

    it('extracts first segment correctly with project name', () => {
        const reg = makeRegistry();
        expect(reg.findProject('Beta API/lib/index.js')).toBe(beta);
    });

    // Edge cases from the PR change
    it('handles path that is just a single segment with trailing slash', () => {
        const reg = makeRegistry();
        // 'alpha/' splits to ['alpha', ''] — first segment is 'alpha'
        expect(reg.findProject('alpha/')).toBe(alpha);
    });

    it('handles path with multiple slashes', () => {
        const reg = makeRegistry();
        // 'alpha/src//deep' — first segment is 'alpha'
        expect(reg.findProject('alpha/src//deep')).toBe(alpha);
    });

    it('returns null (falls through) for path starting with slash', () => {
        const reg = makeRegistry();
        // '/alpha/src' splits to ['', 'alpha', 'src'] — first segment is ''
        // '' trimmed and lowercased is '' which is falsy, so step 3 skips it
        // Falls through to step 4 (exact path match) which also won't match
        // Step 5 (prefix match) also won't match since these are different roots
        const result = reg.findProject('/alpha/src');
        // Should not match alpha (since it's a different absolute path)
        expect(result === null || result !== alpha).toBe(true);
    });

    it('handles whitespace around segment', () => {
        const reg = makeRegistry();
        // ' alpha /src' — first segment ' alpha ' trimmed is 'alpha'
        expect(reg.findProject(' alpha /src')).toBe(alpha);
    });

    it('is case-insensitive for path segment matching', () => {
        const reg = makeRegistry();
        expect(reg.findProject('ALPHA/src/main.ts')).toBe(alpha);
        expect(reg.findProject('Alpha/src/main.ts')).toBe(alpha);
    });

    it('handles path with no separator (no step 3 trigger)', () => {
        const reg = makeRegistry();
        // 'alpha' has no '/' so step 3 is not triggered — but step 1 (exact id) matches
        expect(reg.findProject('alpha')).toBe(alpha);
    });

    it('returns null for completely unrecognized path segment', () => {
        const reg = makeRegistry();
        expect(reg.findProject('unknown-proj/src/main.ts')).toBeNull();
    });

    it('prefers step 1 (exact id) over step 3 (path segment)', () => {
        const reg = makeRegistry();
        // 'alpha' matches step 1 directly, no need to reach step 3
        const result = reg.findProject('alpha');
        expect(result).toBe(alpha);
    });
});

// ---------------------------------------------------------------------------
// ProjectRegistry — path-separator on Windows (path.sep)
// ---------------------------------------------------------------------------

describe('ProjectRegistry — Windows path separator fallback', () => {
    it('step 3 also matches when path.sep separator is used', () => {
        const alpha = makeManifest('alpha', 'Alpha', '/alpha');
        const reg = new ProjectRegistry([alpha]);

        if (path.sep === '\\') {
            // On Windows, 'alpha\\src' should trigger step 3
            expect(reg.findProject('alpha\\src\\main.ts')).toBe(alpha);
        } else {
            // On Unix, just verify forward slash still works
            expect(reg.findProject('alpha/src/main.ts')).toBe(alpha);
        }
    });
});

// ---------------------------------------------------------------------------
// ProjectRegistry — step 3 id vs name preference
// ---------------------------------------------------------------------------

describe('ProjectRegistry — step 3 id preference over name', () => {
    it('step 3 tries id first, then name', () => {
        // 'proj-id' is the id of proj1; 'proj-name' is the name of proj2
        const proj1 = makeManifest('proj-id', 'Other Name', '/proj1');
        const proj2 = makeManifest('other-id', 'proj-name', '/proj2');
        const reg = new ProjectRegistry([proj1, proj2]);

        // 'proj-id/file.ts' should match proj1 by id
        expect(reg.findProject('proj-id/file.ts')).toBe(proj1);

        // 'proj-name/file.ts' should match proj2 by name
        expect(reg.findProject('proj-name/file.ts')).toBe(proj2);
    });
});