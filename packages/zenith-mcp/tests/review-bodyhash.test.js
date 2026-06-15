import { describe, expect, it } from 'vitest';

import { bodyHash } from '../dist/core/tree-sitter/body.js';

// Regression for PR #24 review finding #3 (Rule 13 — most robust solution):
// bodyHash must use SHA-256, not SHA-1. SHA-256 hex digests are 64 lowercase
// hex chars (SHA-1 was 40). bodyHash is an internal content fingerprint for
// change detection, so the contract that matters is: stable hex length,
// deterministic per input, and collision-resistant across distinct inputs.
describe('bodyHash SHA-256 fingerprint', () => {
    const SHA256_HEX = /^[0-9a-f]{64}$/;

    it('returns 64 lowercase hex chars (SHA-256, not SHA-1 40-char)', () => {
        const digest = bodyHash('function foo() { return 1; }');
        expect(digest).toMatch(SHA256_HEX);
        expect(digest.length).toBe(64);
        // Guard against a silent regression back to SHA-1.
        expect(digest.length).not.toBe(40);
    });

    it('produces 64-char hex for varied inputs (empty, unicode, multi-line)', () => {
        const inputs = [
            '',
            'x',
            'const é = "café";',
            'line one\nline two\nline three',
        ];
        for (const input of inputs) {
            const digest = bodyHash(input);
            expect(digest).toMatch(SHA256_HEX);
        }
    });

    it('is deterministic for identical input', () => {
        const input = 'export function bodySlice(source, startLine, endLine) {}';
        expect(bodyHash(input)).toBe(bodyHash(input));
    });

    it('differs for different input', () => {
        expect(bodyHash('alpha')).not.toBe(bodyHash('beta'));
        // Single-character difference must still diverge.
        expect(bodyHash('return a;')).not.toBe(bodyHash('return b;'));
    });

    it('matches the canonical SHA-256 digest of a known input', () => {
        // sha256("hello") — the well-known reference digest. Pins the algorithm
        // to SHA-256 exactly (a SHA-1 implementation could never produce this).
        expect(bodyHash('hello')).toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        );
    });
});
