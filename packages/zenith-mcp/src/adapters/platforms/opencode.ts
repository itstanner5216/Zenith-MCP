import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class OpenCodeAdapter extends MCPConfigAdapter {
  toolName = "opencode";
  displayName = "OpenCode";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private userConfigPath() {
    const plat = platform();
    if (plat === "win32") {
      const appdata = process.env.APPDATA;
      if (appdata) return join(appdata, "opencode", "opencode.jsonc");
      return join(homedir(), "AppData", "Roaming", "opencode", "opencode.jsonc");
    }
    return join(homedir(), ".config", "opencode", "opencode.json");
  }

  configPath() {
    const project = join(process.cwd(), "opencode.json");
    if (existsSync(project)) return project;
    return this.userConfigPath();
  }

  private stripJsoncComments(content: string): string {
    content = content.replace(/\/\/.*?$/gm, "");
    content = content.replace(/\/\*[\s\S]*?\*\//g, "");
    content = content.replace(/,(\s*[}\]])/g, "$1");
    return content;
  }

  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    const content = readFileSync(p, "utf-8");

    const isJsonc = p.endsWith(".jsonc") || content.includes("//") || content.includes("/*");
    const cleanContent = isJsonc ? this.stripJsoncComments(content) : content;

    return JSON.parse(cleanContent);
  }

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    if (!data.mcp) data.mcp = {};
    data.mcp[name] = config;
    this.writeConfig(data);
  }

  discoverServers() {
    return this.readConfig().mcp ?? {};
  }
}

export const adapter = new OpenCodeAdapter();
