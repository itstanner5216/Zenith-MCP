import { join, win32 } from "path";
import { homedir, platform } from "os";
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";

export abstract class MCPConfigAdapter {
  abstract toolName: string;
  abstract displayName: string;
  abstract configFormat: "json" | "toml" | "yaml" | "json5";
  abstract supportedPlatforms: ("macos" | "linux" | "windows")[];

  backupDir?: string;

  isSupported(): boolean {
    const plat = platform();
    const mapped = plat === "darwin" ? "macos" : plat === "win32" ? "windows" : "linux";
    return this.supportedPlatforms.includes(mapped as any);
  }

  protected backup(filePath: string): void {
    if (!existsSync(filePath)) return;
    const dir = this.backupDir ?? join(filePath, "..");
    const baseName = win32.basename(filePath);
    const name = this.backupDir
      ? `${this.toolName}_${baseName}.bak`
      : `${baseName}.bak`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(filePath, join(dir, name));
  }

  abstract configPath(): string | null;
  abstract readConfig(): Record<string, any>;
  abstract writeConfig(data: Record<string, any>): void;
  abstract registerServer(name: string, config: Record<string, any>): void;
  abstract discoverServers(): Record<string, Record<string, any>>;
}
