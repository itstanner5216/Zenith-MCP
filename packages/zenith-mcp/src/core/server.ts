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
import { onRootsChanged, getProjectContext } from './project-context.js';
import { getValidRootDirectories, parseRootUriPath } from './roots-utils.js';
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

export async function resolveInitialAllowedDirectories(args: string[]): Promise<string[]> {
  const resolved = await Promise.all(args.map(async (dir: string) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    try {
      const result = await fs.realpath(absolute);
      return normalizePath(result);
    } catch {
      return normalizePath(absolute);
    }
  }));
  return [...new Set(resolved)]; // deduplicate
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

  // ── Sandbox enforcement is OPT-IN via config (default off) ───────────
  // Wire the explicit `sandbox` flag into the filesystem context so access
  // enforcement is governed by operator intent, NOT by the mere presence of
  // allowed directories (those are always populated from CLI args / MCP roots
  // and exist purely as project-context hints). Set before any tool registers.
  ctx.setSandboxEnabled?.(syncedConfig.sandbox);

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
 *
 * Merges client roots with existing dirs (from CLI args) instead of replacing.
 * CLI-provided dirs are the baseline — roots ADD to them.
 */
export async function updateAllowedDirectoriesFromRoots(
  requestedRoots: Array<{ uri: string; name?: string }>,
  ctx: FilesystemContext,
): Promise<void> {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length > 0) {
    // Merge with existing dirs instead of replacing.
    // CLI-provided dirs are the baseline — roots ADD to them.
    const existingDirs = ctx.getAllowedDirectories();
    const merged = [...new Set([...existingDirs, ...validatedRootDirs])];
    ctx.setAllowedDirectories(merged);

    // Seed ProjectRegistry with root names from MCP roots for better detection.
    // Uses registerSessionRoot (non-sticky, non-persisting) — does NOT block auto-switching.
    const pc = getProjectContext(ctx);
    for (const root of requestedRoots) {
      if (root.name) {
        const resolvedPath = await parseRootUriPath(root.uri);
        if (resolvedPath && validatedRootDirs.includes(resolvedPath)) {
          pc.registerSessionRoot(resolvedPath, root.name);
        }
      }
    }

    onRootsChanged(ctx);
    console.error(`Updated allowed directories from MCP roots: ${merged.length} total directories (${validatedRootDirs.length} from roots)`);
  } else {
    console.error("No valid root directories provided by client");
  }
}

// ---------------------------------------------------------------------------
// setupProjectDetection — config-based project registry
// ---------------------------------------------------------------------------

/**
 * Wire project detection for a session: load config projects, set notify fn.
 * Called once per session/entrypoint after server + ctx are ready.
 * Registry auto-refreshes lazily on mismatch (no file watcher needed).
 */
export function setupProjectDetection(
  ctx: FilesystemContext,
  notifyFn: (message: string) => void,
): void {
  const pc = getProjectContext(ctx);

  // Load initial projects from config (always call, even if empty, to clear legacy state)
  const config = loadConfig();
  pc.reloadRegistry(config.projects);

  // Set notification function (fires sendLoggingMessage)
  pc.setNotifyFn(notifyFn);
}
