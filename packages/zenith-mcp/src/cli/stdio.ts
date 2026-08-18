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
// cli/stdio.ts — stdio MCP entrypoint (2026-07-28 spec)
//
// `serveStdio` owns the era decision for the connection: a modern opening is
// served sessionless per the 2026-07-28 spec, while a 2025-era opening
// (`initialize`) is pinned to a legacy-leg instance from the SAME factory —
// free interop, no deprecated protocol wiring in this source. Project scope
// is derived per tool call by ProjectContext (core/detection); directory
// arguments remain the explicit baseline.
// ---------------------------------------------------------------------------

import { createRequire } from 'module';
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import fs from "fs/promises";
import { fileURLToPath } from 'url';
import { createFilesystemContext } from '../core/lib.js';
import { ripgrepAvailable, getRipgrepPath } from '../core/shared.js';
import {
  registerEnabledTools,
  resolveInitialAllowedDirectories,
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
    console.error("Note: without directory arguments, tools resolve project scope per call");
    console.error("(client detection) or fall back to the global workspace.");
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

  // ── Project detection wiring ────────────────────────────────────────────
  // Notifications go to stderr: stdout is the JSON-RPC pipe, and the modern
  // era has no persistent logging channel to push through.
  setupProjectDetection(ctx, (message) => {
    console.error(`[zenith-mcp] ${message}`);
  });

  // ── Serve: one factory, both eras ─────────────────────────────────────
  serveStdio(
    () => {
      const server = new McpServer(
        { name: "zenith-mcp", version: _pkg.version },
        { instructions: SERVER_INSTRUCTIONS },
      );
      registerEnabledTools(server as unknown as ToolServer, ctx);
      return server;
    },
    {
      legacy: 'serve',
      onerror: (error) => console.error("[zenith-mcp] stdio error:", error),
    },
  );

  console.error("Zenith-MCP running on stdio (2026-07-28; 2025-era clients served via legacy leg)");
  ripgrepAvailable().then(ok =>
    console.error(ok ? `Ripgrep available at ${getRipgrepPath()}` : 'Ripgrep not found — using JS fallback for search')
  );
  if (allowedDirectories.length === 0) {
    console.error("Started without allowed directories — tools resolve project scope per call (detection) or use the global workspace");
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
