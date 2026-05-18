import { readFileSync, writeFileSync, existsSync } from "fs";
import YAML from "js-yaml";

export function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};

  try {
    const parsed = YAML.load(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to read or parse YAML file ${path}: ${message}`);
    return {};
  }
}

export function writeYaml(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, YAML.dump(data), "utf-8");
}
