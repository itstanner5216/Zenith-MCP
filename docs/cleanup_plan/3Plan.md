# Cleanup Plan for `docs/reviews/3.md`

This is a codebase-accurate implementation plan derived from the current state of `/home/tanner/Projects/Zenith-MCP`. It does **not** modify source code; it only documents exactly what should be changed, where, and how.

I inspected the referenced files and verified the current implementation before writing this plan.

---

## 9. Custom MCP config auto-write only recognizes `mcpServers`

**Issue summary**
- The current implementation in `src/config/auto-write.ts` only treats a top-level `mcpServers` object as an MCP config, but several adapters in `src/adapters/platforms/*` use different config shapes.

**Evidence in current code**
- `src/config/auto-write.ts:240-251`
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
- `src/config/auto-write.ts:254-260` then writes through `data.mcpServers` directly.
- Adapter schemas currently supported elsewhere in the repo:
  - `src/adapters/platforms/codex-cli.ts:30-44` and `src/adapters/platforms/codex-desktop.ts:30-44` use `mcp_servers`
  - `src/adapters/platforms/gptme.ts:30-60` uses `mcp.servers`
  - `src/adapters/platforms/opencode.ts:53-62` uses `mcp`
  - `src/adapters/platforms/zed.ts:42-50` uses `context_servers`
  - `src/adapters/platforms/continue-dev.ts:36-60` uses list-style `mcpServers`

**Root cause**
- The custom-path verifier hardcodes a single schema shape and does not reuse the adapter-specific schema knowledge already present in `src/adapters/platforms/*`.

**Implementation steps**
1. Replace `isMcpConfig()` with schema detection that recognizes the same shapes the adapters support.
2. Add a schema discriminator for at least:
   - object map `mcpServers`
   - object map `mcp_servers`
   - nested `mcp.servers`
   - object `mcp`
   - object map `context_servers`
   - list-style `mcpServers`
3. Add a shape-specific mutation helper so `verifyAndWriteMcpConfig()` updates the correct field in-place.
4. For array-style `mcpServers`, remove any existing `zenith-mcp` entry before appending a new one, to avoid duplicates.
5. Preserve file format semantics: do not convert JSON5/TOML/YAML to plain JSON unless the adapter already does that today.
6. Keep the current backup flow, but ensure it runs before any destructive rewrite.

**Expected code shape**
- Introduce helpers such as:
  ```ts
  type McpSchemaKind =
    | "mcpServersObject"
    | "mcpServersArray"
    | "mcp_servers"
    | "mcpNestedServers"
    | "mcpObject"
    | "context_servers";

  function detectMcpSchema(data: Record<string, unknown>): McpSchemaKind | null { ... }
  function writeZenithEntry(data: Record<string, unknown>, kind: McpSchemaKind): void { ... }
  ```
- The final write path should be a switch on schema kind, not a single `data.mcpServers` mutation.

**Tests/checks to add**
- Add or extend config tests, likely in `tests/` near other config/tool tests.
- Cover:
  - top-level `mcpServers` object
  - Codex-style `mcp_servers`
  - gptme-style `mcp.servers`
  - OpenCode-style `mcp`
  - Zed-style `context_servers`
  - Continue.dev-style array `mcpServers`
  - non-MCP config skipped cleanly
- Run:
  - `npm test`
  - `npm run build`

**Risks / edge cases**
- List-based schemas need duplicate handling; the writer must not append multiple `zenith-mcp` items.
- OpenCode and Zed configs are currently written as plain JSON, so preserving comments is out of scope unless the parser is expanded.

---

## 10. Symbol indexing does not apply sensitive-file filtering

**Issue summary**
- Sensitive-file filtering exists in shared utilities, but `src/core/symbol-index.ts` does not call it before indexing or persisting files.

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
- `src/core/symbol-index.ts:271-287` walks the directory tree and only checks `DEFAULT_EXCLUDES` and `isSupported(fullPath)`:
  ```ts
  if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
  const fullPath = path.join(dir, entry.name); // nosemgrep
  if (entry.isDirectory()) {
      await walk(fullPath);
  } else if (entry.isFile() && isSupported(fullPath)) {
      filePaths.push(fullPath);
  }
  ```
- `src/core/symbol-index.ts:199-265` also has no sensitive-path guard in `indexFile()`.

**Root cause**
- The filtering logic is incomplete: it is present in shared utilities but missing from the indexer entry points.

**Implementation steps**
1. Import `isSensitive` into `src/core/symbol-index.ts`.
2. Add a guard in `indexDirectory()` before adding a file to `filePaths`.
3. Add a guard in `indexFile()` before reading/parsing so direct callers cannot bypass the filter.
4. Use the absolute path for the sensitive check, matching the helper’s expectations.
5. Keep `DEFAULT_EXCLUDES` and `isSupported()` intact; this is an additive security filter.

**Expected code shape**
```ts
if (isSensitive(absFilePath)) return;
```

and in the directory walk:
```ts
if (isSensitive(fullPath)) continue;
```

**Tests/checks to add**
- Extend `tests/symbol-index-core.test.js`.
- Add cases for:
  - `credentials.ts`
  - `secret_config.py`
  - files under a sensitive `.config` path
  - direct `indexFile()` invocation on a sensitive file
- Run:
  - `npm test`
  - `npm run build`

**Risks / edge cases**
- `isSensitive()` is home-directory-relative, so tests should construct paths that actually match `os.homedir()`-relative rules.
- Legitimate files matching the sensitive glob patterns will now be excluded by design.

---

## 12. Committed runtime surface and source surface are not aligned

**Issue summary**
- The committed `dist/` tree contains runtime files without corresponding source files, while `package.json` publishes only `dist`.

**Evidence in current codebase**
- `package.json:15-28`
  ```json
  "bin": {
    "zenith-mcp": "dist/cli/stdio.js",
    "zenith-mcp-http": "dist/server/http.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc && shx cp -r grammars dist/ && shx chmod +x dist/cli/*.js dist/server/*.js"
  }
  ```
- Current `dist/` includes `dist/config/adapter-cli.js`, `dist/config/adapter-settings.js`, and `dist/config/zenith-mcp/*`.
- Current `src/` has `src/config/auto-write.ts`, `backup.ts`, `loader.ts`, `parser.ts`, `schema.ts`, and `wizard.ts`, but no `src/config/adapter-cli.ts`, `src/config/adapter-settings.ts`, or `src/config/zenith-mcp/*`.

**Root cause**
- The build pipeline emits ordinary TypeScript output, but the repository does not enforce a clean parity contract for all committed runtime artifacts.

**Implementation steps**
1. Decide the target invariant:
   - source-first parity, or
   - generated-only `dist/` with legacy files removed.
2. Add a parity check script, ideally `scripts/verify-dist-parity.js`.
3. Have the script compare a clean build against committed `dist/`, or explicitly denylist legacy artifacts.
4. Wire the check into `npm test` or a new `npm run verify:dist` script.
5. If the orphaned files are intended to remain, add source ownership or generation steps for them instead of leaving them as untracked runtime surface.

**Expected code shape**
- A parity script should:
  - run a clean build into a temp dir
  - diff the result against committed `dist/`
  - fail on unexpected files

**Tests/checks to run**
- `npm run build`
- new parity script
- `npm test`

**Risks / edge cases**
- Some runtime JS may be hand-authored on purpose, so the parity check must explicitly allow those cases if that is the intended repository policy.
- Removing `dist/` files without verifying package entrypoints could break published behavior.

---

## P1. Path traversal bypass on Windows — hardcoded `/` separator in containment check

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
- The sibling helper already uses the platform separator correctly:
  - `src/core/project-scope.ts:116-120`
  ```ts
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
  ```

**Root cause**
- The containment check hardcodes POSIX path syntax.

**Implementation steps**
1. Change the suffix from `'/'` to `path.sep`.
2. Keep the comparison semantics consistent with `src/core/project-scope.ts`.
3. Add a Windows-style path test that does not depend on actual Windows filesystem state.

**Expected code shape**
```ts
return resolved === normalizedDir || resolved.startsWith(normalizedDir + path.sep);
```

**Tests/checks to add**
- Extend `tests/path-validation.test.js` with a Windows-path containment case.
- Run `npm test` and `npm run build`.

**Risks / edge cases**
- The test must be OS-agnostic and should use explicit Windows-like strings where possible.

---

## P1. `stripJsoncComments` regex corrupts URLs and string values containing `//`

**Evidence in current code**
- `src/adapters/platforms/opencode.ts:28-43`
  ```ts
  private stripJsoncComments(content: string): string {
    content = content.replace(/\/\/.*?$/gm, "");
    content = content.replace(/\/\*[\s\S]*?\*\//g, "");
    content = content.replace(/,(\s*[}\]])/g, "$1");
    return content;
  }

  readConfig() {
    const isJsonc = p.endsWith(".jsonc") || content.includes("//") || content.includes("/*");
    const cleanContent = isJsonc ? this.stripJsoncComments(content) : content;
    return JSON.parse(cleanContent);
  }
  ```

**Root cause**
- Regex stripping is not string-aware and is applied too broadly.

**Implementation steps**
1. Replace the regex stripper with a proper JSONC parser or a parser-backed comments/trailing-comma remover.
2. Remove the `content.includes("//")` heuristic; JSON text with URLs must not be treated as JSONC just because it contains `//`.
3. Keep the adapter’s read/write behavior consistent with the existing file format.
4. Add tests covering URLs and embedded `//` strings in plain JSON and JSONC.

**Expected code shape**
- Prefer parser-based logic, e.g. `jsonc-parser` style parsing, rather than hand-written regex cleanup.

**Tests/checks to add**
- Extend `tests` for OpenCode adapter reading.
- Include a config value like `http://example.com` and confirm it survives unchanged.
- Run `npm test`.

**Risks / edge cases**
- A parser replacement may slightly change whitespace/comment preservation behavior; that is acceptable if it prevents data corruption.

---

## P1. `win32.basename()` used unconditionally — wrong backup filenames on macOS/Linux

**Evidence in current code**
- `src/adapters/base.ts:1-28`
  ```ts
  import { join, win32 } from "path";
  ...
  const baseName = win32.basename(filePath);
  ```

**Root cause**
- The adapter backup helper uses a Windows-specific basename on all platforms.

**Implementation steps**
1. Import the platform-native `basename` from `path` instead of `path.win32.basename`.
2. Keep the rest of the backup naming logic unchanged.
3. Add a test ensuring a Unix path like `/home/user/.config/foo.json` backs up as `foo.json.bak`, not an absolute-path-derived filename.

**Expected code shape**
```ts
import { join, basename } from "path";
...
const baseName = basename(filePath);
```

**Tests/checks to add**
- Add or extend adapter backup tests.
- Run `npm test`.

**Risks / edge cases**
- On Windows, native `basename()` must still preserve backslash semantics; that is exactly why the native helper is preferred.

---

## P1. `getProjectContext` singleton silently ignores different `ctx` arguments after first call

**Evidence in current code**
- `src/core/project-context.ts:258-265`
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
- The singleton is keyed only on the first `ctx` object and never validates subsequent calls.

**Implementation steps**
1. Decide whether `getProjectContext` should be:
   - one true process-wide singleton, or
   - cached per context identity.
2. If per-context behavior is desired, key the cache by a stable context identity instead of a single global `_instance`.
3. If a singleton is still intended, assert that subsequent calls receive the same `ctx` or explicitly document that they are ignored.
4. Add a test that calls `getProjectContext()` with two different `FsContext` instances and verifies the chosen policy.

**Expected code shape**
- Either a `Map<string, ProjectContext>` cache keyed by a stable context identifier, or a guard that throws on conflicting contexts.

**Tests/checks to add**
- Extend `tests/project-context.test.js`.
- Run `npm test`.

**Risks / edge cases**
- Changing cache semantics may affect all callers that currently assume a process-wide singleton.

---

## P1. `file://` URI parsing doesn't handle percent-encoding or three-slash form correctly

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
- The parser uses naive slicing and does not decode standard `file://` URI forms.

**Implementation steps**
1. Parse `file://` URIs with `new URL(rootUri)` instead of string slicing.
2. Decode percent-encoded paths with `decodeURIComponent`.
3. Handle authorities/hosted file URIs correctly.
4. Keep the non-URI path case working for plain filesystem paths.

**Expected code shape**
- Convert to URL-based path extraction, then normalize.

**Tests/checks to add**
- Extend `tests/roots-utils.test.js` with:
  - `file:///path%20with%20spaces`
  - `file://host/share`
  - plain path input
- Run `npm test`.

**Risks / edge cases**
- Windows file URI forms need careful handling to avoid losing drive letters or UNC semantics.

---

## P1. Broken `_fnmatch` glob matcher in security-sensitive denylist

**Evidence in current code**
- `src/retrieval/telemetry/scanner.ts:71-94`
  ```ts
  function _isDenied(name: string): boolean {
    const lower = name.toLowerCase();
    for (const pattern of DENIED_PATTERNS) {
      if (
        _fnmatch(name, pattern) ||
        _fnmatch(lower, pattern.toLowerCase())
      ) {
        return true;
      }
    }
    return false;
  }

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
- The matcher is substring-based and not anchored, so it overmatches unrelated filenames.

**Implementation steps**
1. Replace `_fnmatch()` with a proper glob matcher or with `minimatch`/regex conversion that anchors the entire name.
2. Preserve the denylist semantics for known patterns such as `.env`, `id_rsa`, and credential filenames.
3. Add tests proving false positives are eliminated and intended matches still work.

**Expected code shape**
- Prefer a single, anchored matcher rather than sequential substring scanning.

**Tests/checks to add**
- Add scanner tests for:
  - `.env` should match `.env`, not `my.environment.txt`
  - `id_rsa` should not match arbitrary substrings
- Run `npm test`.

**Risks / edge cases**
- A stricter matcher may reduce current false positives, which is the intended security improvement.

---

## P1. Fire-and-forget dynamic import causes race condition — Tier 1 fusion unreliable on cold starts

**Evidence in current code**
- `src/retrieval/pipeline.ts:32-44`
  ```ts
  let _weightedRrf: ((env: ScoredTool[], conv: ScoredTool[], alpha: number) => ScoredTool[]) | null = null;
  let _computeAlpha: (...) => number) | null = null;

  import("./ranking/fusion.js").then((f) => {
    _weightedRrf = f.weightedRrf;
    _computeAlpha = f.computeAlpha;
  }).catch(() => { /* Tier 1 unavailable — falls through to Tier 2+ */ });
  ```

**Root cause**
- Fusion functions are loaded asynchronously without synchronization, so early calls can observe nulls.

**Implementation steps**
1. Replace the dynamic import with a static import.
2. Remove the nullable state and use direct function references.
3. If lazy loading must remain, gate `getToolsForList()` on a one-time initialization promise before any tier selection logic runs.

**Expected code shape**
- Prefer:
  ```ts
  import { weightedRrf, computeAlpha } from "./ranking/fusion.js";
  ```

**Tests/checks to add**
- Add a cold-start test that calls `getToolsForList()` immediately after import and confirms Tier 1 is available.
- Run `npm test`.

**Risks / edge cases**
- Static import increases startup coupling, but removes the race and matches the package-local dependency structure.

---

## P1. Fragile coupling to MCP SDK private internals

**Evidence in current code**
- `src/retrieval/zenith-integration.ts:200-213`
  ```ts
  const protocol = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const defaultList = protocol._requestHandlers.get("tools/list");
  const defaultCall = protocol._requestHandlers.get("tools/call");
  ```

**Root cause**
- The code depends on an undocumented/private SDK field.

**Implementation steps**
1. Replace the private-field access with a supported SDK API if one exists.
2. If the SDK lacks a public hook, wrap registration earlier so the required default handlers are captured without private introspection.
3. Add an explicit runtime assertion path if handler capture fails, and make the error message actionable.

**Expected code shape**
- A public-handler registration or wrapper-based approach is preferred over `_requestHandlers` access.

**Tests/checks to add**
- Add a startup test that exercises `installRetrievalRequestHandlers()` and fails cleanly if the SDK surface changes.
- Run `npm test`.

**Risks / edge cases**
- The MCP SDK may require a small refactor of how the server is wired together.

---

## P1. User-supplied regex enables ReDoS — can hang the event loop

**Evidence in current code**
- `src/tools/search_files.ts:571-575`
  ```ts
  const flags = 'gi';
  const contentRegex = args.literalSearch
      ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      : new RegExp(args.contentQuery!, flags);
  ```

**Root cause**
- Untrusted regex is compiled directly with no validation or timeout.

**Implementation steps**
1. Validate user regex before constructing `RegExp`.
2. Prefer a safe search path when possible, such as ripgrep, and avoid JS regex evaluation for attacker-controlled patterns.
3. At minimum, reject obviously dangerous patterns or add a bounded timeout/worker isolation strategy.

**Expected code shape**
- Use a validator function around `new RegExp()` or bypass JS regex entirely for non-literal mode.

**Tests/checks to add**
- Add tests that:
  - accept a normal regex
  - reject or safely handle a catastrophic pattern like `(a+)+$`
- Run `npm test`.

**Risks / edge cases**
- Tightening regex handling may break some advanced queries; document the accepted syntax if you restrict it.

---

## P1. `search_files` definition mode crashes if `definesSymbol` omitted

**Evidence in current code**
- `src/tools/search_files.ts:398-401`
  ```ts
  const MAX_FILE_SIZE = 512 * 1024;
  const symbolName = args.definesSymbol!;
  ```

**Root cause**
- The code uses a non-null assertion instead of validating required input for definition mode.

**Implementation steps**
1. Add explicit validation near the top of definition mode.
2. Return a clear tool error if `definesSymbol` is missing.
3. Keep the existing filtering/search logic unchanged for valid requests.

**Expected code shape**
```ts
if (!args.definesSymbol) {
  throw new Error('definesSymbol required for definition mode.');
}
```

**Tests/checks to add**
- Add a test that calls definition mode without `definesSymbol` and verifies a helpful error.
- Run `npm test`.

**Risks / edge cases**
- This is a behavior change from silent empty results to explicit failure, which is preferable for debuggability.

---

## P2. `tailFile` can corrupt multi-byte UTF-8 characters at chunk boundaries

**Evidence in current code**
- `src/core/lib.ts:237-270`
  ```ts
  const readData = chunk.slice(0, bytesRead).toString('utf-8');
  ```

**Root cause**
- Fixed-size chunk decoding can split multi-byte sequences across boundaries.

**Implementation steps**
1. Use a byte-safe incremental decoding strategy for tail reads.
2. Preserve trailing partial sequences across chunks, or switch to a line-based reverse read algorithm that respects UTF-8 boundaries.
3. Keep the public behavior of returning the last N lines intact.

**Expected code shape**
- A decoder that buffers incomplete UTF-8 sequences between chunk reads.

**Tests/checks to add**
- Add tests with emoji/CJK text straddling a chunk boundary.
- Run `npm test`.

**Risks / edge cases**
- A safer decoder may be slightly more complex but should eliminate mojibake.

---

## P2. `applyFileEdits` only replaces first occurrence of `oldText`

**Evidence in current code**
- `src/core/lib.ts:165-174`
  ```ts
  if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
  }
  ```

**Root cause**
- `String.replace()` with a plain string only changes the first match.

**Implementation steps**
1. Decide whether the API should replace one occurrence or all occurrences.
2. If “all” is intended, use a global replacement strategy.
3. If “first only” is intended, document it clearly and add tests to lock the behavior.
4. Keep the indent-stripped fallback logic unchanged.

**Expected code shape**
- Either `replaceAll()` or an explicit loop over occurrences, plus documentation.

**Tests/checks to add**
- Add tests for duplicate `oldText` occurrences and verify the chosen behavior.
- Run `npm test`.

**Risks / edge cases**
- Changing from first-only to all-occurrences may break existing callers that rely on a single edit.

---

## P1. `x-forwarded-prefix` header injection risk

**Evidence in current code**
- `src/server/http.ts:263-272`
  ```ts
  const forwardedPrefix = typeof req.headers['x-forwarded-prefix'] === 'string'
      ? req.headers['x-forwarded-prefix'].trim()
      : '';
  const normalizedPrefix = forwardedPrefix
      ? (forwardedPrefix.endsWith('/') ? forwardedPrefix.slice(0, -1) : forwardedPrefix)
      : '';
  const messageEndpoint = normalizedPrefix ? `${normalizedPrefix}/messages` : '/messages';
  ```

**Root cause**
- The header is used directly in a URL path without validation.

**Implementation steps**
1. Validate the prefix against a strict allowlist of path segment characters.
2. Reject prefixes containing traversal characters or scheme/host-like fragments.
3. Normalize to a safe path prefix before constructing the endpoint.

**Expected code shape**
- A sanitization function returning either a safe prefix or `''`.

**Tests/checks to add**
- Add HTTP tests for safe and malicious `X-Forwarded-Prefix` values.
- Run `npm test`.

**Risks / edge cases**
- Reverse proxies that supply unusual but valid prefixes may need explicit support.

---

## P1. Empty YAML config files cause runtime TypeError in adapters

**Evidence in current code**
- `src/adapters/helpers/yaml.ts:4-9`
  ```ts
  export function readYaml(path: string): Record<string, unknown> {
    if (!existsSync(path)) {
      return {};
    }
    return YAML.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }
  ```

**Root cause**
- `YAML.load()` can return `undefined` for empty files, but the code casts it to a non-optional object.

**Implementation steps**
1. Default `YAML.load()` to `{}` when it returns `undefined` or `null`.
2. Keep the return type as a record.
3. Add an empty-file test to prevent regressions.

**Expected code shape**
```ts
return (YAML.load(...) ?? {}) as Record<string, unknown>;
```

**Tests/checks to add**
- Add a test for empty YAML input.
- Run `npm test`.

**Risks / edge cases**
- None beyond ensuring empty files behave like empty configs.

---

## P1. Zed adapter uses `JSON.parse()` for JSONC settings file

**Evidence in current code**
- `src/adapters/platforms/zed.ts:29-33`
  ```ts
  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  ```

**Root cause**
- Zed settings commonly contain comments/trailing commas, but the adapter parses plain JSON only.

**Implementation steps**
1. Switch to a JSONC-capable parser for `settings.json`.
2. Preserve the rest of the adapter’s read/write behavior.
3. Add tests with comments and trailing commas.

**Expected code shape**
- `readConfig()` should parse JSONC input safely instead of calling `JSON.parse()` directly.

**Tests/checks to add**
- Extend Zed adapter tests with commented JSON input.
- Run `npm test`.

**Risks / edge cases**
- The writer still emits plain JSON today; that is acceptable unless you also want comment preservation.

---

## P2. `compressTextFile` subprocess path is likely broken — dead code path

**Evidence in current code**
- `src/core/compression.ts:54-78`
  ```ts
  const child = spawn(process.execPath, [_BRIDGE, validPath, String(budget)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ```
- `_BRIDGE` points to `toon_bridge.js`.

**Root cause**
- The subprocess path may no longer match the current in-process bridge contract.

**Implementation steps**
1. Verify that `dist/core/toon_bridge.js` can still execute as a CLI entrypoint.
2. If not, either add a proper CLI wrapper or replace the subprocess call with a direct module invocation.
3. Preserve the fallback to `null` on failure.

**Tests/checks to add**
- Add a compression integration test that exercises the subprocess path.
- Run `npm test`.

**Risks / edge cases**
- The bridge may already work in practice; verify before changing the API.

---

## P2. `offsetReadFile` returns inaccurate `totalLines` when stream is destroyed early

**Evidence in current code**
- `src/core/lib.ts:303-330`
  ```ts
  if (collected.length >= length) {
      rl.close();
      stream.destroy();
  }
  ```
- `totalLines` only tracks lines seen before early exit.

**Root cause**
- The function conflates “lines read so far” with “actual total file lines.”

**Implementation steps**
1. Decide whether `totalLines` should mean “observed lines” or the whole-file count.
2. If full count is needed, compute it separately or avoid destroying the stream before the count is known.
3. Keep the returned selected lines unchanged.

**Tests/checks to add**
- Add tests that assert the documented `totalLines` semantics.
- Run `npm test`.

**Risks / edge cases**
- Counting the entire file adds cost, so only do it if callers truly rely on it.

---

## P2. RelevanceRanker score grouping creates arbitrarily wide groups

**Evidence in current code**
- `src/retrieval/ranking/ranker.ts:32-52`
  ```ts
  let tiedGroup: ScoredTool[] = [];
  let groupScore: number | null = null;
  ...
  if (groupScore === null || Math.abs(groupScore - tool.score) < SCORE_TOLERANCE) {
    tiedGroup.push(tool);
    if (groupScore === null) groupScore = tool.score;
    continue;
  }
  ```

**Root cause**
- Grouping is anchored to the first item in a group rather than to adjacent deltas.

**Implementation steps**
1. Decide whether grouping should be anchor-based or sliding-window based.
2. If the intent is “similar adjacent scores,” compare each item against the previous item, not the first.
3. Keep the specificity-based tie-breaker after grouping.

**Tests/checks to add**
- Add ranker tests with slowly decaying scores to lock in the intended grouping behavior.
- Run `npm test`.

**Risks / edge cases**
- Changing the grouping strategy can reorder borderline tools.

---

## P2. Synchronous `existsSync` calls in marker detection loop block event loop

**Evidence in current code**
- `src/utils/project-scope.ts:200-235`
  ```ts
  if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) {
    candidates.push(dir);
    ...
  }
  ```

**Root cause**
- The marker scan is synchronous and repeated at every directory level.

**Implementation steps**
1. Replace synchronous marker checks with async `fs.promises.access()` or batched existence tests.
2. Keep the marker resolution semantics unchanged.
3. Preserve cache behavior.

**Tests/checks to add**
- Add a project-scope test around marker resolution.
- Run `npm test`.

**Risks / edge cases**
- Async marker probing may complicate the resolution ladder but will reduce event-loop blocking.

---

## P2. Unbounded `_cache` Map in project-scope grows without limit

**Evidence in current code**
- `src/utils/project-scope.ts:50-75`
  ```ts
  const _cache = new Map<string, string | null>();
  ```
- Entries are never evicted.

**Root cause**
- The module-level cache has no size cap or eviction policy.

**Implementation steps**
1. Add an LRU or fixed-capacity cache.
2. Keep cache invalidation hooks such as `clearProjectScopeCache()`.
3. Ensure repeated resolutions still hit the cache efficiently.

**Tests/checks to add**
- Add a cache eviction test if the cache is made bounded.
- Run `npm test`.

**Risks / edge cases**
- A small cache could reduce hit rates; choose a capacity aligned with current usage.

---

## P2. `patchToolsInConfig` catch block is too broad — may overwrite config on permission errors

**Evidence in current code**
- `src/config/loader.ts:166-176`
  ```ts
  try {
    fileContent = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    const config = loadConfig();
    config.tools = tools;
    saveConfig(config);
    return;
  }
  ```

**Root cause**
- Any read failure is treated as file-not-found.

**Implementation steps**
1. Narrow the catch to `ENOENT` only.
2. Re-throw or surface permission and corruption errors instead of silently rewriting.
3. Keep the first-time creation fallback for missing files.

**Tests/checks to add**
- Add tests for missing file vs permission/error conditions.
- Run `npm test`.

**Risks / edge cases**
- If the file is genuinely missing, the fallback path should continue to create it.

---

## P2. `read_file.ts` puts `[truncated]` at top instead of bottom

**Evidence in current code**
- `src/tools/read_file.ts:108-113`
  ```ts
  const text = (budgetExhausted ? '[truncated]\n' : '') + outputLines.join('\n');
  ```

**Root cause**
- The truncation marker is prepended even though the end of the view is what was cut off.

**Implementation steps**
1. Move the truncation notice to the bottom of the output, matching the semantics used by other tools.
2. Keep the content lines intact.
3. Ensure the marker still appears when budget is exhausted.

**Tests/checks to add**
- Add a read-file truncation test.
- Run `npm test`.

**Risks / edge cases**
- Any downstream parser expecting the marker first will need to be updated, but the current placement is misleading.

---

## P2. Session creation race condition in streamable HTTP transport

**Evidence in current code**
- `src/server/http.ts:208-218`
  ```ts
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  const sid = transport.sessionId;
  if (sid) {
      sessions.set(sid, { ... });
  }
  ```

**Root cause**
- The session is stored after the initialize request is handled, leaving a brief window where follow-up requests can miss it.

**Implementation steps**
1. Store the session entry as early as the transport/session identifier is available.
2. If required, pre-allocate a placeholder session and fill it in after `handleRequest()` returns.
3. Keep cleanup semantics on transport close.

**Tests/checks to add**
- Add a transport-level race test if feasible.
- Run `npm test`.

**Risks / edge cases**
- Ordering changes must not break the initialize handshake.

---

## P2. `readFileSync` in `freqPrior` blocks event loop on every `getToolsForList` call

**Evidence in current code**
- `src/retrieval/pipeline.ts:244-246` in the review refers to the frequency-prior path.
- Current file still uses synchronous file reads for the frequency prior when Tier 5 is reached.

**Root cause**
- The retrieval path synchronously reads a log file during tool selection.

**Implementation steps**
1. Switch the frequency-prior data source to async loading or a cached snapshot.
2. If the file must be read synchronously, do it once at startup or behind a TTL cache.
3. Preserve the ranking semantics.

**Tests/checks to add**
- Add a retrieval pipeline test that exercises the Tier 5 path.
- Run `npm test`.

**Risks / edge cases**
- Caching stale prior data can change ranking; document cache refresh behavior.

---

## P2. FileRetrievalLogger race condition — log calls can precede directory creation

**Evidence in current code**
- `src/retrieval/observability/logger.ts:41-45`
  ```ts
  constructor(logPath: string) {
    this._path = logPath;
    mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }
  ```

**Root cause**
- Directory creation is fire-and-forget, so the first write can race with mkdir.

**Implementation steps**
1. Make directory creation part of the logger’s initialization promise, or lazily await it on first write.
2. Keep logging failure non-fatal, but avoid the initial race.
3. Do not swallow mkdir errors silently if they prevent logging.

**Tests/checks to add**
- Add a logger test that writes immediately after construction.
- Run `npm test`.

**Risks / edge cases**
- Making the constructor async may require a small API change; a lazy-init promise is usually less invasive.

---

## P2. Missing `process.exit` after usage error in CLI entry point

**Evidence in current code**
- `src/cli/stdio.ts:19-25`
  ```ts
  if (dirArgs.length === 0) {
    console.error("Usage: zenith-mcp [allowed-directory] [additional-directories...]");
    ...
  }
  ```

**Root cause**
- The CLI prints usage text but continues startup.

**Implementation steps**
1. Exit immediately after printing the usage error when no directories are provided.
2. Keep the fallback messaging for client-provided roots if that path is still valid elsewhere.

**Expected code shape**
```ts
process.exit(1);
```

**Tests/checks to add**
- Add a CLI test for zero-argument invocation.
- Run `npm test`.

**Risks / edge cases**
- If the server is meant to run solely from MCP roots negotiation, this behavior needs to be reconsidered; the current code clearly treats missing directories as a usage error.

---

## P2. Opencode adapter's `writeConfig` always writes plain JSON, destroying JSONC comments

**Evidence in current code**
- `src/adapters/platforms/opencode.ts:46-50`
  ```ts
  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
  ```

**Root cause**
- Read path may accept JSONC, but write path always serializes plain JSON.

**Implementation steps**
1. Preserve the original file style if the input was JSONC and the user expects comments to survive.
2. If comment preservation is out of scope, document the destructive behavior explicitly and treat it as an intentional limitation.
3. Prefer a JSONC-aware writer if comment retention matters.

**Tests/checks to add**
- Add a test that starts from a commented config and verifies the chosen behavior.
- Run `npm test`.

**Risks / edge cases**
- Comment preservation requires a more capable serializer than `JSON.stringify`.

---

## P2. SQLite connection is never closed — WAL journal may not checkpoint on exit

**Evidence in current code**
- `src/config/backup.ts:32-43` uses a lazy SQLite connection and does not close it.

**Root cause**
- The connection lifecycle is not tied to process shutdown.

**Implementation steps**
1. Add an explicit close path for the SQLite connection.
2. Register shutdown hooks so the DB is closed on process exit.
3. Preserve current lazy-open behavior.

**Tests/checks to add**
- Add a backup/DB lifecycle test if possible.
- Run `npm test`.

**Risks / edge cases**
- Closing too early could interfere with late writes; close only at shutdown.

---

## P2. `sessionIdFromExtra` falls back to `"default"` — multi-client state bleeding

**Evidence in current code**
- `src/retrieval/zenith-integration.ts:82-89`
  ```ts
  function sessionIdFromExtra(extra: unknown): string {
    const maybe = extra as { sessionId?: unknown; requestId?: unknown } | undefined;
    return typeof maybe?.sessionId === "string"
      ? maybe.sessionId
      : typeof maybe?.requestId === "string"
        ? maybe.requestId
        : "default";
  }
  ```

**Root cause**
- Unidentified requests all collapse into a single shared session id.

**Implementation steps**
1. Replace the shared fallback with a caller-provided or transport-derived unique session identifier.
2. If a default is still required, make it per-connection rather than a global literal.
3. Ensure the retrieval pipeline state is isolated per client session.

**Tests/checks to add**
- Add a multi-client retrieval test that exercises separate state.
- Run `npm test`.

**Risks / edge cases**
- Changing the default may alter history/demotion behavior for clients that currently omit session IDs.

---

## P2. `_retryState` Map in refactor_batch grows unboundedly

**Evidence in current code**
- `src/tools/refactor_batch.ts:140-144`

**Root cause**
- Retry counts are keyed by repo/session/symbol and never evicted.

**Implementation steps**
1. Add TTL eviction or an LRU bound for `_retryState`.
2. Ensure completed or stale entries are removed after use.
3. Keep retry semantics intact within a session.

**Tests/checks to add**
- Add a retry-state cleanup test.
- Run `npm test`.

**Risks / edge cases**
- Too-aggressive eviction could reset legitimate retry history mid-operation.

---

## P3. `patchToolsInConfig` may consume trailing newline when `### Tools` is last section

**Evidence in current code**
- `src/config/loader.ts:178-220` handles `toolsEnd = lines.length` and rebuilds the block.

**Root cause**
- The splice-based rewrite can eat the trailing newline when the tools section runs to EOF.

**Implementation steps**
1. Preserve the final newline explicitly when rewriting the `### Tools` section.
2. If needed, keep the original line ending mode and append a newline sentinel after the block.

**Tests/checks to add**
- Add a loader test for a config file ending with `### Tools`.
- Run `npm test`.

**Risks / edge cases**
- Text preservation behavior may differ slightly, but the final newline should be kept stable.

---

## P3. Raycast adapter lists Linux as supported platform — Raycast is macOS-only

**Evidence in current code**
- `src/adapters/platforms/raycast.ts:1-10` currently declares support for `macos`, `linux`, and `windows`.

**Root cause**
- The support matrix is broader than the product’s actual platform availability.

**Implementation steps**
1. Restrict the adapter to macOS support only.
2. Keep the config-path logic unchanged unless platform gating requires further cleanup.

**Tests/checks to add**
- Add a platform-support test for Raycast.
- Run `npm test`.

**Risks / edge cases**
- This is mostly a correctness/UX fix; it should reduce pointless discovery attempts on unsupported OSes.

---

## P3. `formatSize` doesn't guard against negative byte values

**Evidence in current code**
- `src/core/lib.ts:74-83`
  ```ts
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  ```

**Root cause**
- Negative inputs produce `NaN` and fall through awkwardly.

**Implementation steps**
1. Guard negative values up front.
2. Decide on a policy: clamp to `0 B` or return a signed representation.
3. Keep positive behavior unchanged.

**Tests/checks to add**
- Add a negative-size test.
- Run `npm test`.

**Risks / edge cases**
- The safest option is to return a stable, readable string such as `0 B` for negatives.

---

## P3. Tokenizer regex inconsistency between `bmx-index.ts` and `bmx-plus.ts`

**Evidence in current code**
- `src/retrieval/ranking/bmx-index.ts:54`
- Related tokenizer logic differs from `src/toon/bmx-plus.ts`.

**Root cause**
- The two tokenizers use different token definitions, which can skew comparable scores.

**Implementation steps**
1. Choose one tokenization rule and standardize both implementations.
2. Update any tests that depend on token counts.
3. Document the chosen tokenizer if comparison across modules is expected.

**Tests/checks to add**
- Add tokenizer comparison tests.
- Run `npm test`.

**Risks / edge cases**
- Tokenization changes can subtly alter ranking results; the point is to make them consistent.

---

## P3. Median calculation uses floor-based upper median instead of true median

**Evidence in current code**
- `src/toon/pipeline.ts:433-438`

**Root cause**
- Even-length arrays use the upper middle element instead of the average of the two middle values.

**Implementation steps**
1. Replace the upper-median logic with a true median calculation.
2. Keep the rest of the hubness and MAD calculations unchanged.

**Tests/checks to add**
- Add a unit test for even-length arrays.
- Run `npm test`.

**Risks / edge cases**
- Small numeric changes can alter hub classification thresholds.

---

## P3. Warp adapter `configPath()` returns directory on macOS/Windows, file on Linux

**Evidence in current code**
- `src/adapters/platforms/warp.ts:12-31`

**Root cause**
- The adapter’s `configPath()` returns a directory in dir-mode platforms and a file on Linux, which makes backup/write semantics inconsistent.

**Implementation steps**
1. Normalize the meaning of `configPath()` across platforms.
2. If directory mode is intended on macOS/Windows, make that explicit with a separate helper for directory-vs-file mode.
3. If a file is required, return a file path on all platforms.

**Tests/checks to add**
- Add platform-specific path tests.
- Run `npm test`.

**Risks / edge cases**
- Changing the path semantics may require a small write-path refactor.

---

## P3. Silent swallowing of parse errors in Warp directory mode

**Evidence in current code**
- `src/adapters/platforms/warp.ts:46-55`
  ```ts
  try {
    const files = readdirSync(p).filter(f => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(p, file), "utf-8"));
        ...
      } catch {}
    }
  } catch {}
  ```

**Root cause**
- Parse errors are intentionally swallowed without user feedback.

**Implementation steps**
1. Surface parse failures in a warning or error message.
2. Keep discovery resilient by continuing past bad files, but do not fail silently.
3. Preserve successful file discovery.

**Tests/checks to add**
- Add a test with one malformed JSON file in the Warp directory.
- Run `npm test`.

**Risks / edge cases**
- More logging may be noisy, but it is better than opaque discovery failures.

---

## Verification checklist

After applying the actual source fixes, run:

1. `npm run build`
2. `npm test`
3. Any new parity/check scripts introduced for `dist/` alignment

For the schema and adapter fixes, also verify the relevant adapter tests and any new regression tests added for the affected tool.
