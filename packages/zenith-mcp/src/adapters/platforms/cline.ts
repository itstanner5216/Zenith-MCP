import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

const EXTENSION_STORAGE = "saoudrizwan.claude-dev";

class ClineAdapter extends MCPConfigAdapter {
  toolName = "cline";
  displayName = "Cline";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private vscodePath() {
    const plat = platform();
    let base: string;
    if (plat === "darwin") {
      base = join(homedir(), "Library", "Application Support");
    } else if (plat === "win32") {
      base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    } else {
      base = join(homedir(), ".config");
    }
    return join(base, "Code", "User", "globalStorage", EXTENSION_STORAGE, "settings", "cline_mcp_settings.json");
  }

  private cliPath() {
    return join(homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
  }

  configPath() {
    const vscode = this.vscodePath();
    if (existsSync(vscode)) return vscode;
    return this.cliPath();
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
    return this.readConfig().mcpServers ?? {};
  }
}

export const adapter = new ClineAdapter();
