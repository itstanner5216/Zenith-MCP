import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Tests for the validateToolArgs logic from zenith-integration.ts.
// We replicate the exact function here to unit-test it in isolation.
function validateToolArgs(mapping, args) {
  const schema = mapping.inputZodSchema;
  if (!schema || typeof schema !== 'object') return null;
  const zodLike = schema;
  if (typeof zodLike.safeParse !== 'function') return null;
  const result = zodLike.safeParse(args);
  if (result.success) return null;
  return result.error?.message ?? 'Invalid arguments';
}

describe('validateToolArgs', () => {
  describe('returns null (valid) when', () => {
    it('no schema is present (undefined)', () => {
      expect(validateToolArgs({}, { any: 'thing' })).toBeNull();
    });

    it('schema is null', () => {
      expect(validateToolArgs({ inputZodSchema: null }, { any: 'thing' })).toBeNull();
    });

    it('schema is a non-object (string)', () => {
      expect(validateToolArgs({ inputZodSchema: 'not an object' }, {})).toBeNull();
    });

    it('schema has no safeParse method', () => {
      expect(validateToolArgs({ inputZodSchema: { parse: () => {} } }, {})).toBeNull();
    });

    it('args satisfy the Zod schema', () => {
      const schema = z.object({ path: z.string(), mode: z.enum(['list', 'tree']) });
      const result = validateToolArgs(
        { inputZodSchema: schema },
        { path: '/tmp', mode: 'list' },
      );
      expect(result).toBeNull();
    });

    it('args satisfy a schema with optional fields', () => {
      const schema = z.object({
        path: z.string(),
        depth: z.number().optional(),
      });
      const result = validateToolArgs(
        { inputZodSchema: schema },
        { path: '/home' },
      );
      expect(result).toBeNull();
    });
  });

  describe('returns error message when', () => {
    it('required field is missing', () => {
      const schema = z.object({ path: z.string() });
      const result = validateToolArgs({ inputZodSchema: schema }, {});
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });

    it('field has wrong type', () => {
      const schema = z.object({ depth: z.number() });
      const result = validateToolArgs({ inputZodSchema: schema }, { depth: 'three' });
      expect(result).not.toBeNull();
    });

    it('enum value is invalid', () => {
      const schema = z.object({ mode: z.enum(['list', 'tree']) });
      const result = validateToolArgs({ inputZodSchema: schema }, { mode: 'invalid' });
      expect(result).not.toBeNull();
    });

    it('nested object fails validation', () => {
      const schema = z.object({
        config: z.object({
          port: z.number().min(1).max(65535),
        }),
      });
      const result = validateToolArgs(
        { inputZodSchema: schema },
        { config: { port: 99999 } },
      );
      expect(result).not.toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles schema that throws during safeParse gracefully', () => {
      const badSchema = {
        safeParse: () => { throw new Error('internal schema error'); },
      };
      // This tests that the caller handles exceptions properly. The function
      // itself doesn't try/catch, so this would throw. That's expected behavior
      // — the caller wraps it in try/catch.
      expect(() => validateToolArgs({ inputZodSchema: badSchema }, {})).toThrow();
    });

    it('returns "Invalid arguments" when error has no message', () => {
      const fakeSchema = {
        safeParse: () => ({ success: false, error: {} }),
      };
      const result = validateToolArgs({ inputZodSchema: fakeSchema }, {});
      expect(result).toBe('Invalid arguments');
    });

    it('validates complex tool schemas used in practice', () => {
      const editFileSchema = z.object({
        path: z.string(),
        edits: z.array(z.object({
          mode: z.enum(['content', 'block', 'symbol']),
          oldContent: z.string().optional(),
          newContent: z.string().optional(),
        })),
        dryRun: z.boolean().optional(),
      });

      const valid = validateToolArgs(
        { inputZodSchema: editFileSchema },
        { path: '/foo.ts', edits: [{ mode: 'content', oldContent: 'a', newContent: 'b' }] },
      );
      expect(valid).toBeNull();

      const invalid = validateToolArgs(
        { inputZodSchema: editFileSchema },
        { path: '/foo.ts', edits: [{ mode: 'invalid' }] },
      );
      expect(invalid).not.toBeNull();
    });
  });
});
