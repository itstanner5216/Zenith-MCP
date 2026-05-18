import { join } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import { MCPConfigAdapter } from "../base.js";
import { readJsonc, writeJsonc } from "../helpers/jsonc.js";

class ZedAdapter extends MCPConfigAdapter {
  toolName = "zed";
  displayName = "Zed";
  configFormat = "jsonc" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private getAppdataPath() {
    const appdata = process.env.APPDATA;
    if (appdata) return appdata;
    return join(homedir(), "AppData", "Roaming");
  }

  configPath(): string {
    const plat = platform();
    if (plat === "darwin") {
      return join(homedir(), ".zed", "settings.json");
    }
    if (plat === "win32") {
      return join(this.getAppdataPath(), "Zed", "settings.json");
    }
    return join(homedir(), ".config", "zed", "settings.json");
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
    if (!data.context_servers) data.context_servers = {};
    (data.context_servers as Record<string, unknown>)[name] = config;
    this.writeConfig(data);
  }

  discoverServers(): Record<string, Record<string, unknown>> {
    const servers = this.readConfig().context_servers;
    return (servers && typeof servers === "object" && !Array.isArray(servers))
      ? (servers as Record<string, Record<string, unknown>>)
      : {};
  }
}

export const adapter = new ZedAdapter();
