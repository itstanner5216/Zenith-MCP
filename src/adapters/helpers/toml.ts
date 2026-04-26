import { readFileSync, writeFileSync, existsSync } from "fs";
import TOML from "@iarna/toml";

export function readToml(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }
  return TOML.parse(readFileSync(path, "utf-8")) as Record<string, any>;
}

export function writeToml(path: string, data: Record<string, any>): void {
  writeFileSync(path, TOML.stringify(data), "utf-8");
}
