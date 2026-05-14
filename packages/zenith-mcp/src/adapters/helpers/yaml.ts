import { readFileSync, writeFileSync, existsSync } from "fs";
import YAML from "js-yaml";

export function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  return YAML.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

export function writeYaml(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, YAML.dump(data), "utf-8");
}
