import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { MCPConfigAdapter } from "../base.js";
import { readToml, writeToml } from "../helpers/toml.js";

class GptmeAdapter extends MCPConfigAdapter {
  toolName = "gptme";
  displayName = "gptme";
  configFormat = "toml" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  configPath() {
    return join(homedir(), ".config", "gptme", "config.toml");
  }

  readConfig() {
    const p = this.configPath();
    if (!p) return {};
    return readToml(p);
  }

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    mkdirSync(dirname(p), { recursive: true });
    this.backup(p);
    writeToml(p, data);
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    if (!data.mcp) data.mcp = {};
    const servers: Record<string, any>[] = data.mcp.servers || [];

    const filtered = servers.filter(s => s.name !== name);
    filtered.push({ name, ...config });
    data.mcp.servers = filtered;
    this.writeConfig(data);
  }

  discoverServers() {
    const serversList: Record<string, any>[] = this.readConfig().mcp?.servers || [];
    const result: Record<string, Record<string, any>> = {};
    for (const s of serversList) {
      if (s.name) {
        const { name, ...rest } = s;
        result[name] = rest;
      }
    }
    return result;
  }
}

export const adapter = new GptmeAdapter();
