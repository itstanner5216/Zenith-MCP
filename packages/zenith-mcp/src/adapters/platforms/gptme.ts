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

  writeConfig(data: Record<string, unknown>) {
    const p = this.configPath()!;
    mkdirSync(dirname(p), { recursive: true });
    this.backup(p);
    writeToml(p, data);
  }

  registerServer(name: string, config: Record<string, unknown>) {
    const data = this.readConfig();
    if (!data.mcp || typeof data.mcp !== "object") data.mcp = {};
    const mcpObj = data.mcp as Record<string, unknown>;
    const rawServers = mcpObj.servers;
    const servers: Record<string, unknown>[] = Array.isArray(rawServers) ? (rawServers as Record<string, unknown>[]) : [];

    const filtered = servers.filter(s => typeof s === "object" && s !== null && (s as Record<string, unknown>).name !== name);
    filtered.push({ name, ...config });
    mcpObj.servers = filtered;
    this.writeConfig(data);
  }

  discoverServers(): Record<string, Record<string, unknown>> {
    const data = this.readConfig();
    const mcpVal = data.mcp;
    let rawServers: unknown = undefined;
    if (mcpVal && typeof mcpVal === "object" && !Array.isArray(mcpVal)) {
      rawServers = (mcpVal as Record<string, unknown>).servers;
    }
    const serversList: Record<string, unknown>[] = Array.isArray(rawServers) ? (rawServers as Record<string, unknown>[]) : [];
    const result: Record<string, Record<string, unknown>> = {};
    for (const s of serversList) {
      if (typeof s === "object" && s !== null && "name" in s) {
        const { name, ...rest } = s as Record<string, unknown>;
        if (typeof name === "string") {
          result[name] = rest;
        }
      }
    }
    return result;
  }
}

export const adapter = new GptmeAdapter();
