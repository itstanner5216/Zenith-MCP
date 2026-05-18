import { join } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import { MCPConfigAdapter } from "../base.js";
import { readJsonc, writeJsonc } from "../helpers/jsonc.js";

class OpenCodeAdapter extends MCPConfigAdapter {
  toolName = "opencode";
  displayName = "OpenCode";
  configFormat = "jsonc" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = [
    "macos",
    "linux",
    "windows",
  ];

  private userConfigPath(): string {
    const plat = platform();
    if (plat === "win32") {
      const appdata = process.env.APPDATA;
      if (appdata) return join(appdata, "opencode", "opencode.jsonc");
      return join(homedir(), "AppData", "Roaming", "opencode", "opencode.jsonc");
    }
    return join(homedir(), ".config", "opencode", "opencode.json");
  }

  configPath(): string {
    const project = join(process.cwd(), "opencode.json");
    if (existsSync(project)) return project;
    return this.userConfigPath();
  }

  readConfig(): Record<string, unknown> {
    const p = this.configPath();
    if (!existsSync(p)) return {};
    return readJsonc(p);
  }

  writeConfig(data: Record<string, unknown>): void {
    const p = this.configPath();
    this.ensureParentDir(p);
    writeJsonc(p, data);
  }

  registerServer(name: string, config: Record<string, unknown>): void {
    const data = this.readConfig();
    if (typeof data.mcp !== 'object' || data.mcp === null || Array.isArray(data.mcp)) {
      data.mcp = {};
    }
    (data.mcp as Record<string, unknown>)[name] = config;
    this.writeConfig(data);
  }

  discoverServers(): Record<string, Record<string, unknown>> {
    const mcp = this.readConfig().mcp;
    return (mcp && typeof mcp === "object" && !Array.isArray(mcp))
      ? (mcp as Record<string, Record<string, unknown>>)
      : {};
  }
}

export const adapter = new OpenCodeAdapter();
