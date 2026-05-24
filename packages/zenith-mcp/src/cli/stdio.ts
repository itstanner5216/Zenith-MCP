#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cli/stdio.ts — stdio MCP entrypoint
//
// SDK ownership: this entrypoint is on @modelcontextprotocol/server@2.0.0-alpha.2.
// The v2 SDK's task-queue dispatch model is the reason: under concurrent
// requests, v2 enqueues per-task instead of v1's fire-and-forget
// `Promise.resolve().then(handler)`, which is the parallel-dispatch race
// that surfaces in agent-driven workloads (write+stat fired together).
//
// Roots wiring lives directly in this file (no wrapper) — the v2 API
// `setNotificationHandler('notifications/roots/list_changed', handler)`
// takes a method-name string instead of v1's Zod-schema argument, so the
// wiring is SDK-specific and lives where the SDK is used.
// ---------------------------------------------------------------------------

import { createRequire } from 'module';
import {
  McpServer,
  StdioServerTransport,
} from "@modelcontextprotocol/server";
import fs from "fs/promises";
import { fileURLToPath } from 'url';
import { createFilesystemContext } from '../core/lib.js';
import { ripgrepAvailable } from '../core/shared.js';
import {
  registerEnabledTools,
  resolveInitialAllowedDirectories,
  updateAllowedDirectoriesFromRoots,
  validateDirectories,
  SERVER_INSTRUCTIONS,
} from '../core/server.js';
import { configExists, runFirstRunWizard } from '../config/index.js';
import type { WizardIO } from '../config/wizard.js';
import type { ToolServer } from '../tools/types.js';

const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json') as { version: string };

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

  if (!configExists()) {
    // stdout is the MCP JSON-RPC transport in stdio mode — route wizard
    // prompts to stderr to keep that pipe clean.
    const wizardIO: WizardIO = {
      input: process.stdin,
      output: process.stderr,
    };
    await runFirstRunWizard(wizardIO);
  }

  const ctx = createFilesystemContext(allowedDirectories);

  // ── v2 McpServer construction ─────────────────────────────────────────
  const server = new McpServer(
    { name: "zenith-mcp", version: _pkg.version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerEnabledTools(server as unknown as ToolServer, ctx);

  // ── v2 roots wiring ───────────────────────────────────────────────────
  // v2: setNotificationHandler takes a method-name string, not a Zod schema.
  server.server.setNotificationHandler('notifications/roots/list_changed', async () => {
    try {
      const response = await server.server.listRoots();
      if (response && 'roots' in response) {
        await updateAllowedDirectoriesFromRoots(
          response.roots.map(r =>
            r.name !== undefined
              ? { uri: r.uri, name: r.name }
              : { uri: r.uri }
          ),
          ctx,
        );
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
          await updateAllowedDirectoriesFromRoots(
            response.roots.map(r =>
              r.name !== undefined
                ? { uri: r.uri, name: r.name }
                : { uri: r.uri }
            ),
            ctx,
          );
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
