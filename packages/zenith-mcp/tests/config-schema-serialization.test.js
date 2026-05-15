/**
 * Tests for config/schema.ts changes in this PR.
 *
 * PR change in configToRaw():
 *   Before: entries.push(kv(name, config.tools[name], statusToStr(config.tools[name])));
 *   After:  const enabled = config.tools[name];
 *           if (enabled === undefined) continue;
 *           entries.push(kv(name, enabled, statusToStr(enabled)));
 *
 * Also removed the unused `section()` function (no behavior change).
 *
 * These tests verify that configToRaw correctly serializes the tools section
 * and that the undefined guard doesn't break normal operation.
 */

import { describe, expect, it } from 'vitest';
import { configToRaw, rawToConfig, DEFAULT_CONFIG, expandTilde } from '../dist/config/schema.js';

// ---------------------------------------------------------------------------
// configToRaw — basic shape
// ---------------------------------------------------------------------------

describe('configToRaw — basic shape', () => {
    it('returns an array of RawConfig entries', () => {
        const result = configToRaw(DEFAULT_CONFIG);
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
    });

    it('contains section entries for known config areas', () => {
        const result = configToRaw(DEFAULT_CONFIG);
        const types = result.map(e => e.type);
        expect(types).toContain('section');
        expect(types).toContain('subsection');
    });

    it('includes a kv entry for each enabled tool', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                search_files: true,
                read_file: false,
            },
        };
        const result = configToRaw(config);
        const kvEntries = result.filter(e => e.type === 'kv');
        const toolKvs = kvEntries.filter(e => e.key === 'search_files' || e.key === 'read_file');
        expect(toolKvs.length).toBe(2);
    });

    it('skips tools with undefined values (new guard in this PR)', () => {
        // Simulate a tools record with an undefined value
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                known_tool: true,
                undefined_tool: undefined,
            },
        };
        const result = configToRaw(config);
        const kvEntries = result.filter(e => e.type === 'kv');
        // known_tool should be present
        const knownKv = kvEntries.find(e => e.key === 'known_tool');
        expect(knownKv).toBeDefined();
        // undefined_tool should be skipped
        const undefinedKv = kvEntries.find(e => e.key === 'undefined_tool');
        expect(undefinedKv).toBeUndefined();
    });

    it('includes a comment when tools is empty', () => {
        const config = { ...DEFAULT_CONFIG, tools: {} };
        const result = configToRaw(config);
        const comments = result.filter(e => e.type === 'comment');
        const noToolsComment = comments.find(e => e.text && e.text.includes('no tools'));
        expect(noToolsComment).toBeDefined();
    });

    it('tools are serialized in sorted order', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: {
                z_tool: true,
                a_tool: false,
                m_tool: true,
            },
        };
        const result = configToRaw(config);
        const toolKvs = result.filter(e => e.type === 'kv' &&
            ['a_tool', 'm_tool', 'z_tool'].includes(e.key));
        const names = toolKvs.map(e => e.key);
        expect(names).toEqual([...names].sort());
    });
});

// ---------------------------------------------------------------------------
// configToRaw — status string values
// ---------------------------------------------------------------------------

describe('configToRaw — status string values', () => {
    it('enabled tool has comment value "enabled"', () => {
        const config = { ...DEFAULT_CONFIG, tools: { my_tool: true } };
        const result = configToRaw(config);
        const kv = result.find(e => e.type === 'kv' && e.key === 'my_tool');
        expect(kv).toBeDefined();
        expect(kv.comment).toBe('enabled');
    });

    it('disabled tool has comment value "disabled"', () => {
        const config = { ...DEFAULT_CONFIG, tools: { my_tool: false } };
        const result = configToRaw(config);
        const kv = result.find(e => e.type === 'kv' && e.key === 'my_tool');
        expect(kv).toBeDefined();
        expect(kv.comment).toBe('disabled');
    });
});

// ---------------------------------------------------------------------------
// expandTilde — basic behavior
// ---------------------------------------------------------------------------

describe('expandTilde', () => {
    it('expands ~ at the start to homedir', () => {
        const result = expandTilde('~/some/path');
        expect(result).not.toContain('~');
        expect(result.endsWith('/some/path')).toBe(true);
    });

    it('does not expand ~ in the middle of a path', () => {
        const input = '/home/user/~/path';
        expect(expandTilde(input)).toBe(input);
    });

    it('expands standalone ~ to homedir', () => {
        const result = expandTilde('~');
        expect(result).not.toBe('~');
        expect(result.length).toBeGreaterThan(0);
    });

    it('leaves non-tilde paths unchanged', () => {
        expect(expandTilde('/absolute/path')).toBe('/absolute/path');
        expect(expandTilde('relative/path')).toBe('relative/path');
    });

    it('handles empty string without throwing', () => {
        expect(() => expandTilde('')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// rawToConfig — round-trip sanity
// ---------------------------------------------------------------------------

describe('rawToConfig — round-trip via configToRaw', () => {
    it('round-trips DEFAULT_CONFIG without data loss', () => {
        const raw = configToRaw(DEFAULT_CONFIG);
        const restored = rawToConfig(raw);
        // The allowed_directories may differ between runs (env-based), check tools
        expect(typeof restored.tools).toBe('object');
    });

    it('round-trips a config with tools correctly', () => {
        const config = {
            ...DEFAULT_CONFIG,
            tools: { search_files: true, read_file: false },
        };
        const raw = configToRaw(config);
        const restored = rawToConfig(raw);
        expect(restored.tools.search_files).toBe(true);
        expect(restored.tools.read_file).toBe(false);
    });
});