import { describe, expect, it } from 'vitest';
import { RelevanceRanker } from '../src/retrieval/ranking/ranker.ts';

function makeScoredTool(key, score, propertyCount = 0) {
  return {
    toolKey: key,
    toolMapping: {
      serverName: 'zenith',
      tool: {
        name: key,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: propertyCount }, (_, i) => [`p${i}`, { type: 'string' }])
          ),
        },
      },
    },
    score,
    tier: 'full',
  };
}

describe('RelevanceRanker', () => {
  const ranker = new RelevanceRanker();

  describe('basic sorting', () => {
    it('returns empty array for empty input', () => {
      expect(ranker.rank([])).toEqual([]);
    });

    it('returns single tool unchanged', () => {
      const tools = [makeScoredTool('alpha', 0.8)];
      const result = ranker.rank(tools);
      expect(result).toHaveLength(1);
      expect(result[0].toolKey).toBe('alpha');
    });

    it('sorts by score descending', () => {
      const tools = [
        makeScoredTool('low', 0.3),
        makeScoredTool('high', 0.9),
        makeScoredTool('mid', 0.6),
      ];
      const result = ranker.rank(tools);
      expect(result.map(t => t.toolKey)).toEqual(['high', 'mid', 'low']);
    });
  });

  describe('tie-breaking within score tolerance (0.05)', () => {
    it('breaks ties by specificity (more properties = higher priority)', () => {
      // All scores within 0.05 of each other = one tied group
      const tools = [
        makeScoredTool('simple', 0.80, 1),    // 1 property
        makeScoredTool('complex', 0.82, 5),   // 5 properties
        makeScoredTool('medium', 0.81, 3),    // 3 properties
      ];
      const result = ranker.rank(tools);
      // Should be sorted by specificity (descending) within the tied group
      expect(result[0].toolKey).toBe('complex');  // 5 props
      expect(result[1].toolKey).toBe('medium');   // 3 props
      expect(result[2].toolKey).toBe('simple');   // 1 prop
    });

    it('uses alphabetical order when specificity is equal', () => {
      const tools = [
        makeScoredTool('zebra', 0.80, 2),
        makeScoredTool('alpha', 0.80, 2),
        makeScoredTool('middle', 0.80, 2),
      ];
      const result = ranker.rank(tools);
      expect(result.map(t => t.toolKey)).toEqual(['alpha', 'middle', 'zebra']);
    });
  });

  describe('group boundary detection', () => {
    it('creates separate groups when score difference exceeds tolerance', () => {
      const tools = [
        makeScoredTool('high-simple', 0.9, 1),
        makeScoredTool('high-complex', 0.88, 5),
        // Gap > 0.05
        makeScoredTool('low-complex', 0.7, 10),
        makeScoredTool('low-simple', 0.68, 1),
      ];
      const result = ranker.rank(tools);
      // Group 1: high-complex (5 props) before high-simple (1 prop) by specificity
      expect(result[0].toolKey).toBe('high-complex');
      expect(result[1].toolKey).toBe('high-simple');
      // Group 2: low-complex (10 props) before low-simple (1 prop) by specificity
      expect(result[2].toolKey).toBe('low-complex');
      expect(result[3].toolKey).toBe('low-simple');
    });

    it('groupAnchor is set to first element score, not rolling average', () => {
      // Scores: 0.90, 0.87, 0.84, 0.81 — each within 0.05 of PREVIOUS
      // but 0.81 is NOT within 0.05 of anchor 0.90 → new group starts at 0.84
      // Actually: anchor is 0.90, 0.87 is within 0.05 of 0.90 (diff=0.03),
      // 0.84 is within 0.05 of 0.90 (diff=0.06) — NO, 0.06 > 0.05, so new group at 0.84
      const tools = [
        makeScoredTool('a', 0.90, 1),
        makeScoredTool('b', 0.87, 1),
        makeScoredTool('c', 0.84, 1),
        makeScoredTool('d', 0.81, 1),
      ];
      const result = ranker.rank(tools);
      // Group 1: anchor=0.90; 0.87 within tolerance (|0.90-0.87|=0.03 < 0.05)
      // 0.84: |0.90-0.84|=0.06 >= 0.05 → new group
      // Group 2: anchor=0.84; 0.81 within tolerance (|0.84-0.81|=0.03 < 0.05)
      // So groups: [a, b], [c, d]
      // Within each group, same specificity → alphabetical
      expect(result[0].toolKey).toBe('a');
      expect(result[1].toolKey).toBe('b');
      expect(result[2].toolKey).toBe('c');
      expect(result[3].toolKey).toBe('d');
    });
  });

  describe('edge cases', () => {
    it('handles tools with no inputSchema properties', () => {
      const noSchema = {
        toolKey: 'bare',
        toolMapping: { serverName: 'zenith', tool: { name: 'bare', inputSchema: {} } },
        score: 0.5,
        tier: 'full',
      };
      const result = ranker.rank([noSchema]);
      expect(result[0].toolKey).toBe('bare');
    });

    it('handles tools with null inputSchema', () => {
      const nullSchema = {
        toolKey: 'null-schema',
        toolMapping: { serverName: 'zenith', tool: { name: 'null-schema', inputSchema: null } },
        score: 0.5,
        tier: 'full',
      };
      const result = ranker.rank([nullSchema]);
      expect(result[0].toolKey).toBe('null-schema');
    });

    it('does not mutate the input array', () => {
      const tools = [
        makeScoredTool('b', 0.5),
        makeScoredTool('a', 0.9),
      ];
      const original = [...tools];
      ranker.rank(tools);
      expect(tools).toEqual(original);
    });

    it('handles all tools at score 0', () => {
      const tools = [
        makeScoredTool('x', 0, 3),
        makeScoredTool('y', 0, 1),
        makeScoredTool('z', 0, 5),
      ];
      const result = ranker.rank(tools);
      // All in one group (all within tolerance of anchor 0), sorted by specificity
      expect(result[0].toolKey).toBe('z');  // 5 props
      expect(result[1].toolKey).toBe('x');  // 3 props
      expect(result[2].toolKey).toBe('y');  // 1 prop
    });

    it('handles exactly-at-tolerance boundary (0.05 difference)', () => {
      // |0.80 - 0.75| = 0.05 which is NOT < 0.05, so separate groups
      const tools = [
        makeScoredTool('high', 0.80, 1),
        makeScoredTool('low', 0.75, 10),
      ];
      const result = ranker.rank(tools);
      // Separate groups since diff == 0.05 (not strictly less than)
      expect(result[0].toolKey).toBe('high');
      expect(result[1].toolKey).toBe('low');
    });

    it('handles just-under-tolerance boundary (0.049 difference)', () => {
      // |0.80 - 0.751| = 0.049 which IS < 0.05, so same group
      const tools = [
        makeScoredTool('high', 0.80, 1),
        makeScoredTool('low', 0.751, 10),
      ];
      const result = ranker.rank(tools);
      // Same group → sorted by specificity: low (10) before high (1)
      expect(result[0].toolKey).toBe('low');
      expect(result[1].toolKey).toBe('high');
    });
  });
});
