#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from 'url';
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';
import { setAllowedDirectories, createFilesystemContext } from './lib.js';
import { ripgrepAvailable } from './shared.js';

// ── Tool modules ──────────────────────────────────────────────────────────────
import { register as registerReadTextFile }           from './tools/read_text_file.js';
import { register as registerReadMediaFile }          from './tools/read_media_file.js';
import { register as registerReadMultipleFiles }      from './tools/read_multiple_files.js';
import { register as registerWriteFile }              from './tools/write_file.js';
import { register as registerEditFile }               from './tools/edit_file.js';
import { register as registerCreateDirectory }        from './tools/create_directory.js';
import { register as registerListDirectory }          from './tools/list_directory.js';
import { register as registerDirectoryTree }          from './tools/directory_tree.js';
import { register as registerMoveFile }               from './tools/move_file.js';
import { register as registerDeleteFile }             from './tools/delete_file.js';
import { register as registerSearchFiles }            from './tools/search_files.js';
import { register as registerFindFiles }              from './tools/find_files.js';
import { register as registerGetFileInfo }            from './tools/get_file_info.js';

// ── Resolve initial allowed directories from CLI args ─────────────────────────
export async function resolveInitialAllowedDirectories(args) {
    return Promise.all(args.map(async (dir) => {
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

// ── Validate that all directories exist and are directories ───────────────────
export async function validateDirectories(directories) {
    const errors = [];
    await Promise.all(directories.map(async (dir) => {
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

// ── Register all tools with a per-instance context ────────────────────────────
function registerAllTools(server, ctx) {
    registerReadTextFile(server, ctx);
    registerReadMediaFile(server, ctx);
    registerReadMultipleFiles(server, ctx);
    registerWriteFile(server, ctx);
    registerEditFile(server, ctx);
    registerCreateDirectory(server, ctx);
    registerListDirectory(server, ctx);
    registerDirectoryTree(server, ctx);
    registerMoveFile(server, ctx);
    registerDeleteFile(server, ctx);
    registerSearchFiles(server, ctx);
    registerFindFiles(server, ctx);
    registerGetFileInfo(server, ctx);
}

// ── Create a fully wired filesystem MCP server bound to a context ─────────────
export function createFilesystemServer(ctx) {
    const server = new McpServer({ name: "zenith-mcp", version: "0.3.0" });
    registerAllTools(server, ctx);
    return server;
}

// ── Attach MCP roots protocol handlers to a server + context pair ─────────────
export function attachRootsHandlers(server, ctx) {
    async function updateAllowedDirectoriesFromRoots(requestedRoots) {
        const validatedRootDirs = await getValidRootDirectories(requestedRoots);
        if (validatedRootDirs.length > 0) {
            ctx.setAllowedDirectories(validatedRootDirs);
            console.error(`Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`);
        } else {
            console.error("No valid root directories provided by client");
        }
    }

    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
        try {
            const response = await server.server.listRoots();
            if (response && 'roots' in response) {
                await updateAllowedDirectoriesFromRoots(response.roots);
            }
        } catch (error) {
            console.error("Failed to request roots from client:", error instanceof Error ? error.message : String(error));
        }
    });

    server.server.oninitialized = async () => {
        const clientCapabilities = server.server.getClientCapabilities();
        if (clientCapabilities?.roots) {
            try {
                const response = await server.server.listRoots();
                if (response && 'roots' in response) {
                    await updateAllowedDirectoriesFromRoots(response.roots);
                } else {
                    console.error("Client returned no roots set, keeping current settings");
                }
            } catch (error) {
                console.error("Failed to request initial roots from client:", error instanceof Error ? error.message : String(error));
            }
        } else {
            const currentDirs = ctx.getAllowedDirectories();
            if (currentDirs.length > 0) {
                console.error("Client does not support MCP Roots, using allowed directories set from server args:", currentDirs);
            } else {
                throw new Error(
                    `Server cannot operate: No allowed directories available. ` +
                    `Server was started without command-line directories and client either ` +
                    `does not support MCP roots protocol or provided empty roots. ` +
                    `Please either: 1) Start server with directory arguments, or ` +
                    `2) Use a client that supports MCP roots protocol and provides valid root directories.`
                );
            }
        }
    };
}

// ── stdio runner (default when executed directly) ─────────────────────────────
async function runStdio() {
    const args = process.argv.slice(2);

    // Filter out --port / --http flags (those are for http-server.js)
    const dirArgs = args.filter(a => !a.startsWith('--'));

    if (dirArgs.length === 0) {
        console.error("Usage: zenith-mcp [allowed-directory] [additional-directories...]");
        console.error("Note: Allowed directories can be provided via:");
        console.error("  1. Command-line arguments (shown above)");
        console.error("  2. MCP roots protocol (if client supports it)");
        console.error("At least one directory must be provided by EITHER method for the server to operate.");
    }

    const allowedDirectories = await resolveInitialAllowedDirectories(dirArgs);
    await validateDirectories(allowedDirectories);

    // Create per-instance context
    const ctx = createFilesystemContext(allowedDirectories);

    // Also set global state for backward compat with any code that still
    // imports the bare setAllowedDirectories / getAllowedDirectories / validatePath
    setAllowedDirectories(allowedDirectories);

    const server = createFilesystemServer(ctx);
    attachRootsHandlers(server, ctx);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Zenith-MCP running on stdio");
    ripgrepAvailable().then(ok =>
        console.error(ok ? `Ripgrep available at /usr/bin/rg` : 'Ripgrep not found — using JS fallback for search')
    );
    if (allowedDirectories.length === 0) {
        console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
    }
}

// ── Auto-run stdio when this file is the entrypoint ───────────────────────────
const __filename = fileURLToPath(import.meta.url);
const _resolvedArgv = await fs.realpath(process.argv[1] || '').catch(() => '');
const _resolvedSelf = await fs.realpath(__filename).catch(() => __filename);

if (_resolvedArgv === _resolvedSelf) {
    runStdio().catch((error) => {
        console.error("Fatal error running server:", error);
        process.exit(1);
    });
}
