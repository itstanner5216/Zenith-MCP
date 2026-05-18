import { join } from "path";
import { homedir, platform } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { MCPConfigAdapter } from "../base.js";

class WarpAdapter extends MCPConfigAdapter {
  toolName = "warp";
  displayName = "Warp Terminal";
  configFormat = "json" as const;
  supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux", "windows"];

  /**
   * Returns the Warp MCP config location.
   *
   * On macOS and Windows: returns a DIRECTORY path. Each MCP server has its own
   * JSON file in that directory. Use `_isDirMode()` to check.
   *
   * On Linux: returns a single JSON FILE path containing all servers.
   *
   * Both `readConfig()` and `discoverServers()` handle both modes internally.
   */
  configPath() {
    const plat = platform();
    if (plat === "darwin") {
      return join(
        homedir(),
        "Library",
        "Group Containers",
        "2BBY89MBSN.dev.warp",
        "Library",
        "Application Support",
        "dev.warp.Warp-Stable",
        "mcp"
      );
    }
    if (plat === "win32") {
      const local = process.env.LOCALAPPDATA;
      const base = local ? join(local) : join(homedir(), "AppData", "Local");
      return join(base, "warp", "Warp", "data", "mcp");
    }
    return join(homedir(), ".config", "warp-terminal", "mcp_servers.json");
  }

  private _isDirMode() {
    const plat = platform();
    return plat === "darwin" || plat === "win32";
  }

  readConfig() {
    const p = this.configPath();
    if (!p) return {};

    if (this._isDirMode()) {
      if (!existsSync(p)) return {};
      const result: Record<string, Record<string, any>> = {};
      try {
        const files = readdirSync(p).filter(f => f.endsWith(".json")).sort();
        for (const file of files) {
          const fullPath = join(p, file);
          try {
            const data = JSON.parse(readFileSync(fullPath, "utf-8"));
            const name = file.replace(/\.json$/, "");
            result[name] = data;
          } catch (error) {
            console.warn(
              `Skipping invalid Warp MCP config ${fullPath}: ${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        console.warn(
          `Unable to read Warp MCP directory ${p}: ${(error as Error).message}`,
        );
      }
      return result;
    }

    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;

    if (this._isDirMode()) {
      mkdirSync(p, { recursive: true });
      for (const [name, cfg] of Object.entries(data)) {
        const dest = join(p, `${name}.json`);
        this.backup(dest);
        writeFileSync(dest, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      }
    } else {
      this.backup(p);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
    }
  }

  registerServer(name: string, config: Record<string, any>) {
    if (this._isDirMode()) {
      const p = this.configPath()!;
      mkdirSync(p, { recursive: true });
      const dest = join(p, `${name}.json`);
      this.backup(dest);
      writeFileSync(dest, JSON.stringify(config, null, 2) + "\n", "utf-8");
    } else {
      const data = this.readConfig();
      if (!data.mcpServers) data.mcpServers = {};
      data.mcpServers[name] = config;
      this.writeConfig(data);
    }
  }

  discoverServers() {
    if (this._isDirMode()) {
      return this.readConfig();
    }
    return this.readConfig().mcpServers ?? {};
  }
}

export const adapter = new WarpAdapter();
