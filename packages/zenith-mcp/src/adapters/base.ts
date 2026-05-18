import { basename, dirname, join } from "node:path";
import { platform } from "node:os";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

export abstract class MCPConfigAdapter {
  abstract toolName: string;
  abstract displayName: string;
  abstract configFormat: "json" | "jsonc" | "toml" | "yaml" | "json5";
  abstract supportedPlatforms: ("macos" | "linux" | "windows")[];

  backupDir?: string;

  isSupported(): boolean {
    const plat = platform();
    let mapped: "macos" | "linux" | "windows";
    if (plat === "darwin") {
      mapped = "macos";
    } else if (plat === "win32") {
      mapped = "windows";
    } else if (plat === "linux") {
      mapped = "linux";
    } else {
      return false;
    }
    return this.supportedPlatforms.includes(mapped);
  }

  protected ensureParentDir(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  protected backup(filePath: string): void {
    if (!existsSync(filePath)) return;
    const dir = this.backupDir ?? dirname(filePath);
    const baseName = basename(filePath);
    const name = this.backupDir
      ? `${this.toolName}_${baseName}.bak`
      : `${baseName}.bak`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(filePath, join(dir, name));
  }

  abstract configPath(): string | null;
  abstract readConfig(): Record<string, unknown>;
  abstract writeConfig(data: Record<string, unknown>): void;
  abstract registerServer(name: string, config: Record<string, unknown>): void;
  abstract discoverServers(): Record<string, Record<string, unknown>>;
}
