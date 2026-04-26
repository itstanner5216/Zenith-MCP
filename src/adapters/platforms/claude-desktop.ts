import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class ClaudeDesktopAdapter extends MCPConfigAdapter {
  toolName = "claude_desktop";
  displayName = "Claude Desktop";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  configPath() {
    const plat = platform();
    if (plat === "darwin") {
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }
    if (plat === "win32") {
      const appdata = process.env.APPDATA || "";
      return join(appdata, "Claude", "claude_desktop_config.json");
    }
    return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }

  private claudeCodePaths() {
    const plat = platform();
    if (plat === "win32") {
      const userprofile = process.env.USERPROFILE;
      const base = userprofile ? join(userprofile) : homedir();
      return [join(base, ".claude.json")];
    }
    return [
      join(homedir(), ".claude.json"),
      join(homedir(), ".claude", "settings.json"),
    ];
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
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[name] = config;
    this.writeConfig(data);
  }

  discoverServers() {
    const result: Record<string, Record<string, any>> = (this.readConfig().mcpServers || {}) as Record<string, Record<string, any>>;

    for (const path of this.claudeCodePaths()) {
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (typeof data === "object" && data !== null) {
          const mcpServers = data.mcpServers;
          if (typeof mcpServers === "object" && mcpServers !== null) {
            for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
              if (serverName in result) {
                console.warn(`Server '${serverName}' from Claude Code config (${path}) overwrites entry from Claude Desktop config`);
              }
              result[serverName] = serverConfig as Record<string, any>;
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === "SyntaxError") {
          console.error(`Failed to parse Claude Code config at ${path}: ${e}`);
        } else {
          console.error(`Failed to read Claude Code config at ${path}: ${e}`);
        }
      }
    }

    return result;
  }
}

export const adapter = new ClaudeDesktopAdapter();
