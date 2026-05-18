import { join, dirname } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class JetBrainsAdapter extends MCPConfigAdapter {
  toolName = "jetbrains";
  displayName = "JetBrains IDEs";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  private globalConfigPath() {
    const plat = platform();
    if (plat === "win32") {
      const userprofile = process.env.USERPROFILE;
      const base = userprofile || homedir();
      return join(base, ".junie", "mcp", "mcp.json");
    }
    return join(homedir(), ".junie", "mcp", "mcp.json");
  }

  private projectConfigPaths() {
    const paths: string[] = [];
    let current = process.cwd();
    while (true) {
      paths.push(join(current, ".junie", "mcp", "mcp.json"));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return paths;
  }

  private configPaths() {
    const paths = [this.globalConfigPath(), ...this.projectConfigPaths().reverse()];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      unique.push(path);
    }
    return unique;
  }

  configPath() {
    return this.globalConfigPath();
  }

  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
      return data;
    } catch (e) {
      console.error(`Failed to read JetBrains config at ${p}: ${e}`);
      throw e;
    }
  }

  writeConfig(data: Record<string, unknown>) {
    const p = this.configPath();
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }

  registerServer(name: string, config: Record<string, unknown>) {
    const data = this.readConfig() as Record<string, unknown>;
    const servers =
      typeof data.mcpServers === "object" &&
      data.mcpServers !== null &&
      !Array.isArray(data.mcpServers)
        ? (data.mcpServers as Record<string, unknown>)
        : {};
    servers[name] = config;
    data.mcpServers = servers;
    this.writeConfig(data);
  }

  discoverServers() {
    const result: Record<string, Record<string, unknown>> = {};
    const errors: { path: string; message: string }[] = [];
    let attempted = 0;

    for (const p of this.configPaths()) {
      if (!existsSync(p)) continue;
      attempted++;
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
        const servers = (data as Record<string, unknown>).mcpServers;
        if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
          Object.assign(result, servers as Record<string, Record<string, unknown>>);
        }
      } catch (error) {
        const message = (error as Error).message;
        console.warn(`Skipping malformed JetBrains MCP config at ${p}: ${message}`);
        errors.push({ path: p, message });
      }
    }

    // If every attempted config failed to parse, surface the error rather than
    // silently returning an empty result — restores pre-PR rethrow behavior.
    if (attempted > 0 && errors.length === attempted && Object.keys(result).length === 0) {
      throw new Error(
        `All JetBrains MCP configs malformed (${errors.length} files): ${errors.map((e) => e.path).join(", ")}`,
      );
    }

    return result;
  }
}

export const adapter = new JetBrainsAdapter();
