#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs/promises";
import { fileURLToPath } from 'url';
import { createFilesystemContext, setAllowedDirectories } from '../core/lib.js';
import { ripgrepAvailable } from '../core/shared.js';
import {
  createFilesystemServer,
  attachRootsHandlers,
  resolveInitialAllowedDirectories,
  validateDirectories,
} from '../core/server.js';

async function runStdio() {
  const args = process.argv.slice(2);
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

  const ctx = createFilesystemContext(allowedDirectories);
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

const __filename = fileURLToPath(import.meta.url);
const _resolvedArgv = await fs.realpath(process.argv[1] || '').catch(() => '');
const _resolvedSelf = await fs.realpath(__filename).catch(() => __filename);

if (_resolvedArgv === _resolvedSelf) {
  runStdio().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);
  });
}
