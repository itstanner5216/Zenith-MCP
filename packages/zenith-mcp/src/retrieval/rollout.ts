/**
 * Deterministic canary session assignment for gradual BMXF rollout.
 *
 * Session assignment is hash-based: same session_id always maps to the
 * same canary/control group. This enables consistent per-session behavior
 * and reproducible metric analysis.
 */
import { createHash } from "node:crypto";
import type { RetrievalConfig } from "./models.js";

export function isCanarySession(sessionId: string, canaryPercentage: number): boolean {
  if (canaryPercentage <= 0.0) return false;
  if (canaryPercentage >= 100.0) return true;
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;
  return bucket < canaryPercentage;
}

export function getSessionGroup(sessionId: string, config: RetrievalConfig): "canary" | "control" {
  if (config.rolloutStage === "shadow") return "control";
  if (config.rolloutStage === "ga") return "canary";
  return isCanarySession(sessionId, config.canaryPercentage) ? "canary" : "control";
}

