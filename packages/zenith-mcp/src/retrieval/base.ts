/**
 * Abstract base classes for retrieval pipeline components.
 */
import type { RetrievalContext, ScoredTool, ToolMapping } from "./models.js";

export abstract class ToolRetriever {
  /**
   * Score and filter candidate tools based on context.
   *
   * Implementations MUST NOT modify tool_to_server — read-only consumers.
   * Returns scored subset ordered by relevance.
   */
  abstract retrieve(
    context: RetrievalContext,
    candidates: ToolMapping[],
  ): Promise<ScoredTool[]>;
}

export class PassthroughRetriever extends ToolRetriever {
  override async retrieve(
    _context: RetrievalContext,
    candidates: ToolMapping[],
  ): Promise<ScoredTool[]> {
    return candidates.map((m, i) => ({
      toolKey: `passthrough_${i}`,
      toolMapping: m,
      score: 1.0,
      tier: "full" as const,
    }));
  }
}

