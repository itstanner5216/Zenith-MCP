import { readFileSync, writeFileSync, existsSync } from "fs";
import JSON5 from "json5";

export function readJson5(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }
  return JSON5.parse(readFileSync(path, "utf-8")) as Record<string, any>;
}

export function writeJson5(path: string, data: Record<string, any>): void {
  writeFileSync(path, JSON5.stringify(data, null, 2) + "\n", "utf-8");
}
