import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class ZedAdapter extends MCPConfigAdapter {
  toolName = "zed";
  displayName = "Zed";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private getAppdataPath() {
    const appdata = process.env.APPDATA;
    if (appdata) return appdata;
    return join(homedir(), "AppData", "Roaming");
  }

  configPath() {
    const plat = platform();
    if (plat === "darwin") {
      return join(homedir(), ".zed", "settings.json");
    }
    if (plat === "win32") {
      return join(this.getAppdataPath(), "Zed", "settings.json");
    }
    return join(homedir(), ".config", "zed", "settings.json");
  }

  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    if (!data.context_servers) data.context_servers = {};
    data.context_servers[name] = config;
    this.writeConfig(data);
  }

  discoverServers() {
    return this.readConfig().context_servers ?? {};
  }
}

export const adapter = new ZedAdapter();
