/**
 * Relevance ranker with specificity-based tiebreaking.
 *
 * Ranks tools by score (descending) with most-specific-first tiebreaking
 * for tools with similar scores. Exploits LLM primacy bias (1.3-3.4x).
 */
import type { ScoredTool } from "../models.js";

const SCORE_TOLERANCE = 0.05;

function getSpecificity(scored: ScoredTool): number {
  const schema = scored.toolMapping.tool.inputSchema;
  if (typeof schema === "object" && schema !== null) {
    const props = (schema as Record<string, unknown>)["properties"];
    if (typeof props === "object" && props !== null) {
      return Object.keys(props).length;
    }
  }
  return 0;
}

function flushGroup(group: ScoredTool[], ranked: ScoredTool[]): void {
  group.sort((a, b) => {
    const sa = getSpecificity(a);
    const sb = getSpecificity(b);
    if (sb !== sa) return sb - sa;
    return a.toolKey.localeCompare(b.toolKey);
  });
  ranked.push(...group);
}

export class RelevanceRanker {
  rank(tools: ScoredTool[]): ScoredTool[] {
    if (tools.length === 0) return [];

    const byScore = [...tools].sort((a, b) => {
      if (b.score > a.score) return 1;
      if (b.score < a.score) return -1;
      return a.toolKey.localeCompare(b.toolKey);
    });

    const ranked: ScoredTool[] = [];
    let tiedGroup: ScoredTool[] = [];
    let groupAnchor: number | null = null;

    for (const tool of byScore) {
      if (groupAnchor === null || Math.abs(groupAnchor - tool.score) < SCORE_TOLERANCE) {
        tiedGroup.push(tool);
        if (groupAnchor === null) groupAnchor = tool.score;
        continue;
      }

      flushGroup(tiedGroup, ranked);
      tiedGroup = [tool];
      groupAnchor = tool.score;
    }

    flushGroup(tiedGroup, ranked);

    return ranked;
  }
}
