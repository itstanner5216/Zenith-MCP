import { readFileSync, writeFileSync, existsSync } from "fs";
import YAML from "js-yaml";

export function readYaml(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }
  return YAML.load(readFileSync(path, "utf-8")) as Record<string, any>;
}

export function writeYaml(path: string, data: Record<string, any>): void {
  writeFileSync(path, YAML.dump(data), "utf-8");
}
