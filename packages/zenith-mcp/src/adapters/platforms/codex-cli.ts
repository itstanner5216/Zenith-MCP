import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { MCPConfigAdapter } from "../base.js";
import { readToml, writeToml } from "../helpers/toml.js";

class CodexCLIAdapter extends MCPConfigAdapter {
  toolName = "codex_cli";
  displayName = "Codex CLI";
  configFormat = "toml" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  configPath() {
    return join(homedir(), ".codex", "config.toml");
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
    if (!data.mcp_servers || typeof data.mcp_servers !== "object") data.mcp_servers = {};
    (data.mcp_servers as Record<string, unknown>)[name] = config;
    this.writeConfig(data);
  }

  discoverServers(): Record<string, Record<string, unknown>> {
    const data = this.readConfig();
    const servers = data.mcp_servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, Record<string, unknown>>;
    }
    return {};
  }
}

export const adapter = new CodexCLIAdapter();
