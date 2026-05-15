/**
 * Tests for toonConfigPreset() in zenith-toon/src/config.ts.
 *
 * The function was changed in this PR from:
 *   if (!(name in presets)) { ... }
 *   return deepCopyConfig(presets[name]);
 * to:
 *   const preset = presets[name];
 *   if (preset === undefined) { ... }
 *   return deepCopyConfig(preset);
 *
 * This ensures noUncheckedIndexedAccess is satisfied while preserving the same
 * runtime semantics: throw for unknown presets, return a deep copy for known ones.
 */

import { describe, expect, it } from 'vitest';
import {
    toonConfigPreset,
    defaultToonConfig,
    PRESETS,
} from 'zenith-toon';

// ---------------------------------------------------------------------------
// Happy path — known presets
// ---------------------------------------------------------------------------

describe('toonConfigPreset — known presets', () => {
    it('returns a config for "generic"', () => {
        const config = toonConfigPreset('generic', PRESETS);
        expect(config).toBeDefined();
        expect(typeof config.enabled).toBe('boolean');
        expect(Array.isArray(config.preserve_rules)).toBe(true);
        expect(Array.isArray(config.encode_rules)).toBe(true);
    });

    it('returns a config for "codex_logs"', () => {
        const config = toonConfigPreset('codex_logs', PRESETS);
        expect(config).toBeDefined();
        expect(config.preserve_rules.length).toBeGreaterThan(0);
    });

    it('returns a config for "mcp_responses"', () => {
        const config = toonConfigPreset('mcp_responses', PRESETS);
        expect(config).toBeDefined();
    });

    it('returns a config for "aggressive"', () => {
        const config = toonConfigPreset('aggressive', PRESETS);
        expect(config).toBeDefined();
    });

    it('returns a deep copy — mutations do not affect the original preset', () => {
        const copy1 = toonConfigPreset('generic', PRESETS);
        const copy2 = toonConfigPreset('generic', PRESETS);
        // Mutate the first copy
        copy1.enabled = false;
        // Second copy and underlying preset should be unaffected
        const copy3 = toonConfigPreset('generic', PRESETS);
        expect(copy2.enabled).not.toBe(copy1.enabled);
        expect(copy3.enabled).not.toBe(false);
    });

    it('returns a new object each call — not the same reference', () => {
        const a = toonConfigPreset('generic', PRESETS);
        const b = toonConfigPreset('generic', PRESETS);
        expect(a).not.toBe(b);
    });

    it('preserves array deep copy — mutating returned encode_rules does not affect preset', () => {
        const config = toonConfigPreset('generic', PRESETS);
        const originalLength = config.encode_rules.length;
        config.encode_rules.push({ matcher: { field_pattern: 'x' }, codec: { strategy: 'truncate' } } as never);
        const config2 = toonConfigPreset('generic', PRESETS);
        expect(config2.encode_rules.length).toBe(originalLength);
    });
});

// ---------------------------------------------------------------------------
// Error cases — unknown presets
// ---------------------------------------------------------------------------

describe('toonConfigPreset — unknown presets', () => {
    it('throws for an unknown preset name', () => {
        expect(() => toonConfigPreset('nonexistent', PRESETS)).toThrow();
    });

    it('throws an Error with the unknown name quoted in the message', () => {
        expect(() => toonConfigPreset('nonexistent', PRESETS)).toThrow(/"nonexistent"/);
    });

    it('throws listing available preset names', () => {
        expect(() => toonConfigPreset('foo', PRESETS)).toThrow(/Available/);
    });

    it('throws with sorted available preset names', () => {
        const customPresets = {
            zebra: defaultToonConfig(),
            alpha: defaultToonConfig(),
            mango: defaultToonConfig(),
        };
        const err = (() => {
            try {
                toonConfigPreset('unknown', customPresets);
            } catch (e) {
                return e;
            }
            return null;
        })();
        expect(err).not.toBeNull();
        const msg = err.message;
        // The available list should be sorted
        const idx_alpha = msg.indexOf('alpha');
        const idx_mango = msg.indexOf('mango');
        const idx_zebra = msg.indexOf('zebra');
        expect(idx_alpha).toBeGreaterThanOrEqual(0);
        expect(idx_mango).toBeGreaterThanOrEqual(0);
        expect(idx_zebra).toBeGreaterThanOrEqual(0);
        expect(idx_alpha).toBeLessThan(idx_mango);
        expect(idx_mango).toBeLessThan(idx_zebra);
    });

    it('throws for an empty string name when not a preset', () => {
        expect(() => toonConfigPreset('', PRESETS)).toThrow();
    });

    it('does not throw for a name that IS a preset key', () => {
        expect(() => toonConfigPreset('generic', PRESETS)).not.toThrow();
    });

    it('works with a custom presets record containing only one entry', () => {
        const single = { mypreset: defaultToonConfig() };
        expect(() => toonConfigPreset('mypreset', single)).not.toThrow();
        expect(() => toonConfigPreset('other', single)).toThrow(/"other"/);
    });

    it('works with an empty presets record — always throws', () => {
        expect(() => toonConfigPreset('generic', {})).toThrow();
    });
});

// ---------------------------------------------------------------------------
// Return value correctness
// ---------------------------------------------------------------------------

describe('toonConfigPreset — return value shape', () => {
    it('returned config has all required ToonConfig fields', () => {
        const config = toonConfigPreset('generic', PRESETS);
        expect(config).toHaveProperty('enabled');
        expect(config).toHaveProperty('preserve_rules');
        expect(config).toHaveProperty('encode_rules');
        expect(config).toHaveProperty('default_codec');
        expect(config).toHaveProperty('array');
        expect(config).toHaveProperty('string');
        expect(config).toHaveProperty('dedup');
        expect(config).toHaveProperty('bmx');
        expect(config).toHaveProperty('emit_markers');
        expect(config).toHaveProperty('emit_stats');
    });

    it('returned config is a plain JSON-serialisable object', () => {
        const config = toonConfigPreset('generic', PRESETS);
        expect(() => JSON.stringify(config)).not.toThrow();
        const parsed = JSON.parse(JSON.stringify(config));
        expect(parsed.enabled).toBe(config.enabled);
    });
});
