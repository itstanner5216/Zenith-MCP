#!/usr/bin/env node
import { loadDotEnvFiles } from '../core/env-loader.js';

// Load `.env` files before this entrypoint reads `process.env`. ESM static
// imports are evaluated before this module's body, so any env var consumed
// at an imported module's top level will already have been read — keep
// entrypoint-level reads of `process.env` after this call. The shared
// loader walks cwd → package root → workspace root and honours the
// `ZENITH_ENV_FILE` override.
loadDotEnvFiles(import.meta.url);

// ---------------------------------------------------------------------------
// cli/stdio.ts — stdio MCP entrypoint
//
// SDK ownership: this entrypoint is on @modelcontextprotocol/server@2.0.0-alpha.3
// for v2-specific compatibility/evaluation needs. As of alpha.3 the stdio
// transport moved to the `@modelcontextprotocol/server/stdio` subpath export;
// `McpServer` remains on the package's main entry. This does not imply that
// regular v2 tool dispatch avoids the parallel-dispatch race seen in v1;
// keep that limitation in mind when reasoning about concurrent requests.
//
// Roots wiring lives directly in this file (no wrapper) — the v2 API
// `setNotificationHandler('notifications/roots/list_changed', handler)`
// takes a method-name string instead of v1's Zod-schema argument, so the
// wiring is SDK-specific and lives where the SDK is used.
// ---------------------------------------------------------------------------

import { createRequire } from 'module';
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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
  setupProjectDetection,
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

  // ── Project detection wiring ────────────────────────────────────────────
  setupProjectDetection(ctx, (message) => {
    try {
      server.server.sendLoggingMessage({
        level: "info",
        logger: "zenith-mcp",
        data: message,
      });
    } catch {
      // Transport might not be ready — ignore
    }
  });

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
        if (response && 'roots' in response && response.roots.length > 0) {
          await updateAllowedDirectoriesFromRoots(
            response.roots.map(r =>
              r.name !== undefined
                ? { uri: r.uri, name: r.name }
                : { uri: r.uri }
            ),
            ctx,
          );
        } else {
          console.error("Client returned empty roots, keeping current settings");
        }
      } catch (error) {
        console.error("Failed to request initial roots from client:", error instanceof Error ? error.message : String(error));
      }
    }

    // After all roots attempts: if we still have no dirs, operate in global-only mode.
    // NEVER throw here — an unhandled rejection in oninitialized kills the process.
    const currentDirs = ctx.getAllowedDirectories();
    if (currentDirs.length === 0) {
      console.error(
        "No allowed directories configured. Operating in global-only mode. " +
        "Tools will use process.cwd() or file paths directly."
      );
      try {
        await server.sendLoggingMessage({
          level: "warning",
          logger: "zenith-mcp",
          data: "No project directories configured. Operating in global fallback mode. " +
                "Provide directories via CLI args or MCP roots for project-scoped features.",
        });
      } catch {
        // sendLoggingMessage may fail if transport isn't ready — ignore
      }
    } else {
      console.error("Client does not support MCP Roots, using allowed directories set from server args:", currentDirs);
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
