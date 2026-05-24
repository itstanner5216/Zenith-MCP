// ---------------------------------------------------------------------------
// core/server.ts — SDK-agnostic server orchestration
//
// This file owns ONLY logic that is genuinely shared across all entrypoints:
//   - resolveInitialAllowedDirectories / validateDirectories  (CLI + HTTP)
//   - TOOL_REGISTRY                                            (single source of truth)
//   - registerEnabledTools(toolServer, ctx)                    (config load + tool wiring)
//   - updateAllowedDirectoriesFromRoots(requestedRoots, ctx)   (roots-callback body)
//
// What this file deliberately does NOT do:
//   - construct an McpServer (different SDKs have different constructor shapes)
//   - call setNotificationHandler (different SDKs take different first args:
//       v1 takes a Zod schema, v2 takes a method-name string)
//   - call oninitialized / listRoots wiring (lives next to its own setNotificationHandler)
//
// Each entrypoint constructs its own McpServer using its preferred SDK, then
// calls registerEnabledTools to load tools, then inlines its own roots wiring
// (a 6-line block that calls updateAllowedDirectoriesFromRoots inside).
// ---------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';
import { type ToolServer, type ToolContext } from '../tools/types.js';
import { type FilesystemContext } from './lib.js';

import { register as registerReadFile } from '../tools/read_file.js';
import { register as registerSearchFile } from '../tools/search_file.js';
import { register as registerReadMediaFile } from '../tools/read_media_file.js';
import { register as registerReadMultipleFiles } from '../tools/read_multiple_files.js';
import { register as registerWriteFile } from '../tools/write_file.js';
import { register as registerEditFile } from '../tools/edit_file.js';
import { register as registerDirectory } from '../tools/directory.js';
import { register as registerSearchFiles } from '../tools/search_files.js';
import { register as registerFilesystem } from '../tools/filesystem.js';
import { register as registerStashRestore } from '../tools/stash_restore.js';
import { register as registerRefactorBatch } from '../tools/refactor_batch.js';
import { configureRegistry } from '../adapters/index.js';
import { loadConfig, syncToolsWithConfig, patchToolsInConfig, expandTilde } from '../config/index.js';
import type { ZenithConfig } from '../config/index.js';
import { onRootsChanged } from './project-context.js';

export async function resolveInitialAllowedDirectories(args: string[]): Promise<string[]> {
  return Promise.all(args.map(async (dir: string) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    try {
      const resolved = await fs.realpath(absolute);
      return normalizePath(resolved);
    } catch {
      return normalizePath(absolute);
    }
  }));
}

export async function validateDirectories(directories: string[]): Promise<void> {
  const errors: string[] = [];
  await Promise.all(directories.map(async (dir: string) => {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        errors.push(`${dir} is not a directory`);
      }
    } catch (error) {
      errors.push(`Cannot access directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  if (errors.length > 0) {
    throw new Error(`Directory validation failed:\n  ${errors.join('\n  ')}`);
  }
}

/**
 * Maps each register function to its tool name string (the first argument
 * passed to `server.registerTool(name, ...)` inside each tool file).
 *
 * This is the single source of truth for tool-name discovery. When a new
 * tool file is added, append an entry here and it will be picked up
 * automatically by config merging and the enabled/disabled guard.
 */
const TOOL_REGISTRY: Array<{
  name: string;
  register: (server: ToolServer, ctx: ToolContext) => void;
}> = [
  { name: "read_file",           register: registerReadFile },
  { name: "search_file",         register: registerSearchFile },
  { name: "read_media_file",     register: registerReadMediaFile },
  { name: "read_multiple_files", register: registerReadMultipleFiles },
  { name: "write_file",          register: registerWriteFile },
  { name: "edit_file",           register: registerEditFile },
  { name: "directory",           register: registerDirectory },
  { name: "search_files",        register: registerSearchFiles },
  { name: "file_manager",        register: registerFilesystem },
  { name: "stashRestore",        register: registerStashRestore },
  { name: "refactor_batch",      register: registerRefactorBatch },
];

/**
 * Exposed list of every tool name the server knows about, in registration order.
 * Used by entrypoints that need to advertise the available tools (e.g. for
 * health checks or schema dumps) without having to import every tool module.
 */
export const ALL_TOOL_NAMES: ReadonlyArray<string> = TOOL_REGISTRY.map(t => t.name);

/**
 * Default server instructions string. Each entrypoint passes this (or its own
 * override) into its SDK-specific `new McpServer(..., { instructions })` call.
 */
export const SERVER_INSTRUCTIONS =
  "Each call must set mode and the corresponding params, unless the schema lists the param explicitly as optional. Global Mode Rule: tool params apply only to the mode specified in the tools description. A param is shared only when explicitly listed for multiple modes.";

/**
 * Loads config, syncs the on-disk tool list against the in-code TOOL_REGISTRY,
 * configures the auto-write adapter if enabled, and calls each enabled tool's
 * `register(toolServer, ctx)` against the supplied SDK-agnostic ToolServer.
 *
 * `ToolServer` is this package's minimal abstraction for the subset of
 * `registerTool(...)` behavior used by the tool modules. It is intended to map
 * cleanly onto the MCP SDK servers at runtime, but the SDKs' TypeScript
 * declarations are not currently assignable to `ToolServer` in every entrypoint
 * without an adapter or cast. Keep this contract SDK-agnostic here, and let
 * SDK-specific entrypoints bridge any typing differences as needed.
 */
export function registerEnabledTools(toolServer: ToolServer, ctx: ToolContext): void {
  // ── Config: load, sync discovered tools, patch if needed ─────────────
  const config: ZenithConfig = loadConfig();

  const availableToolNames: string[] = TOOL_REGISTRY.map((t) => t.name);
  const { config: syncedConfig, changed } = syncToolsWithConfig(config, availableToolNames);

  // Only write to disk if tools actually changed, and use surgical patching
  // so comments, formatting, and unknown sections are preserved.
  if (changed) {
    patchToolsInConfig(syncedConfig.tools);
  }

  // ── Auto-write adapter setup (guarded by config flag) ────────────────
  if (syncedConfig.auto_write.status) {
    const resolvedBackupDir = syncedConfig.auto_write.backup_dir
      ? expandTilde(syncedConfig.auto_write.backup_dir)
      : undefined;
    configureRegistry(resolvedBackupDir);
  }

  // ── Register only the tools that are enabled in config ───────────────
  for (const entry of TOOL_REGISTRY) {
    if (syncedConfig.tools[entry.name]) {
      entry.register(toolServer, ctx);
    }
  }
}

/**
 * Applies a fresh roots list to the FilesystemContext. Called by each
 * entrypoint from inside its SDK-specific `setNotificationHandler` /
 * `oninitialized` blocks. Returns nothing; logs to stderr on the human path.
 */
export async function updateAllowedDirectoriesFromRoots(
  requestedRoots: Array<{ uri: string; name?: string }>,
  ctx: FilesystemContext,
): Promise<void> {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length > 0) {
    ctx.setAllowedDirectories(validatedRootDirs);
    onRootsChanged(ctx);
    console.error(`Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`);
  } else {
    console.error("No valid root directories provided by client");
  }
}
