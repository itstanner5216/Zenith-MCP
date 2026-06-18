// ---------------------------------------------------------------------------
// env-loader.ts — Shared `.env` discovery + loading for every Zenith-MCP
// entrypoint (stdio, HTTP, future transports).
//
// Why this exists:
//   - `process.loadEnvFile()` requires an explicit path and throws on missing
//     files. Each entrypoint previously had to roll its own swallow-and-try
//     loop, and the HTTP entrypoint's path math was off-by-one (it resolved
//     "monorepo root" to `packages/.env`).
//   - The stdio entrypoint never loaded `.env` at all, which is why
//     environment-driven configuration (e.g. tuning flags) was silently
//     ignored when launching the MCP locally.
//
// Discovery order (first match wins for any given key; later loads do NOT
// overwrite keys already present in `process.env`, matching dotenv semantics
// — that's how `process.loadEnvFile` already behaves on Node 20.6+):
//
//   1. `ZENITH_ENV_FILE` — explicit override (absolute or cwd-relative path).
//   2. `<cwd>/.env`
//   3. `<package root>/.env`        (packages/zenith-mcp/.env)
//   4. `<workspace root>/.env`      (repo root containing pnpm-workspace.yaml,
//                                    lerna.json, or .git)
//
// All paths are tried best-effort; missing files are silent. Any other error
// (e.g. malformed file) is surfaced on stderr so misconfiguration is visible
// without crashing the server.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findWorkspaceRoot(startDir: string): string | undefined {
    let current = startDir;
    // Walk up at most 8 levels — more than enough for any realistic monorepo
    // layout, and bounded so we never loop on detached/exotic mount points.
    for (let i = 0; i < 8; i++) {
        if (
            existsSync(resolve(current, 'pnpm-workspace.yaml')) ||
            existsSync(resolve(current, 'lerna.json')) ||
            existsSync(resolve(current, '.git'))
        ) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
    return undefined;
}

function tryLoad(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
        process.loadEnvFile(path);
        return true;
    } catch (err) {
        // File exists but failed to parse — surface it so the user knows.
        process.stderr.write(
            `[zenith-mcp] Failed to load env file ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return false;
    }
}

/**
 * Load `.env` files from every sensible Zenith-MCP location.
 *
 * Returns the absolute paths of every file that was successfully loaded, in
 * the order they were applied. Callers may log this for observability.
 *
 * @param moduleUrl `import.meta.url` of the calling entrypoint, used to
 *   anchor package-root and workspace-root discovery.
 */
export function loadDotEnvFiles(moduleUrl: string): string[] {
    const loaded: string[] = [];
    const seen = new Set<string>();

    const attempt = (candidate: string | undefined): void => {
        if (!candidate) return;
        const absolute = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
        if (seen.has(absolute)) return;
        seen.add(absolute);
        if (tryLoad(absolute)) loaded.push(absolute);
    };

    // 1. Explicit override.
    attempt(process.env.ZENITH_ENV_FILE);

    // 2. Current working directory.
    attempt(resolve(process.cwd(), '.env'));

    // 3. Package root — the directory containing `package.json` for
    //    zenith-mcp. The compiled entrypoint lives at
    //    `<pkg>/dist/<subdir>/<file>.js`, so the package root is two levels
    //    above the file's directory.
    const fileDir = dirname(fileURLToPath(moduleUrl));
    const packageRoot = resolve(fileDir, '..', '..');
    attempt(resolve(packageRoot, '.env'));

    // 4. Workspace/monorepo root — discovered by walking up from the package
    //    root looking for workspace markers. This avoids brittle `..` math
    //    that breaks when the package is consumed from `node_modules`.
    const workspaceRoot = findWorkspaceRoot(packageRoot);
    if (workspaceRoot && workspaceRoot !== packageRoot) {
        attempt(resolve(workspaceRoot, '.env'));
    }

    return loaded;
}
