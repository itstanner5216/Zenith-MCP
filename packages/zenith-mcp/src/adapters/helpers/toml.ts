import { readFileSync, writeFileSync, existsSync } from "fs";
import TOML from "@iarna/toml";
import type { JsonMap } from "@iarna/toml";

export function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  return TOML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

export function writeToml(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, TOML.stringify(data as JsonMap), "utf-8");
}
