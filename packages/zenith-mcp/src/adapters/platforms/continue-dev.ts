import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";
import { readYaml, writeYaml } from "../helpers/yaml.js";

class ContinueDevAdapter extends MCPConfigAdapter {
  toolName = "continue_dev";
  displayName = "Continue.dev";
  configFormat = "yaml" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  configPath() {
    const plat = platform();
    if (plat === "win32") {
      const userprofile = process.env.USERPROFILE;
      const base = userprofile ? join(userprofile) : homedir();
      return join(base, ".continue", "config.yaml");
    }
    return join(homedir(), ".continue", "config.yaml");
  }

  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    return readYaml(p);
  }

  writeConfig(data: Record<string, unknown>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeYaml(p, data);
  }

  registerServer(name: string, config: Record<string, unknown>) {
    const data = this.readConfig();
    const raw = data.mcpServers;
    const servers: Record<string, unknown>[] = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

    const filtered = servers.filter(s => !(typeof s === "object" && s !== null && (s as Record<string, unknown>).name === name));

    const entry: Record<string, unknown> = { ...config, name };
    filtered.push(entry);
    data.mcpServers = filtered;
    this.writeConfig(data);
  }

  discoverServers(): Record<string, Record<string, unknown>> {
    const raw = this.readConfig().mcpServers;
    const serversList: Record<string, unknown>[] = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    const result: Record<string, Record<string, unknown>> = {};
    for (const s of serversList) {
      if (typeof s === "object" && s !== null && "name" in s) {
        const { name, ...rest } = s as Record<string, unknown>;
        result[name as string] = rest;
      }
    }
    return result;
  }
}

export const adapter = new ContinueDevAdapter();
