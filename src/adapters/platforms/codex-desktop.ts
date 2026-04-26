import { dirname, join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { MCPConfigAdapter } from "../base.js";
import { readToml, writeToml } from "../helpers/toml.js";

class CodexDesktopAdapter extends MCPConfigAdapter {
  toolName = "codex_desktop";
  displayName = "Codex Desktop";
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

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    mkdirSync(dirname(p), { recursive: true });
    this.backup(p);
    writeToml(p, data);
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    if (!data.mcp_servers) data.mcp_servers = {};
    data.mcp_servers[name] = config;
    this.writeConfig(data);
  }

  discoverServers() {
    return this.readConfig().mcp_servers ?? {};
  }
}

export const adapter = new CodexDesktopAdapter();
