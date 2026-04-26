import { dirname, join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";
import { readJson5, writeJson5 } from "../helpers/json5.js";

class OpenClawAdapter extends MCPConfigAdapter {
  toolName = "openclaw";
  displayName = "OpenClaw";
  configFormat = "json5" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private resolvePath() {
    return join(homedir(), ".openclaw", "openclaw.json");
  }

  configPath() {
    return this.resolvePath();
  }

  readConfig() {
    const p = this.resolvePath();
    if (!existsSync(p)) return {};
    return readJson5(p);
  }

  writeConfig(data: Record<string, any>) {
    const p = this.resolvePath();
    this.backup(p);
    mkdirSync(dirname(p), { recursive: true });
    writeJson5(p, data);
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[name] = config;
    this.writeConfig(data);
  }

  discoverServers() {
    return this.readConfig().mcpServers ?? {};
  }
}

export const adapter = new OpenClawAdapter();
