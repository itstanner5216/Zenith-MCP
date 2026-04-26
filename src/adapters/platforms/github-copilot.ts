import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class GitHubCopilotAdapter extends MCPConfigAdapter {
  toolName = "github_copilot";
  displayName = "GitHub Copilot CLI";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  configPath() {
    const plat = platform();
    if (plat === "win32") {
      const userprofile = process.env.USERPROFILE;
      const base = userprofile || homedir();
      return join(base, ".copilot", "mcp-config.json");
    }
    return join(homedir(), ".copilot", "mcp-config.json");
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

export const adapter = new GitHubCopilotAdapter();
