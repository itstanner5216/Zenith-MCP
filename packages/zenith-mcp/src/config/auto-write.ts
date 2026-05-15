import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { configureRegistry, listAdapters } from "../adapters/registry.js";
import { backupFile } from "./backup.js";
import { expandTilde } from "./schema.js";
import type { ZenithConfig } from "./schema.js";

// Format helpers — these can read/write arbitrary file paths (unlike adapters
// which are locked to their own configPath).
import { readJson5, writeJson5 } from "../adapters/helpers/json5.js";
import { readToml, writeToml } from "../adapters/helpers/toml.js";
import { readYaml, writeYaml } from "../adapters/helpers/yaml.js";

// ---------------------------------------------------------------------------
// The server entry that Zenith writes into each platform's MCP config
// ---------------------------------------------------------------------------

const zenithServerEntry: Record<string, unknown> = {
  command: "zenith-mcp",
  args: [],
};

// ---------------------------------------------------------------------------
// Supported MCP config extensions — used for directory scanning
// ---------------------------------------------------------------------------

const MCP_EXTENSIONS = new Set([".json", ".json5", ".toml", ".yaml", ".yml"]);

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AutoWriteResult {
  written: string[];
  skipped: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// autoWriteToMcpConfigs
// ---------------------------------------------------------------------------

export function autoWriteToMcpConfigs(config: ZenithConfig): AutoWriteResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  // 1. Initialise the adapter registry.
  const resolvedBackupDir = config.auto_write.backup_dir
    ? expandTilde(config.auto_write.backup_dir)
    : undefined;
  configureRegistry(resolvedBackupDir);

  // 2. Walk every known platform adapter.
  const adapters = listAdapters();

  for (const adapter of adapters) {
    // Platform not supported on this OS — silently skip.
    if (!adapter.isSupported()) {
      skipped.push(adapter.displayName);
      continue;
    }

    const cfgPath = adapter.configPath();

    // Config path is null (platform not installed) — silently skip.
    if (!cfgPath) {
      skipped.push(adapter.displayName);
      continue;
    }

    // Config file doesn't exist on disk — the platform may be installed but
    // hasn't been configured yet. We never create files that don't already
    // exist. Silently skip.
    if (!existsSync(cfgPath)) {
      skipped.push(adapter.displayName);
      continue;
    }

    // Cache the original file content in memory for rollback, even if the
    // user chose backup_mode "none".
    let originalContent: string;
    try {
      originalContent = readFileSync(cfgPath, "utf-8");
    } catch {
      errors.push(
        `Could not read ${cfgPath} (${adapter.displayName}). Skipped.`,
      );
      continue;
    }

    // Backup via the backup subsystem (respects the user's chosen mode).
    try {
      backupFile(
        cfgPath,
        config.auto_write.backup_mode,
        resolvedBackupDir,
      );
    } catch (backupErr) {
      // Backup failure is not fatal — the in-memory snapshot still protects.
      errors.push(
        `Backup failed for ${cfgPath} (${adapter.displayName}): ${(backupErr as Error).message}. Proceeding without backup.`,
      );
    }

    // Write the Zenith server entry via the adapter's read-modify-write flow.
    try {
      adapter.registerServer("zenith-mcp", zenithServerEntry);
      written.push(cfgPath);
    } catch {
      // Restore the original content immediately.
      try {
        writeFileSync(cfgPath, originalContent, "utf-8");
      } catch {
        // Restoration itself failed — nothing more we can do.
      }

      errors.push(
        `An error occurred when attempting to update ${cfgPath} (${adapter.displayName}) and will need manually configured. The configuration file remains unchanged.`,
      );
    }
  }

  // 3. Handle custom MCP paths — scan-and-verify approach.
  //    Each custom path can be a file or a directory.
  //    - File: verify it contains MCP config, write directly.
  //    - Directory: scan for MCP-compatible files (same directory only),
  //      verify each, write to verified ones.
  for (const rawCustomPath of config.auto_write.custom_mcp_paths) {
    const customPath = expandTilde(rawCustomPath);
    if (!existsSync(customPath)) {
      skipped.push(customPath);
      continue;
    }

    let filesToCheck: string[];

    try {
      const stat = statSync(customPath);
      if (stat.isDirectory()) {
        // Scan the directory for MCP-compatible files — same directory only,
        // never recurse up or down.
        filesToCheck = scanDirectoryForMcpFiles(customPath);
      } else {
        // It's a specific file — check it directly.
        filesToCheck = [customPath];
      }
    } catch {
      errors.push(`Could not access custom path ${customPath}. Skipped.`);
      continue;
    }

    for (const filePath of filesToCheck) {
      const result = verifyAndWriteMcpConfig(
        filePath,
        config.auto_write.backup_mode,
        resolvedBackupDir,
      );

      if (result.status === "written") {
        written.push(filePath);
      } else if (result.status === "skipped") {
        skipped.push(filePath);
      } else {
        errors.push(result.message);
      }
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// scanDirectoryForMcpFiles — find MCP-compatible files in a single directory
// ---------------------------------------------------------------------------

function scanDirectoryForMcpFiles(dirPath: string): string[] {
  const candidates: string[] = [];

  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (MCP_EXTENSIONS.has(ext)) {
        const fullPath = join(dirPath, entry);
        try {
          if (statSync(fullPath).isFile()) {
            candidates.push(fullPath);
          }
        } catch {
          // Can't stat — skip this entry.
        }
      }
    }
  } catch {
    // Can't read directory — return empty.
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// verifyAndWriteMcpConfig — read a file, check for MCP structure, write entry
// ---------------------------------------------------------------------------

type FormatReader = (path: string) => Record<string, unknown>;
type FormatWriter = (path: string, data: Record<string, unknown>) => void;

interface FormatHandler {
  read: FormatReader;
  write: FormatWriter;
}

function getFormatHandler(filePath: string): FormatHandler | null {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case ".json":
      return {
        read: (p) => {
          const content = readFileSync(p, "utf-8");
          return JSON.parse(content) as Record<string, unknown>;
        },
        write: (p, data) => {
          writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
        },
      };
    case ".json5":
      return { read: readJson5, write: writeJson5 };
    case ".toml":
      return { read: readToml, write: writeToml };
    case ".yaml":
    case ".yml":
      return { read: readYaml, write: writeYaml };
    default:
      return null;
  }
}

/**
 * Check if parsed data looks like an MCP configuration file.
 * The universal indicator is a top-level `mcpServers` key.
 */
function isMcpConfig(data: Record<string, unknown>): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "mcpServers" in data &&
    typeof data.mcpServers === "object" &&
    data.mcpServers !== null
  );
}

function verifyAndWriteMcpConfig(
  filePath: string,
  backupMode: "file" | "sqlite" | "none",
  backupDir?: string,
): { status: "written" | "skipped" | "error"; message: string } {
  // Determine the format handler from extension.
  const handler = getFormatHandler(filePath);
  if (!handler) {
    return { status: "skipped", message: `Unsupported format: ${filePath}` };
  }

  // Read and parse the file.
  let data: Record<string, unknown>;
  try {
    data = handler.read(filePath);
  } catch {
    return {
      status: "error",
      message: `Could not parse ${filePath}. Skipped.`,
    };
  }

  // Verify this is actually an MCP config file.
  if (!isMcpConfig(data)) {
    return {
      status: "skipped",
      message: `${filePath} does not contain MCP configuration.`,
    };
  }

  // Cache original content for rollback.
  let originalContent: string;
  try {
    originalContent = readFileSync(filePath, "utf-8");
  } catch {
    return {
      status: "error",
      message: `Could not read ${filePath} for backup. Skipped.`,
    };
  }

  // Backup.
  try {
    backupFile(filePath, backupMode, backupDir || undefined);
  } catch {
    // Non-fatal — in-memory snapshot still protects.
  }

  // Add the Zenith entry and write back.
  try {
    const mcpServers = data.mcpServers as Record<string, unknown>;
    mcpServers["zenith-mcp"] = zenithServerEntry;
    handler.write(filePath, data);
    return { status: "written", message: filePath };
  } catch {
    // Restore original content.
    try {
      writeFileSync(filePath, originalContent, "utf-8");
    } catch {
      // Restoration failed.
    }
    return {
      status: "error",
      message: `An error occurred when attempting to update ${filePath} and will need manually configured. The configuration file remains unchanged.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Summary message helpers
// ---------------------------------------------------------------------------

export function formatAutoWriteSummary(result: AutoWriteResult): string {
  const total = result.written.length + result.errors.length;

  if (result.errors.length === 0 && result.written.length > 0) {
    return `All configurations updated as expected. Backups saved to the configured backup directory.`;
  }

  const firstError = result.errors[0];
  if (firstError !== undefined) {
    const failedPathMatch = firstError.match(/update (.+?)(?:\s+\(| and)/);
    const failedPath = failedPathMatch?.[1] ?? "unknown path";

    return `${result.written.length}/${total} MCP configurations updated. An error occurred when attempting to update ${failedPath} and will need manually configured. The configuration file remains unchanged.`;
  }

  return "No MCP configurations found to update.";
}
