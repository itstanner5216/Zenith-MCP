import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

function assertRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readJsonc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};

  const text = readFileSync(path, "utf-8");
  const errors: ParseError[] = [];
  const data = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const formatted = errors
      .map((e) => `${printParseErrorCode(e.error)}@${e.offset}`)
      .join(", ");
    throw new Error(`Invalid JSONC in ${path}: ${formatted}`);
  }

  return assertRecord(data);
}

export function writeJsonc(
  path: string,
  data: Record<string, unknown>,
): void {
  // Note: this writer produces valid JSONC (subset of JSON). It does NOT preserve
  // comments or original formatting from a pre-existing file — that would require
  // per-key modify edits against the parsed prior state, which is out of scope.
  // Callers wanting comment preservation should use a dedicated edit pipeline.
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
