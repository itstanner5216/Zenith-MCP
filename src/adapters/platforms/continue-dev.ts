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

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeYaml(p, data);
  }

  registerServer(name: string, config: Record<string, any>) {
    const data = this.readConfig();
    const servers: Record<string, any>[] = data.mcpServers || [];

    const filtered = servers.filter(s => !(typeof s === "object" && s !== null && s.name === name));

    const entry: Record<string, any> = { ...config, name };
    filtered.push(entry);
    data.mcpServers = filtered;
    this.writeConfig(data);
  }

  discoverServers() {
    const serversList: Record<string, any>[] = this.readConfig().mcpServers || [];
    const result: Record<string, Record<string, any>> = {};
    for (const s of serversList) {
      if (typeof s === "object" && s !== null && "name" in s) {
        const { name, ...rest } = s;
        result[name as string] = rest;
      }
    }
    return result;
  }
}

export const adapter = new ContinueDevAdapter();
