/**
 * Config loader — reads, validates, and writes the Zenith-MCP config file.
 *
 * This module is the primary interface for the rest of the codebase to interact
 * with the on-disk config (~/.zenith-mcp/config).  It delegates parsing to
 * `parser.ts` and type conversion to `schema.ts`, adding file I/O, error
 * handling, and tool-discovery merging on top.
 *
 * Key guarantee: `loadConfig()` NEVER throws. It is called at server startup
 * and must always return a usable ZenithConfig, falling back to defaults on
 * any error.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfig, serializeConfig } from "./parser.js";
import type { RawConfig } from "./parser.js";
import { DEFAULT_CONFIG, CONFIG_PATH, configToRaw, rawToConfig } from "./schema.js";
import type { ZenithConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// configExists
// ---------------------------------------------------------------------------

/** Returns `true` when the config file is present on disk. */
export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load and parse the Zenith config file into a typed `ZenithConfig`.
 *
 * - If the file does not exist, returns a deep copy of `DEFAULT_CONFIG`.
 * - If any error occurs (read failure, parse failure, conversion failure),
 *   returns a deep copy of `DEFAULT_CONFIG` — this function never throws.
 */
export function loadConfig(): ZenithConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return structuredClone(DEFAULT_CONFIG);
    }

    const text = readFileSync(CONFIG_PATH, "utf-8");
    const raw: RawConfig = parseConfig(text);
    return rawToConfig(raw);
  } catch {
    // Swallow everything — startup must not fail because of a bad config.
    return structuredClone(DEFAULT_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

/**
 * Persist a `ZenithConfig` to disk at `CONFIG_PATH`.
 *
 * Creates the parent directory (`~/.zenith-mcp/`) if it does not already
 * exist.
 */
export function saveConfig(config: ZenithConfig): void {
  const raw: RawConfig = configToRaw(config);
  const text = serializeConfig(raw);

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, text, "utf-8");
}

// ---------------------------------------------------------------------------
// mergeToolsIntoConfig (legacy — kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Synchronise the config's `tools` map with the tools actually registered by
 * the MCP server.
 *
 * For each tool in `availableTools`:
 *   - If the tool already appears in `config.tools`, its current
 *     enabled/disabled state is preserved.
 *   - If the tool is new (not yet in config), it is added as **enabled**
 *     (`true`).
 *
 * Tools that exist in `config.tools` but are NOT in `availableTools` are
 * intentionally kept — they are harmless stale entries and may reappear if
 * a plugin is re-enabled later.
 *
 * Returns the updated config (mutates in place for convenience, but also
 * returns it so callers can chain).
 *
 * @deprecated Use `syncToolsWithConfig` + `patchToolsInConfig` instead —
 * this function only adds tools, never removes them, and its caller
 * (`saveConfig`) destroys comments/formatting.
 */
export function mergeToolsIntoConfig(
  config: ZenithConfig,
  availableTools: string[],
): ZenithConfig {
  for (const tool of availableTools) {
    if (!(tool in config.tools)) {
      config.tools[tool] = true;
    }
    // else: keep existing enabled/disabled state
  }

  return config;
}

// ---------------------------------------------------------------------------
// syncToolsWithConfig
// ---------------------------------------------------------------------------

/**
 * Sync the tools map with the actual registered tool set.
 *   - New tools are added as enabled.
 *   - Tools no longer in the registry are removed.
 *
 * Returns `{ config, changed }` so the caller knows whether to persist.
 */
export function syncToolsWithConfig(
  config: ZenithConfig,
  registeredToolNames: string[],
): { config: ZenithConfig; changed: boolean } {
  const registered = new Set(registeredToolNames);
  const existing = new Set(Object.keys(config.tools));
  let changed = false;

  // Add new tools (default: enabled)
  for (const name of registeredToolNames) {
    if (!existing.has(name)) {
      config.tools[name] = true;
      changed = true;
    }
  }

  // Remove tools that are no longer registered
  for (const name of existing) {
    if (!registered.has(name)) {
      delete config.tools[name];
      changed = true;
    }
  }

  return { config, changed };
}

// ---------------------------------------------------------------------------
// patchToolsInConfig
// ---------------------------------------------------------------------------

/**
 * Patch only the `### Tools` subsection in the config file on disk,
 * preserving everything else — comments, formatting, blank lines,
 * unknown sections, inline notes.
 *
 * Within the Tools block itself, comments and blank lines are preserved.
 * Only tool key-value lines are added, updated, or removed.
 *
 * If no config file exists yet, falls back to a full `saveConfig` write
 * (acceptable for first-time creation where there's nothing to preserve).
 */
export function patchToolsInConfig(tools: Record<string, boolean>): void {
  let fileContent: string;
  try {
    fileContent = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    // No config file yet — full save is fine for first creation
    const config = loadConfig();
    config.tools = tools;
    saveConfig(config);
    return;
  }

  const lines = fileContent.split("\n");

  // Find ### Tools boundaries
  let toolsStart = -1;
  let toolsEnd = lines.length;

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();

    if (/^###\s+tools$/i.test(trimmed)) {
      toolsStart = i;
      continue;
    }

    // Next section/subsection header after tools marks the end
    if (toolsStart !== -1 && /^#{2,3}\s+/.test(trimmed)) {
      toolsEnd = i;
      break;
    }
  }

  if (toolsStart === -1) {
    // No ### Tools section exists — append fresh
    const toolLines = Object.entries(tools)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, enabled]) => `${name}: ${enabled ? "enabled" : "disabled"}`);
    lines.push("", "### Tools", ...toolLines);
  } else {
    // Walk existing lines: preserve comments/blanks, update known tools,
    // remove stale ones.
    const remaining = new Map(Object.entries(tools));
    const newBlock: string[] = ["### Tools"];

    for (const line of lines.slice(toolsStart + 1, toolsEnd)) {
      const trimmed = line.trim();

      // Preserve blank lines and comment-only lines
      if (trimmed === "" || trimmed.startsWith("#")) {
        newBlock.push(line);
        continue;
      }

      // Parse as key: value (using `: ` like the main parser)
      const colonIdx = line.indexOf(": ");
      if (colonIdx === -1) {
        newBlock.push(line); // unknown format, preserve
        continue;
      }

      const key = line.substring(0, colonIdx).trim();

      if (remaining.has(key)) {
        // Tool still exists — write current value, preserve indentation
        // and any inline comment the user may have added.
        const indent = line.match(/^(\s*)/)?.[1] ?? "";
        const rest = line.substring(colonIdx + 2);
        const inlineCommentIdx = rest.indexOf(" # ");
        const inlineComment = inlineCommentIdx !== -1
          ? rest.substring(inlineCommentIdx)  // includes the leading " # "
          : "";
        newBlock.push(`${indent}${key}: ${remaining.get(key) ? "enabled" : "disabled"}${inlineComment}`);
        remaining.delete(key);
      }
      // else: tool was removed from registry — skip the line
    }

    // Append any brand new tools at the end of the block
    for (const [name, enabled] of [...remaining.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      newBlock.push(`${name}: ${enabled ? "enabled" : "disabled"}`);
    }

    lines.splice(toolsStart, toolsEnd - toolsStart, ...newBlock);
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, lines.join("\n"), "utf-8");
}

