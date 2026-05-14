/**
 * Keyword matching utilities for trigger-based activation.
 * Converted from src/zenithmcp/utils/keyword_matcher.py
 */

export function extractKeywordsFromMessage(message: unknown): string {
  const parts: string[] = [];

  function walk(obj: unknown): void {
    if (typeof obj === "string") {
      parts.push(obj);
    } else if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
    } else if (obj !== null && typeof obj === "object") {
      for (const value of Object.values(obj as Record<string, unknown>)) {
        walk(value);
      }
    }
  }

  walk(message);
  return parts.join(" ");
}

export function matchTriggers(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase();
  for (const trigger of triggers) {
    if (lower.includes(trigger.toLowerCase())) return true;
  }
  return false;
}

