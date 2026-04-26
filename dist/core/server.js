import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { normalizePath, expandHome } from './path-utils.js';
import { getValidRootDirectories } from './roots-utils.js';

import { register as registerReadTextFile } from '../tools/read_text_file.js';
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
import { loadSettings } from '../config/index.js';
import { onRootsChanged } from './project-context.js';

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

function registerAllTools(server, ctx) {
  registerReadTextFile(server, ctx);
  registerReadMediaFile(server, ctx);
  registerReadMultipleFiles(server, ctx);
  registerWriteFile(server, ctx);
  registerEditFile(server, ctx);
  registerDirectory(server, ctx);
  registerSearchFiles(server, ctx);
  registerFilesystem(server, ctx);
  registerStashRestore(server, ctx);
  registerRefactorBatch(server, ctx);
}

export function createFilesystemServer(ctx) {
  const server = new McpServer({ name: "zenith-mcp", version: "0.3.0" });
  const settings = loadSettings();
  if (settings.enabledAdapters.length > 0) {
    configureRegistry(settings.backupDir ?? undefined);
  }
  registerAllTools(server, ctx);
  return server;
}

export function attachRootsHandlers(server, ctx) {
  async function updateAllowedDirectoriesFromRoots(requestedRoots) {
    const validatedRootDirs = await getValidRootDirectories(requestedRoots);
    if (validatedRootDirs.length > 0) {
      ctx.setAllowedDirectories(validatedRootDirs);
      onRootsChanged(ctx);
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
