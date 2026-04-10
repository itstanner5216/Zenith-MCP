#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';
import { setAllowedDirectories, getAllowedDirectories } from './lib.js';
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

// ── Parse args, validate directories ─────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem [allowed-directory] [additional-directories...]");
    console.error("Note: Allowed directories can be provided via:");
    console.error("  1. Command-line arguments (shown above)");
    console.error("  2. MCP roots protocol (if client supports it)");
    console.error("At least one directory must be provided by EITHER method for the server to operate.");
}
let allowedDirectories = await Promise.all(args.map(async (dir) => {
    const expanded = expandHome(dir);
    const absolute = path.resolve(expanded);
    try {
        const resolved = await fs.realpath(absolute);
        return normalizePath(resolved);
    } catch {
        return normalizePath(absolute);
    }
}));
await Promise.all(allowedDirectories.map(async (dir) => {
    try {
        const stats = await fs.stat(dir);
        if (!stats.isDirectory()) {
            console.error(`Error: ${dir} is not a directory`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error accessing directory ${dir}:`, error);
        process.exit(1);
    }
}));
setAllowedDirectories(allowedDirectories);

// ── Server + tool registration ────────────────────────────────────────────────
const server = new McpServer({ name: "secure-filesystem-server", version: "0.3.0" });

registerReadTextFile(server);
registerReadMediaFile(server);
registerReadMultipleFiles(server);
registerWriteFile(server);
registerEditFile(server);
registerCreateDirectory(server);
registerListDirectory(server);
registerDirectoryTree(server);
registerMoveFile(server);
registerDeleteFile(server);
registerSearchFiles(server);
registerFindFiles(server);
registerGetFileInfo(server);

// ── MCP roots protocol ────────────────────────────────────────────────────────
async function updateAllowedDirectoriesFromRoots(requestedRoots) {
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (validatedRootDirs.length > 0) {
        allowedDirectories = [...validatedRootDirs];
        setAllowedDirectories(allowedDirectories);
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
        if (allowedDirectories.length > 0) {
            console.error("Client does not support MCP Roots, using allowed directories set from server args:", allowedDirectories);
        } else {
            throw new Error(`Server cannot operate: No allowed directories available. Server was started without command-line directories and client either does not support MCP roots protocol or provided empty roots. Please either: 1) Start server with directory arguments, or 2) Use a client that supports MCP roots protocol and provides valid root directories.`);
        }
    }
};

// ── Start ─────────────────────────────────────────────────────────────────────
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Secure MCP Filesystem Server running on stdio");
    ripgrepAvailable().then(ok =>
        console.error(ok ? `Ripgrep available at /usr/bin/rg` : 'Ripgrep not found — using JS fallback for search')
    );
    if (allowedDirectories.length === 0) {
        console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
    }
}
runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
});
