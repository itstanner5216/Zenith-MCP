# Zenith-MCP Cleanup Plan for `docs/reviews/2.md`

This plan is based on the current codebase state in `/home/tanner/Projects/Zenith-MCP` and the review notes in `docs/reviews/2.md`. I verified the referenced files and line ranges against the current source before drafting each recommendation.

---

## 1) [P1] Ignoring isolated `allowedDirectories` in validation check

**Review summary**
- The original review claim is stale: `searchFilesWithValidation` no longer calls a global `validatePath(fullPath)` inside its recursion.
- The current helper already performs per-entry containment checks, but it still does not validate the initial `rootPath` before traversal.

**Evidence in current code**
- `src/core/lib.ts:332-355`
  ```ts
  export async function searchFilesWithValidation(rootPath: string, pattern: string, allowedDirectories: string[], options: { excludePatterns?: string[] } = {}) {
      const { excludePatterns = [] } = options;
      const results: string[] = [];
      async function search(currentPath: string) {
          const entries = await fs.readdir(currentPath, { withFileTypes: true });
          for (const entry of entries) {
              const fullPath = path.join(currentPath, entry.name);
              const normalizedFull = normalizePath(path.resolve(fullPath));
              if (!isPathWithinAllowedDirectories(normalizedFull, allowedDirectories)) {
                  continue;
              }
  ```
- `src/core/lib.ts:349-355`
  ```ts
              if (entry.isDirectory()) {
                  await search(fullPath);
              }
          }
      }
      await search(rootPath);
      return results;
  }
  ```

**Root cause**
- The function now honors `allowedDirectories` for discovered descendants, but it still trusts the initial `rootPath` argument.
- If a caller passes an unsafe root, traversal begins before any containment guard runs.

**Implementation steps**
1. Add a preflight check before `await search(rootPath)`.
2. Normalize and validate the starting root against `allowedDirectories`:
   ```ts
   const normalizedRoot = normalizePath(path.resolve(rootPath));
   if (!isPathWithinAllowedDirectories(normalizedRoot, allowedDirectories)) {
       throw new Error(`Access denied - root path outside allowed directories: ${normalizedRoot}`);
   }
   ```
3. Preserve the existing per-entry containment check inside the recursion so descendants cannot escape via symlinks or unexpected child paths.
4. If current callers already guarantee trusted roots, document that contract; otherwise harden the helper now.

**Tests / checks to add**
- Add regression coverage for:
  - trusted root inside allowed dirs returns matches
  - root outside allowed dirs throws before traversal
  - descendant path outside allowed dirs is skipped

**Status**
- Partially stale review: exact bug description is wrong, but the helper can still be hardened.

---

## 2) [High] Project root resolution can write `.mcp` databases outside allowed roots

**Review summary**
- The bug is present: `resolveProjectRoot()` still prefers a git root even when that root is outside the allowed session sandbox.
- `getDb()` then writes `.mcp/symbols.db` under that resolved root.

**Evidence in current code**
- `src/utils/project-scope.ts:68-92`
  ```ts
  export function resolveProjectRoot(filePath: string, options?: ResolveOptions): string | null {
    const absPath = path.resolve(filePath);
    ...
    try {
      const gitRoot = findRepoRoot(absPath);
      if (gitRoot) {
        _cache.set(absPath, gitRoot);
        return gitRoot;
      }
    } catch {
      // Continue to next steps
    }
  ```
- `src/utils/project-scope.ts:151-191`
  ```ts
  function _resolveFromAllowedDirectories(
    absPath: string,
    allowedDirectories?: string[]
  ): string | null {
    if (!allowedDirectories || allowedDirectories.length === 0) return null;
    ...
    if (allowedDirectories.length === 1) {
      const dir = path.resolve(allowedDirectories[0]);
      if (isWithinProject(absPath, dir)) {
        return dir;
      }
    }
    ...
  ```
- `src/core/symbol-index.ts:81-93`
  ```ts
  export function getDb(repoRoot: string): Database {
      if (_dbCache.has(repoRoot)) return _dbCache.get(repoRoot)!;

      const mcpDir = path.join(repoRoot, '.mcp'); // nosemgrep
      mkdirSync(mcpDir, { recursive: true }); // nosemgrep
      ...
      const db = new Database(path.join(mcpDir, 'symbols.db')); // nosemgrep
  ```
- `src/tools/edit_file.ts:80-89`
  ```ts
  const repoRoot = findRepoRoot(validPath) || path.dirname(validPath);
  const db = getDb(repoRoot);
  ```
- `src/tools/refactor_batch.ts:286-293`
  ```ts
  const repoRoot = pc.getRoot(args.fileScope);
  if (!repoRoot)
      throw new Error("No project root.");
  const db = getDb(repoRoot);
  ```

**Root cause**
- Git-root resolution is not constrained by the session's allowed directories.
- Callers then persist metadata directly under the chosen root without re-checking containment.

**Implementation steps**
1. Constrain project-root selection to the current session's allowed directories before any `.mcp` write.
2. Update `resolveProjectRoot()` so it does **not** return a git root unless it is inside `allowedDirectories` when such directories are provided.
3. If the git root is outside the sandbox, fall back to the most specific allowed directory that contains the file.
4. If no allowed directory contains the file, return `null` rather than writing outside the sandbox.
5. Update callers such as `edit_file.ts`, `refactor_batch.ts`, and stash helpers to handle the `null` case safely.
6. Keep `ctx.validatePath(...)` for the file being edited, but do not use an unconstrained repo root for `.mcp` writes.

**Tests / checks to add**
- Add tests for `src/utils/project-scope.ts` and `src/core/project-context.ts`:
  - allowed root `/repo/src`, file `/repo/src/a.ts` resolves to an in-sandbox root
  - file whose git root is outside allowed directories does not cause writes under `/repo/.mcp`
  - session-local allowed directories do not leak into other sessions

**Status**
- Verified present and still actionable.

---

## 3) [P3] Unused `trimmedLen` parameter in coordinate mapping

**Review summary**
- The review is stale: `mapTrimmedIndex()` no longer has a `trimmedLen` parameter in the current source.

**Evidence in current code**
- `src/core/edit-engine.ts:133-142`
  ```ts
  function mapTrimmedIndex(original: string, trimmed: string, trimmedIdx: number): number {
      const trimmedBefore = trimmed.slice(0, trimmedIdx);
      const lineNum = trimmedBefore.split('\n').length - 1;
      const normalizedOrig = normalizeLineEndings(original);
      const origLines = normalizedOrig.split('\n');
      let origIdx = 0;
      for (let i = 0; i < lineNum; i++) {
          origIdx += origLines[i].length + 1; // nosemgrep
      }
      return origIdx;
  }
  ```

**Root cause**
- No active root cause in the current source; the parameter has already been removed.

**Implementation steps**
- No code change needed.

**Tests / checks to add**
- None required.

**Status**
- Already fixed; remove from implementation scope.

---

## 4) [P3] Dead code functions in `symbol-index`

**Review summary**
- The review is stale: `pruneOldVersions` and `defaultVersionTtlMs` do not exist in the current `src/core/symbol-index.ts`.

**Evidence in current code**
- `src/core/symbol-index.ts:142-159`
  ```ts
  // Schema migration: add line column to versions for accurate symbol disambiguation on restore
  try { db.exec('ALTER TABLE versions ADD COLUMN line INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE versions ADD COLUMN text_hash TEXT'); } catch { /* already exists */ }
  try {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id)');
  } catch { /* tolerate pre-existing duplicates */ }
  ...
  try { db.prepare('DELETE FROM versions WHERE created_at < ?').run(Date.now() - _config.advanced.refactor_version_ttl_hours * 60 * 60 * 1000); } catch { /* table may be mid-migration */ }
  ```

**Root cause**
- No dead helpers are present in the checked source.

**Implementation steps**
- No code change needed.

**Tests / checks to add**
- None required.

**Status**
- Already fixed; remove from implementation scope.

---

## 5) [P3] Unused `Tool` interface import

**Review summary**
- The review is stale: `src/retrieval/base.ts` no longer imports `Tool`.

**Evidence in current code**
- `src/retrieval/base.ts:1-31`
  ```ts
  import type { RetrievalContext, ScoredTool, ToolMapping } from "./models.js";

  export abstract class ToolRetriever {
  ```

**Root cause**
- No active root cause in the current source.

**Implementation steps**
- No code change needed.

**Tests / checks to add**
- None required.

**Status**
- Already fixed; remove from implementation scope.

---

## 6) [P3] Unused `args` parameter in router evaluation

**Review summary**
- The review is stale: the parameter is already named `_args`, which signals intentional non-use.

**Evidence in current code**
- `src/retrieval/routing-tool.ts:45-71`
  ```ts
  export function handleRoutingCall(
    name: string,
    describe: boolean,
    _args: Record<string, unknown>,
    registry: Record<string, ToolMapping>,
  ): TextContent[] {
  ```

**Root cause**
- No active root cause in the current source.

**Implementation steps**
- No code change needed.

**Tests / checks to add**
- None required.

**Status**
- Already fixed; remove from implementation scope.

---

## 7) [P1] `ProjectContext` singleton breaks HTTP per-session isolation

**Review summary**
- The bug is present: HTTP creates fresh filesystem contexts per session, but `getProjectContext(ctx)` still caches a single process-global instance.
- `onRootsChanged()` also refreshes only that singleton.

**Evidence in current code**
- `src/server/http.ts:128-133`
  ```ts
  function createSessionPair() {
      const ctx = createFilesystemContext([...baselineAllowedDirs]);
      const server = createFilesystemServer(ctx);
      attachRootsHandlers(server, ctx);
      return { ctx, server };
  }
  ```
- `src/core/project-context.ts:258-273`
  ```ts
  let _instance: ProjectContext | null = null;

  export function getProjectContext(ctx: FsContext): ProjectContext {
      if (!_instance) {
          _instance = new ProjectContext(ctx);
      }
      return _instance;
  }

  export function onRootsChanged(): void {
      if (_instance) {
          _instance.refresh();
      }
  }
  ```

**Root cause**
- The first session's `FsContext` is retained permanently and reused for later sessions.
- Root change notifications are broadcast globally instead of per session.

**Implementation steps**
1. Replace the singleton with a per-`FsContext` cache, e.g. `WeakMap<FsContext, ProjectContext>`.
2. Ensure `getProjectContext(ctx)` returns a distinct `ProjectContext` for distinct HTTP sessions.
3. Update `onRootsChanged()` to accept a context or become session-scoped; do not refresh all sessions from a single global instance.
4. Review all callers of `getProjectContext` and `onRootsChanged` to pass the proper session context.
5. Confirm `ProjectContext.refresh()` still clears caches and re-syncs the registry.

**Tests / checks to add**
- Add/extend `tests/project-context.test.ts`:
  - two distinct `FilesystemContext` instances yield distinct `ProjectContext` instances
  - allowed directories from one session do not leak into another
  - roots refresh only affects the matching context

**Status**
- Verified present and still actionable.

---

## 8) [P1] `write_file` cannot create nested parent directories despite claiming it can

**Review summary**
- The bug is present: `write_file` validates the final target path before creating parent directories.
- When intermediate parents are missing, `ctx.validatePath(args.path)` fails before `fs.mkdir(parentDir, { recursive: true })` runs.

**Evidence in current code**
- `src/tools/write_file.ts:29-44`
  ```ts
  }, async (args: WriteFileArgs) => {
      const validPath = await ctx.validatePath(args.path);
      const normalizedContent = normalizeLineEndings(args.content);
      let existed = false;
      try {
          await fs.stat(validPath);
          existed = true;
      }
      catch { /* file doesn't exist */ }
      ...
      const parentDir = path.dirname(validPath);
      try {
          await fs.mkdir(parentDir, { recursive: true });
      }
  ```
- `src/core/lib.ts:34-68`
  ```ts
  async function validatePath(requestedPath: string) {
      const expandedPath = expandHome(requestedPath);
      const absolute = path.isAbsolute(expandedPath)
          ? path.resolve(expandedPath)
          : path.resolve(process.cwd(), expandedPath);
      const normalizedRequested = normalizePath(absolute);

      const isAllowed = isPathWithinAllowedDirectories(normalizedRequested, _allowedDirectories);
      if (!isAllowed) {
          throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${_allowedDirectories.join(', ')}`);
      }

      try {
          const realPath = await fs.realpath(absolute);
          ...
      } catch (error: unknown) {
          if (hasCode(error) && error.code === 'ENOENT') {
              const parentDir = path.dirname(absolute);
              try {
                  const realParentPath = await fs.realpath(parentDir);
  ```

**Root cause**
- Path validation assumes the target file or its immediate parent already exists.
- There is no creation-time validation mode for newly created nested files.

**Implementation steps**
1. Add a dedicated creation-path helper in `src/core/lib.ts` next to `validatePath()`.
2. The helper should validate the nearest existing ancestor with `realpath`, then allow creation of the remaining missing descendants.
3. Update `src/tools/write_file.ts` to use the creation-path helper for new files.
4. Keep the final `fs.mkdir(parentDir, { recursive: true })` call after successful creation-path validation.
5. Preserve sandbox safety so no symlink escape or out-of-root path can be created.

**Tests / checks to add**
- Add regression coverage for creating `/allowed/new/nested/file.txt` when intermediate directories do not exist.
- Add a negative test that paths outside allowed directories still fail.

**Status**
- Verified present and still actionable.

---

## 9) [P1] Auto-write backup modes are bypassed by adapter-level backups

**Review summary**
- The bug is present: `autoWriteToMcpConfigs()` already performs a mode-aware backup, but platform adapters still call `this.backup(...)` inside `writeConfig()`.
- That means `backup_mode: none` still creates `.bak` files and `backup_mode: file` can create duplicate artifacts.

**Evidence in current code**
- `src/config/auto-write.ts:43-121`
  ```ts
  const resolvedBackupDir = config.auto_write.backup_dir
      ? expandTilde(config.auto_write.backup_dir)
      : undefined;
  configureRegistry(resolvedBackupDir);
  ...
  try {
      backupFile(
          cfgPath,
          config.auto_write.backup_mode,
          resolvedBackupDir,
      );
  } catch (backupErr) {
  ```
- `src/adapters/base.ts:19-28`
  ```ts
  protected backup(filePath: string): void {
    if (!existsSync(filePath)) return;
    const dir = this.backupDir ?? join(filePath, "..");
    const baseName = win32.basename(filePath);
    const name = this.backupDir
      ? `${this.toolName}_${baseName}.bak`
      : `${baseName}.bak`;
    mkdirSync(dir, { recursive: true });
    copyFileSync(filePath, join(dir, name));
  }
  ```
- Representative adapter: `src/adapters/platforms/claude-desktop.ts:43-47`
  ```ts
  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
  ```
- This pattern exists in other adapters too, e.g. `src/adapters/platforms/antigravity.ts:24`, `cline.ts:45`, `codex-cli.ts:26`, `codex-desktop.ts:26`, `continue-dev.ts:31`, `gemini-cli.ts:24`, `github-copilot.ts:30`, `gptme.ts:26`, `jetbrains.ts:65`, `openclaw.ts:29`, `opencode.ts:48`, `raycast.ts:24`, `roo-code.ts:24`, `warp.ts:70/74/85`, and `zed.ts:37`.

**Root cause**
- Backup responsibility is duplicated between `auto-write.ts` and adapter-local `writeConfig()` methods.
- Adapter backups are unconditional, so they ignore the selected backup mode.

**Implementation steps**
1. Choose one backup authority. The simplest fix is to centralize backup behavior in `src/config/auto-write.ts`.
2. Add an explicit suppression mechanism to adapter writes, such as `writeConfig(data, options?: { skipBackup?: boolean })`.
3. Update `MCPConfigAdapter` and every platform adapter to honor that option.
4. Ensure auto-write passes the configured backup mode while suppressing adapter-local backups.
5. Preserve manual adapter usage by keeping a safe default path when `skipBackup` is not set.

**Tests / checks to add**
- Add/extend tests to confirm:
  - `backup_mode: none` creates no `.bak`
  - `backup_mode: sqlite` stores only sqlite backups
  - `backup_mode: file` creates exactly one filesystem backup

**Status**
- Verified present and still actionable.

---

## 10) [Medium] JS content-search fallback can miss matches because it uses a global `RegExp`

**Review summary**
- The bug is present: the fallback compiles a global regex with `gi` and reuses it across lines with `.test()`.

**Evidence in current code**
- `src/tools/search_files.ts:571-574`
  ```ts
  const flags = 'gi';
  const contentRegex = args.literalSearch
      ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // nosemgrep
      : new RegExp(args.contentQuery!, flags); // nosemgrep
  ```
- `src/tools/search_files.ts:647-654`
  ```ts
  const content = await fs.readFile(filePath, 'utf-8'); // nosemgrep
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
      if (contentResults.length >= maxJsFallback)
          break;
      if (contentRegex.test(lines[i])) { // nosemgrep
          contentResults.push(`${filePath}:${i + 1}: ${lines[i].trim().slice(0, 500)}`); // nosemgrep
      }
  }
  ```

**Root cause**
- `RegExp.prototype.test()` is stateful when the regex has the `g` flag.
- Reusing the same regex instance across lines can skip valid matches.

**Implementation steps**
1. Remove the `g` flag for the JS fallback regex, keeping case-insensitive matching only.
2. Alternatively reset `contentRegex.lastIndex = 0` before each `.test()`, but the non-global regex is simpler.
3. Add regression coverage for multiple matching lines and `countOnly` correctness.

**Tests / checks to add**
- Add a fallback-specific test in `tests/search-files.test.ts` that forces the non-ripgrep path.
- Confirm consecutive matches are not skipped.

**Status**
- Verified present and still actionable.

---

## 11) [Medium] Custom MCP config auto-write only recognizes `mcpServers`

**Review summary**
- The bug is present: custom path verification only treats a top-level `mcpServers` object as an MCP config.
- Other schemas used by adapters are not recognized here.

**Evidence in current code**
- `src/config/auto-write.ts:240-252`
  ```ts
  function isMcpConfig(data: Record<string, unknown>): boolean {
    return (
      typeof data === "object" &&
      data !== null &&
      "mcpServers" in data &&
      typeof data.mcpServers === "object" &&
      data.mcpServers !== null
    );
  }
  ```
- `src/config/auto-write.ts:254-319` writes only to `data.mcpServers[...]`.
- The repo's platform adapters also manipulate other config shapes in `src/adapters/platforms/*`.

**Root cause**
- The custom path flow uses a single `mcpServers` detector/writer instead of reusing schema-specific handling.

**Implementation steps**
1. Introduce schema-aware parsing/writing for custom paths.
2. Either add schema-specific handlers or reuse adapter logic based on file shape and extension.
3. Extend detection to the schemas supported by adapters, at minimum:
   - `mcp_servers` for Codex
   - `mcp.servers` for gptme
   - `mcp` for OpenCode
   - `context_servers` for Zed
   - list-style `mcpServers` for Continue.dev
4. Preserve the current verify-before-write behavior.
5. Keep serialization format/comments intact where possible.

**Tests / checks to add**
- Add tests for each supported schema in the custom path flow.
- Verify unrelated JSON/TOML/YAML files are still skipped.

**Status**
- Verified present and still actionable.

---

## 12) [Medium] Symbol indexing does not apply sensitive-file filtering

**Review summary**
- The bug is present: `indexDirectory()` only checks `DEFAULT_EXCLUDES` and `isSupported()`; it never calls `isSensitive()`.
- `indexFile()` also lacks a sensitive-path guard.

**Evidence in current code**
- `src/core/shared.ts:39-45`
  ```ts
  export function isSensitive(filePath: string): boolean {
      const rel = path.relative(os.homedir(), filePath);
      return SENSITIVE_PATTERNS.some(pat =>
          minimatch(rel, pat, { dot: true, nocase: true }) ||
          minimatch(path.basename(filePath), pat.replace(/\*\*\//g, ''), { dot: true, nocase: true })
      );
  }
  ```
- `src/core/symbol-index.ts:271-288`
  ```ts
  async function walk(dir: string): Promise<void> {
      if (filePaths.length >= maxFiles) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; } // nosemgrep
      for (const entry of entries) {
          if (filePaths.length >= maxFiles) return;
          if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
          const fullPath = path.join(dir, entry.name); // nosemgrep
          if (entry.isDirectory()) {
              await walk(fullPath);
          } else if (entry.isFile() && isSupported(fullPath)) {
              filePaths.push(fullPath);
          }
      }
  }
  ```
- `src/core/symbol-index.ts:199-265`
  ```ts
  export async function indexFile(db: Database, repoRoot: string, absFilePath: string): Promise<void> {
      const relPath = path.relative(repoRoot, absFilePath);
      let source: string;
      try {
          source = await fs.readFile(absFilePath, 'utf-8'); // nosemgrep
      } catch {
          return;
      }
  ```

**Root cause**
- Indexing only filters by basename excludes and language support, so sensitive credential-like paths can still be parsed and stored.

**Implementation steps**
1. Import `isSensitive` into `src/core/symbol-index.ts`.
2. Add a traversal-time check in `indexDirectory.walk()` before descending or enqueueing files.
3. Add a second check in `indexFile()` before reading or persisting symbols.
4. Consider the same guard in any bulk-index helpers such as `ensureIndexFresh()`.

**Tests / checks to add**
- Add regression tests that confirm sensitive-looking files are not indexed.
- Verify normal supported files are still indexed.

**Status**
- Verified present and still actionable.

---

## 13) [Medium] Committed runtime surface and source surface are not aligned

**Review summary**
- The packaging concern still appears valid, but the plan should be narrower and more concrete.
- The current build script compiles `src` and copies grammars; it does not explicitly clean `dist` first.

**Evidence in current code**
- `package.json:22-24`
  ```json
  "scripts": {
    "build": "tsc && shx cp -r grammars dist/ && shx chmod +x dist/cli/*.js dist/server/*.js",
    "prepare": "npm run build",
  }
  ```
- The review referenced runtime artifacts under `dist/config/*` that are not obviously represented in `src/config/*`.

**Root cause**
- Generated output and committed runtime assets are not fully source-tracked or reproducibly regenerated by the current build.

**Implementation steps**
1. Decide whether the extra `dist/config/*` runtime files are intended build artifacts or orphaned committed files.
2. If they are intended, add source or build steps that reproduce them deterministically.
3. If they are not intended, remove the orphaned runtime files and add a clean build step that deletes `dist/` before `tsc` runs.
4. Add a parity check script to catch future source/dist drift.

**Tests / checks to add**
- Add a build-parity check in CI or a repository script.
- Verify a clean build reproduces the expected runtime tree.

**Status**
- Needs narrower verification, but the packaging drift concern remains plausible.

---

## 14) [P1] Windows path containment check uses hardcoded `/`

**Review summary**
- The bug is present: `isPathWithinAllowedDirectories()` appends `'/'` rather than `path.sep`.

**Evidence in current code**
- `src/core/path-validation.ts:7-13`
  ```ts
  export function isPathWithinAllowedDirectories(filePath: string, allowedDirectories: string[]): boolean {
      const normalized = normalizePath(filePath);
      const resolved = path.resolve(normalized);
      return allowedDirectories.some(dir => {
          const normalizedDir = path.resolve(normalizePath(dir));
          return resolved === normalizedDir || resolved.startsWith(normalizedDir + '/');
      });
  }
  ```

**Root cause**
- The separator is hardcoded to `/`, so Windows paths with backslashes are not matched correctly.

**Implementation steps**
1. Replace the hardcoded `/` suffix with `path.sep`.
2. Keep the exact-path equality case intact.
3. Add a regression test for Windows-style containment logic.

**Tests / checks to add**
- Extend `tests/path-validation.test.ts` with Windows-style containment cases.

**Status**
- Verified present and still actionable.

---

## 15) [P1] `stripJsoncComments` regex corrupts URLs and `//` inside strings

**Review summary**
- The bug is present in `src/adapters/platforms/opencode.ts`.
- The current implementation strips `//` comments with regex, and comment detection is triggered for any content containing `//` or `/*`.

**Evidence in current code**
- `src/adapters/platforms/opencode.ts:28-41`
  ```ts
  private stripJsoncComments(content: string): string {
    content = content.replace(/\/\/.*?$/gm, "");
    content = content.replace(/\/\*[\s\S]*?\*\//g, "");
    content = content.replace(/,(\s*[}\]])/g, "$1");
    return content;
  }

  readConfig() {
    ...
    const isJsonc = p.endsWith(".jsonc") || content.includes("//") || content.includes("/*");
    const cleanContent = isJsonc ? this.stripJsoncComments(content) : content;
  ```

**Root cause**
- The regex-based stripper will also remove `//` appearing inside JSON string values.
- The `content.includes("//")` heuristic can incorrectly treat plain JSON with URLs as JSONC.

**Implementation steps**
1. Replace the regex stripper with a real JSONC parser or format-preserving parser.
2. Narrow the JSONC detection heuristic so plain JSON containing URLs is not misclassified.
3. Add tests covering `http://` and other `//`-containing string values.

**Tests / checks to add**
- Add parser tests for URLs, embedded `//`, and valid JSONC comments.

**Status**
- Verified present and still actionable.

---

## 16) [P1] `win32.basename()` used unconditionally produces wrong backup filenames on macOS/Linux

**Review summary**
- The bug is present: `MCPConfigAdapter.backup()` uses `win32.basename(filePath)` on every platform.

**Evidence in current code**
- `src/adapters/base.ts:1-28`
  ```ts
  import { join, win32 } from "path";
  ...
  const baseName = win32.basename(filePath);
  ```

**Root cause**
- `win32.basename()` does not behave like the platform-native `basename()` for POSIX paths.

**Implementation steps**
1. Replace `win32.basename(filePath)` with the platform-native `basename` from `path`.
2. Keep backup directory handling unchanged.
3. Verify backup filenames on Linux, macOS, and Windows.

**Tests / checks to add**
- Add backup naming coverage for POSIX-style paths.

**Status**
- Verified present and still actionable.

---

## 17) [P1] `getProjectContext` singleton silently ignores different `ctx` arguments after first call

**Review summary**
- Same underlying issue as item 7: the first `ctx` is cached forever.

**Evidence in current code**
- `src/core/project-context.ts:258-273`
  ```ts
  let _instance: ProjectContext | null = null;

  export function getProjectContext(ctx: FsContext): ProjectContext {
      if (!_instance) {
          _instance = new ProjectContext(ctx);
      }
      return _instance;
  }
  ```

**Root cause**
- The `ctx` argument is ignored after the first invocation.

**Implementation steps**
- Same fix as item 7: cache per `FsContext`, not globally.

**Tests / checks to add**
- Same as item 7.

**Status**
- Verified present and still actionable.

---

## 18) [P1] `file://` URI parsing mishandles percent-encoding and authority forms

**Review summary**
- The bug is present: `parseRootUri()` strips `file://` with `slice(7)` instead of using a URL parser.

**Evidence in current code**
- `src/core/roots-utils.ts:6-18`
  ```ts
  async function parseRootUri(rootUri: string) {
      try {
          const rawPath = rootUri.startsWith('file://') ? rootUri.slice(7) : rootUri;
          const expandedPath = rawPath.startsWith('~/') || rawPath === '~'
              ? path.join(os.homedir(), rawPath.slice(1))
              : rawPath;
          const absolutePath = path.resolve(expandedPath);
          const resolvedPath = await fs.realpath(absolutePath);
          return normalizePath(resolvedPath);
      }
      catch {
          return null;
      }
  }
  ```

**Root cause**
- Manual slicing does not correctly handle percent-encoded segments or authority forms.

**Implementation steps**
1. Parse `file://` URIs with `new URL(uri)`.
2. Decode percent-encoded path segments.
3. Preserve non-URI path handling and any intentional tilde expansion.
4. Reject unsupported authority forms cleanly if necessary.

**Tests / checks to add**
- Add coverage for `file:///tmp/space%20dir`, authority forms, plain paths, and tilde paths.

**Status**
- Verified present and still actionable.

---

## 19) [P1] Broken `_fnmatch` glob matcher in security-sensitive denylist

**Review summary**
- The bug is present: `_fnmatch()` only checks ordered substring presence and is not anchored.

**Evidence in current code**
- `src/retrieval/telemetry/scanner.ts:84-93`
  ```ts
  function _fnmatch(name: string, pattern: string): boolean {
    const parts = pattern.split("*");
    let idx = 0;
    for (const part of parts) {
      if (part === "") continue;
      const found = name.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return true;
  }
  ```

**Root cause**
- The matcher does not implement anchored glob semantics, so denylist rules can over-match substrings.

**Implementation steps**
1. Replace `_fnmatch()` with a real glob matcher or an existing library helper.
2. Verify denylist behavior for exact and wildcard cases.
3. Keep the denylist conservative for security-sensitive filenames.

**Tests / checks to add**
- Add matcher tests for `.env`, `id_rsa`, and similar denylist patterns.

**Status**
- Verified present and still actionable.

---

## 20) [P1] Fire-and-forget dynamic import causes race condition — Tier 1 fusion unreliable on cold starts

**Review summary**
- The bug is present: Tier 1 fusion is loaded with a top-level dynamic import and no synchronization.

**Evidence in current code**
- `src/retrieval/pipeline.ts:32-43`
  ```ts
  let _weightedRrf: ((env: ScoredTool[], conv: ScoredTool[], alpha: number) => ScoredTool[]) | null = null;
  let _computeAlpha: ((
    turn: number, workspaceConfidence: number, convConfidence: number,
    rootsChanged?: boolean, explicitToolMention?: boolean,
  ) => number) | null = null;

  import("./ranking/fusion.js").then((f) => {
    _weightedRrf = f.weightedRrf;
    _computeAlpha = f.computeAlpha;
  }).catch(() => { /* Tier 1 unavailable — falls through to Tier 2+ */ });
  ```

**Root cause**
- The fusion module resolves asynchronously, so early calls can observe `null` and skip Tier 1 logic.

**Implementation steps**
1. Replace the fire-and-forget import with a static import.
2. Ensure the fusion helpers are available synchronously before ranking runs.
3. Add regression tests for startup/cold-start ranking behavior.

**Tests / checks to add**
- Add a retrieval pipeline test that exercises the first-call path.

**Status**
- Verified present and still actionable.

---

## 21) [P1] Fragile coupling to MCP SDK private internals

**Review summary**
- The bug is present: `installRetrievalRequestHandlers()` reads `server.server._requestHandlers` via a private SDK field.

**Evidence in current code**
- `src/retrieval/zenith-integration.ts:205-213`
  ```ts
  const protocol = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const defaultList = protocol._requestHandlers.get("tools/list");
  const defaultCall = protocol._requestHandlers.get("tools/call");

  if (!defaultList || !defaultCall) {
    throw new Error("MCP tool handlers are not initialized");
  }
  ```

**Root cause**
- The code relies on an internal MCP SDK implementation detail that may change without notice.

**Implementation steps**
1. Replace private-field access with a supported SDK extension point if one exists.
2. If no extension point exists, wrap the dependency behind a compatibility layer to isolate SDK churn.
3. Add startup tests that fail clearly if handler wiring changes.

**Tests / checks to add**
- Add regression coverage for request-handler registration / initialization.

**Status**
- Verified present and still actionable.

---

## 22) [P1] User-supplied regex enables ReDoS — can hang the event loop

**Review summary**
- The bug is present: `search_files` passes untrusted `contentQuery` directly to `new RegExp()` when `literalSearch` is false.

**Evidence in current code**
- `src/tools/search_files.ts:571-574`
  ```ts
  const flags = 'gi';
  const contentRegex = args.literalSearch
      ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // nosemgrep
      : new RegExp(args.contentQuery!, flags); // nosemgrep
  ```

**Root cause**
- A malicious regex pattern can trigger catastrophic backtracking in the JS fallback.

**Implementation steps**
1. Avoid using user-supplied regex in the fallback path, or validate/sandbox it.
2. Prefer ripgrep-backed search for regex-heavy matching.
3. If regex support remains, add guards or timeouts.

**Tests / checks to add**
- Add a test for a pathological pattern and confirm the fallback rejects or safely handles it.

**Status**
- Verified present and still actionable.

---

## 23) [P1] `search_files` definition mode crashes if `definesSymbol` omitted

**Review summary**
- The code still asserts `args.definesSymbol!` and does not emit a helpful validation error when it is missing.

**Evidence in current code**
- `src/tools/search_files.ts:394-401`
  ```ts
  const supportedFiles = rawResults.filter(f => isSupported(f));
  if (supportedFiles.length === 0) {
      return { content: [{ type: "text" as const, text: 'No supported files found for symbol search.' }] };
  }
  const BATCH_SIZE = 50;
  const MAX_FILE_SIZE = 512 * 1024;
  const symbolName = args.definesSymbol!;
  ```

**Root cause**
- Missing `definesSymbol` is not validated before the non-null assertion is used.

**Implementation steps**
1. Add an explicit guard before using `args.definesSymbol!`.
2. Return a clear error message when `mode: "definition"` is used without `definesSymbol`.
3. Keep the existing filtering logic otherwise unchanged.

**Tests / checks to add**
- Add a test for definition mode without `definesSymbol`.

**Status**
- Verified present and still actionable.

---

## 24) [P2] `tailFile` can corrupt multi-byte UTF-8 characters at chunk boundaries

**Review summary**
- The bug is present: `tailFile()` reads fixed-size byte chunks and decodes them as UTF-8.

**Evidence in current code**
- `src/core/lib.ts:237-270`
  ```ts
  export async function tailFile(filePath: string, numLines: number) {
      const CHUNK_SIZE = 1024;
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      if (fileSize === 0) return '';
      const fileHandle = await fs.open(filePath, 'r');
      try {
          const lines = [];
          let position = fileSize;
          let chunk = Buffer.alloc(CHUNK_SIZE);
          let linesFound = 0;
          let remainingText = '';
          while (position > 0 && linesFound < numLines) {
              const size = Math.min(CHUNK_SIZE, position);
              position -= size;
              const { bytesRead } = await fileHandle.read(chunk, 0, size, position);
              if (!bytesRead) break;
              const readData = chunk.slice(0, bytesRead).toString('utf-8');
              const chunkText = readData + remainingText;
              const chunkLines = normalizeLineEndings(chunkText).split('\n');
              if (position > 0) {
                  remainingText = chunkLines[0];
                  chunkLines.shift();
              }
              for (let i = chunkLines.length - 1; i >= 0 && linesFound < numLines; i--) {
                  lines.unshift(chunkLines[i]);
                  linesFound++;
              }
          }
          return lines.join('\n');
      } finally {
          await fileHandle.close();
      }
  }
  ```

**Root cause**
- Multi-byte characters can straddle chunk boundaries and decode incorrectly.

**Implementation steps**
1. Decode tail chunks with boundary-aware buffering.
2. Avoid splitting UTF-8 sequences across chunk reads.
3. Add regression coverage with emoji/CJK content.

**Tests / checks to add**
- Add a tail-file test with multi-byte characters at chunk boundaries.

**Status**
- Verified present and still actionable.
