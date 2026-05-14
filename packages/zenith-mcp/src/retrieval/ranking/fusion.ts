/**
 * Reciprocal Rank Fusion and alpha-decay blending for turn-by-turn tool ranking.
 */
import type { ScoredTool } from "../models.js";

export const RRF_K = 10;

export function weightedRrf(
  envRanked: ScoredTool[],
  convRanked: ScoredTool[],
  alpha: number,
): ScoredTool[] {
  if (envRanked.length === 0 && convRanked.length === 0) return [];

  const envRanks = new Map<string, number>();
  for (let i = 0; i < envRanked.length; i++) envRanks.set(envRanked[i].toolKey, i + 1);
  const convRanks = new Map<string, number>();
  for (let i = 0; i < convRanked.length; i++) convRanks.set(convRanked[i].toolKey, i + 1);

  const allKeys = new Set([...envRanks.keys(), ...convRanks.keys()]);

  const envMax = envRanked.length + 1;
  const convMax = convRanked.length + 1;

  const toolMap = new Map<string, ScoredTool["toolMapping"]>();
  for (const t of envRanked) toolMap.set(t.toolKey, t.toolMapping);
  for (const t of convRanked) toolMap.set(t.toolKey, t.toolMapping);

  const fused: ScoredTool[] = [];
  for (const key of allKeys) {
    const envR = envRanks.get(key) ?? envMax;
    const convR = convRanks.get(key) ?? convMax;
    const score = alpha / (RRF_K + envR) + (1 - alpha) / (RRF_K + convR);
    fused.push({
      toolKey: key,
      toolMapping: toolMap.get(key)!,
      score,
      tier: "full",
    });
  }

  fused.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 1e-9) return a.toolKey.localeCompare(b.toolKey);
    return b.score - a.score;
  });

  return fused;
}

export function computeAlpha(
  turn: number,
  workspaceConfidence: number,
  convConfidence: number,
  rootsChanged = false,
  explicitToolMention = false,
): number {
  let base = Math.max(0.15, 0.85 * Math.exp(-0.25 * turn));

  if (workspaceConfidence < 0.45) {
    base = Math.max(0.15, base - 0.2);
  }

  if (explicitToolMention && convConfidence >= 0.70) {
    base = 0.15;
  }

  if (rootsChanged) {
    base = Math.max(base, 0.80);
  }

  return base;
}

