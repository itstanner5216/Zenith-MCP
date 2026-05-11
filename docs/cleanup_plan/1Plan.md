# Zenith-MCP Review 1 — Implementation Plan

This plan is based on the current codebase state in `/home/tanner/Projects/Zenith-MCP` and the review findings in `docs/reviews/1.md`.

I verified the current implementation before planning and only kept items that still map to code in the tree. Where the review text was stale or overstated, I corrected the claim to match the code as it exists now.

---

## 1) [P0] Stateful regex with `g` flag silently drops ~50% of content search matches

**Review summary:** In `src/tools/search_files.ts`, the JS fallback content-search path compiles the query with `gi` and reuses the same regex across lines. Because global regexes are stateful, `.test()` can alternate success/failure and miss matches.

### Evidence in current code
- `src/tools/search_files.ts:568-654`
  ```ts
  const userMaxResults = Math.min(500, Math.max(1, args.maxResults ?? 50));
  const contextLines = Math.max(0, args.contextLines ?? 0);
  const allExcludes = DEFAULT_EXCLUDE_GLOBS;
  const flags = 'gi';
  const contentRegex = args.literalSearch
      ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // nosemgrep
      : new RegExp(args.contentQuery!, flags); // nosemgrep
  ```
  and later:
  ```ts
  if (contentRegex.test(lines[i])) {
      contentResults.push(`${filePath}:${i + 1}: ${lines[i].trim().slice(0, 500)}`);
  }
  ```

### Root cause
The `g` flag makes the regex stateful via `lastIndex`. Reusing the same instance across repeated `.test()` calls on individual lines can skip matches.

### Exact implementation steps
1. In `src/tools/search_files.ts`, change the fallback regex construction so the regex used for per-line tests is not global.
2. Keep `i` for case-insensitive matching.
3. Remove `g` from the flags, or reset `contentRegex.lastIndex = 0` before each `.test()` call.
4. If a future count path depends on repeated scans, ensure it does not reuse a global regex instance.

### Expected code shape
```ts
const flags = 'i';
const contentRegex = args.literalSearch
  ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  : new RegExp(args.contentQuery!, flags);
```

### Tests / checks
- Add or update tests in `tests/search-files.test.js`.
- Add a regression test that creates several lines containing the same token and asserts all matching lines are returned in content mode.
- Run:
  - `npm test -- tests/search-files.test.js` if supported locally, or
  - `vitest run tests/search-files.test.js`

### Risks / edge cases
- Removing `g` should not affect per-line matching semantics.
- If the code is later refactored to count multiple matches per line, use a separate matcher for that path.

---

## 2) [P1] Path traversal bypass on Windows — hardcoded `/` separator in containment check

**Review summary:** `isPathWithinAllowedDirectories` uses `resolved.startsWith(normalizedDir + '/')`, which fails on Windows because resolved paths use backslashes.

### Evidence in current code
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

### Root cause
The containment check hardcodes `/` as the path separator. On Windows, `path.resolve()` returns backslash-separated paths, so the prefix check is ineffective.

### Exact implementation steps
1. Replace the hardcoded `/` with `path.sep`.
2. Preserve the exact-match case for the allowed directory itself.
3. Verify the logic still blocks `C:\allowedness` when checking `C:\allowed`.

### Expected code shape
```ts
return resolved === normalizedDir || resolved.startsWith(normalizedDir + path.sep);
```

### Tests / checks
- Extend `tests/path-validation.test.js` with a Windows-style containment case.
- Run `vitest run tests/path-validation.test.js`.

### Risks / edge cases
- Make sure UNC paths still behave correctly.
- Keep the exact-match branch so the allowed directory itself remains valid.

---

## 3) [P1] `stripJsoncComments` regex corrupts URLs and string values containing `//`

**Review summary:** `src/adapters/platforms/opencode.ts` uses regex-based JSONC stripping and a `content.includes("//") || content.includes("/*")` heuristic, which corrupts JSON string values that contain URL-like content.

### Evidence in current code
- `src/adapters/platforms/opencode.ts:28-43`
  ```ts
  private stripJsoncComments(content: string): string {
    content = content.replace(/\/\/.*?$/gm, "");
    content = content.replace(/\/\*[\s\S]*?\*\//g, "");
    content = content.replace(/,(\s*[}\]])/g, "$1");
    return content;
  }
  ...
  const isJsonc = p.endsWith(".jsonc") || content.includes("//") || content.includes("/*");
  const cleanContent = isJsonc ? this.stripJsoncComments(content) : content;
  return JSON.parse(cleanContent);
  ```

### Root cause
Regex cannot distinguish comments from `//` inside quoted string values, so valid JSON with URLs becomes invalid after stripping. The heuristic also forces the broken path for plain JSON files that merely contain URLs.

### Exact implementation steps
1. Replace the regex-based stripping with a real JSONC-capable parser.
2. Reuse the shared helper at `src/adapters/helpers/json5.ts` where possible (`readJson5` already exists and uses `JSON5.parse`).
3. Remove the `content.includes("//") || content.includes("/*")` heuristic.
4. Decide whether the adapter should support both `.json` and `.jsonc`; if yes, parse through the JSON5/JSONC path consistently for both.
5. Update `writeConfig` separately if preserving comments is required; see issue 26.

### Expected code shape
```ts
import { readJson5 } from "../helpers/json5.js";
...
readConfig() {
  const p = this.configPath();
  if (!p || !existsSync(p)) return {};
  return readJson5(p);
}
```

### Tests / checks
- Add tests for OpenCode config parsing with:
  - a JSON string containing `http://...`
  - a file with actual `//` comments
  - a plain `.json` file with URLs but no comments
- Use the closest adapter test file, likely `tests/adapters/opencode.test.js` if added.

### Risks / edge cases
- JSON5 parsing may accept syntax that the current write path cannot round-trip.
- If the adapter is expected to preserve comments, parsing alone is not enough; the write path must be comment-aware too.

---

## 4) [P1] `win32.basename()` used unconditionally — produces wrong backup filenames on macOS/Linux

**Review summary:** `src/adapters/base.ts` uses `path.win32.basename` for backup naming on every platform. On Unix, this can produce a backup file name containing the whole absolute path.

### Evidence in current code
- `src/adapters/base.ts:19-27`
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

### Root cause
`win32.basename()` only understands backslashes as separators. On Linux/macOS, it does not strip POSIX path segments, so the backup filename can become the full path string.

### Exact implementation steps
1. Replace `win32.basename` with platform-native `basename` from `path`.
2. Keep the backup directory logic intact unless other review items require changes.
3. Verify backup naming for both direct-path backups and custom backup directories.

### Expected code shape
```ts
import { join, basename } from "path";
...
const baseName = basename(filePath);
```

### Tests / checks
- Add or extend adapter backup tests if available.
- Verify that on POSIX a path like `/home/user/.config/foo.json` creates `foo.json.bak`, not an absolute-path filename.

### Risks / edge cases
- Verify mixed-separator Windows paths still behave as expected when passed through Node's native `basename`.

---

## 5) [P1] `getProjectContext` singleton silently ignores different `ctx` arguments after first call

**Review summary:** `getProjectContext(ctx)` caches a single `ProjectContext` instance and always returns it, even if later callers pass a different filesystem context.

### Evidence in current code
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
- Call sites that rely on this shared instance include:
  - `src/core/stash.ts:24-26`
  - `src/tools/refactor_batch.ts:278`

### Root cause
The singleton is process-global, but the API takes a per-call `FsContext`. Once initialized, later calls cannot update the context or its allowed directories.

### Exact implementation steps
1. Remove the singleton cache and create a fresh `ProjectContext` per caller/session.
2. If shared state must remain, cache per `FsContext` identity or per session key rather than globally.
3. If a singleton must remain, detect when the supplied context changes and either refresh/rebind or throw a clear error instead of silently ignoring the new context.
4. Audit HTTP and session-scoped callers that expect isolation.

### Expected code shape
A per-context cache keyed by session/ctx identity is safer than the current process-global singleton.

### Tests / checks
- Extend `tests/project-context.test.js` to cover two different `FsContext` objects returning different allowed directories.
- Verify that the second context is not ignored.

### Risks / edge cases
- This change can affect every caller that currently depends on the singleton preserving state.
- Be explicit about whether project binding should be shared across sessions or isolated.

---

## 6) [P1] `file://` URI parsing doesn't handle percent-encoding or three-slash form correctly

**Review summary:** `parseRootUri` in `src/core/roots-utils.ts` strips `file://` by `slice(7)` and then resolves the remainder as a path. This can mangle standard `file:///...` and encoded URIs.

### Evidence in current code
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

### Root cause
The code assumes `file://` URIs are simple string prefixes. Real `file:` URIs may include three slashes, percent-encoding, and authority segments; naïve slicing loses that information.

### Exact implementation steps
1. Parse `file:` URIs with the standard `URL` API.
2. Use `decodeURIComponent` or `new URL(uri).pathname` to extract the path.
3. Preserve support for plain filesystem paths that do not start with `file://`.
4. Keep the existing `~/` expansion path handling for non-URL inputs.

### Expected code shape
```ts
if (rootUri.startsWith('file://')) {
  const url = new URL(rootUri);
  rawPath = decodeURIComponent(url.pathname);
}
```

### Tests / checks
- Extend `tests/roots-utils.test.js` with cases for:
  - `file:///tmp/space%20dir`
  - `file:///tmp/dir/with%23hash`
  - `file://host/share` if UNC/authority support is expected, or document that it is unsupported
- Run `vitest run tests/roots-utils.test.js`.

### Risks / edge cases
- `new URL()` behaves differently on Windows drive-letter URIs; verify the platform behavior if Windows support is important.
- Decide whether authority-host `file://host/path` should be accepted or rejected explicitly.

---

## 7) [P1] Broken `_fnmatch` glob matcher in security-sensitive denylist

**Review summary:** The denylist matcher in `src/retrieval/telemetry/scanner.ts` checks only ordered substring presence and does not enforce glob boundaries.

### Evidence in current code
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

### Root cause
The matcher is not anchored and does not implement real glob semantics. A pattern like `.env` matches any string containing `.env`, and patterns with `*` can match far more than intended.

### Exact implementation steps
1. Replace `_fnmatch` with a proper glob matcher or minimize the matcher to exact filename checks for the current denylist patterns.
2. Since these are security-sensitive denylist patterns, prefer explicit checks for known patterns over a loose homemade glob implementation.
3. If using a glob library, ensure it matches full filenames/paths, not substrings.
4. Review the denylist pattern set after changing matching semantics to confirm each pattern still does what was intended.

### Expected code shape
A safer approach is to check exact names and exact suffix/prefix patterns explicitly rather than inventing a matcher.

### Tests / checks
- Add scanner tests for:
  - exact `.env`
  - `.env.local`
  - false positives like `my.environment.txt`
  - secret key names that should not match unrelated substrings

### Risks / edge cases
- Tightening matching may reduce overblocking, which is desirable here.
- Keep path-vs-basename semantics clear; the current implementation uses `name`, not full path.

---

## 8) [P1] Fire-and-forget dynamic import causes race condition — Tier 1 fusion unreliable on cold starts

**Review summary:** `src/retrieval/pipeline.ts` starts loading the fusion module in a top-level `import().then()` and proceeds with null globals until that promise resolves. Cold-start requests can therefore skip Tier 1.

### Evidence in current code
- `src/retrieval/pipeline.ts:34-43`
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

### Root cause
The module initializes asynchronously without any await or readiness gating. Requests that arrive before the import resolves will see null function pointers and skip the Tier 1 fusion path.

### Exact implementation steps
1. Replace the fire-and-forget dynamic import with a static import from `./ranking/fusion.js`.
2. If the dependency must remain optional, wrap it in a proper initialization function that the pipeline awaits before `getToolsForList` can proceed.
3. Since the fusion module is in the same package, a direct import is the simplest fix.

### Expected code shape
```ts
import { weightedRrf, computeAlpha } from "./ranking/fusion.js";
```

### Tests / checks
- Add a test that exercises `getToolsForList` immediately after construction and confirms Tier 1 logic is available.
- Run retrieval pipeline tests and a full build.

### Risks / edge cases
- A static import may introduce circular-dependency issues if one exists.
- Verify the import graph before changing.

---

## 9) [P1] Fragile coupling to MCP SDK private internals

**Review summary:** `src/retrieval/zenith-integration.ts` accesses `server.server._requestHandlers`, a private implementation detail of the MCP SDK.

### Evidence in current code
- `src/retrieval/zenith-integration.ts:200-213`
  ```ts
  export function installRetrievalRequestHandlers(
    server: McpServer,
    pipeline: RetrievalPipeline,
    registry: ZenithToolRegistry,
  ): void {
    const protocol = server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    };
    const defaultList = protocol._requestHandlers.get("tools/list");
    const defaultCall = protocol._requestHandlers.get("tools/call");

    if (!defaultList || !defaultCall) {
      throw new Error("MCP tool handlers are not initialized");
    }
  ```

### Root cause
The implementation relies on an internal property not guaranteed by the SDK. If the SDK changes that internal storage, startup can fail.

### Exact implementation steps
1. Remove the dependence on `_requestHandlers` and use public APIs only.
2. If the SDK exposes a way to delegate to the original handler, use that.
3. If no public delegation API exists, restructure the integration so the server’s tool handling is wrapped earlier rather than monkey-patching private state.
4. Avoid the current `as unknown as` cast chain; if a workaround remains necessary, isolate it behind a narrow compatibility layer and document it.

### Expected code shape
This is architectural rather than a one-line edit. The resulting code should retrieve and invoke tool-list/call behavior through documented APIs or owned handlers rather than private maps.

### Tests / checks
- Add or adjust integration tests that boot the retrieval wiring with the current SDK version.
- Verify startup still succeeds when request handlers are installed.

### Risks / edge cases
- This may require refactoring how request handlers are composed.
- Ensure the routing tool and tool registry mirror remain consistent after the change.

---

## 10) [P1] User-supplied regex enables ReDoS — can hang the event loop

**Review summary:** `src/tools/search_files.ts` passes `args.contentQuery` directly to `new RegExp()` when `literalSearch` is false.

### Evidence in current code
- `src/tools/search_files.ts:571-574`
  ```ts
  const flags = 'gi';
  const contentRegex = args.literalSearch
      ? new RegExp(args.contentQuery!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // nosemgrep
      : new RegExp(args.contentQuery!, flags); // nosemgrep
  ```

### Root cause
Arbitrary user input becomes a JavaScript regular expression. Catastrophic backtracking patterns can monopolize the event loop.

### Exact implementation steps
1. Decide on one of these mitigation strategies:
   - accept only literal search in the in-process fallback,
   - sanitize and/or lint the regex before use,
   - or remove the JS regex fallback entirely in favor of ripgrep.
2. The safest route is to avoid `new RegExp(userInput)` in the in-process fallback.
3. If regex searches must remain, constrain them to a safe subset or add validation plus a hard fallback to literal search.
4. Keep the literal search path available and preserve current user-facing behavior where possible.

### Expected code shape
Prefer something like a safe escaping helper or route regex searches through a safer backend.

### Tests / checks
- Add a test that uses a pathological pattern such as `(a+)+$` and ensures the tool rejects it or handles it safely.
- Run `tests/search-files.test.js` and any search-file regression tests.

### Risks / edge cases
- Rejecting regex search may be a breaking change.
- If so, communicate it clearly or maintain a limited safe regex subset.

---

## 11) [P1] `search_files` definition mode should validate `definesSymbol` instead of silently returning no results

**Review summary:** In `definition` mode, `args.definesSymbol!` is used without validation. The current code does not throw, but it does produce an unhelpful empty result when the argument is omitted.

### Evidence in current code
- `src/tools/search_files.ts:398-401`
  ```ts
  const BATCH_SIZE = 50;
  const MAX_FILE_SIZE = 512 * 1024;
  const symbolName = args.definesSymbol!;
  interface DefinitionSymbol {
      name: string;
      type: string;
      line: number;
      endLine: number;
  }
  ```

### Root cause
The tool assumes the schema/consumer always supplies `definesSymbol`, but the runtime path does not enforce that precondition with a clear error.

### Exact implementation steps
1. Add an explicit guard at the top of `definition` mode.
2. If `args.definesSymbol` is missing or empty, throw a descriptive error or return a validation error message.
3. Remove the non-null assertion if it is no longer needed.
4. Keep the rest of the search flow unchanged.

### Expected code shape
```ts
if (!args.definesSymbol) {
  throw new Error('definesSymbol required for definition mode.');
}
const symbolName = args.definesSymbol;
```

### Tests / checks
- Add a regression test in `tests/search-files.test.js` that calls `mode: 'definition'` without `definesSymbol` and expects a clear error.

### Risks / edge cases
- Because the schema currently marks `definesSymbol` optional, runtime validation is the only protection.
- The fix should not silently return zero matches.

---

## 12) [P1] `x-forwarded-prefix` header injection risk

**Review summary:** `src/server/http.ts` uses the `X-Forwarded-Prefix` header directly when building the SSE message endpoint.

### Evidence in current code
- `src/server/http.ts:265-271`
  ```ts
  const forwardedPrefix = typeof req.headers['x-forwarded-prefix'] === 'string'
      ? req.headers['x-forwarded-prefix'].trim()
      : '';
  const normalizedPrefix = forwardedPrefix
      ? (forwardedPrefix.endsWith('/') ? forwardedPrefix.slice(0, -1) : forwardedPrefix)
      : '';
  const messageEndpoint = normalizedPrefix ? `${normalizedPrefix}/messages` : '/messages';
  ```

### Root cause
The header is not validated as a safe, normalized path prefix. A malicious proxy or attacker who can set the header could inject path traversal-like values or unexpected absolute URLs.

### Exact implementation steps
1. Validate the forwarded prefix before using it.
2. Accept only a single absolute path prefix with no `..`, no backslashes, no scheme/host, and no repeated slashes.
3. Normalize the prefix so it always starts with `/` and does not end with `/`.
4. If validation fails, ignore the header and fall back to `/messages`.

### Expected code shape
```ts
function sanitizeForwardedPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('\\')) return null;
  return trimmed.replace(/\/+$/, '');
}
```

### Tests / checks
- Add HTTP transport tests for safe prefixes and rejected prefixes.
- Verify the resulting message endpoint is exactly `/messages` when the header is invalid.

### Risks / edge cases
- Some proxies may emit prefixes with odd formatting; strict validation could cause them to be ignored.
- Validate the behavior carefully in transport tests.

---

## 13) [P1] Empty YAML config files cause runtime TypeError in adapters

**Review summary:** `src/adapters/helpers/yaml.ts` casts `YAML.load()` to an object, but empty YAML files return `undefined`.

### Evidence in current code
- `src/adapters/helpers/yaml.ts:4-9`
  ```ts
  export function readYaml(path: string): Record<string, unknown> {
    if (!existsSync(path)) {
      return {};
    }
    return YAML.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }
  ```

### Root cause
`YAML.load('')` yields `undefined`, not an object. The cast hides the issue and downstream code dereferences properties on `undefined`.

### Exact implementation steps
1. Coalesce the loader result to `{}`.
2. Optionally type-check that the parsed value is a plain object before returning it.
3. Keep read behavior consistent for empty files and non-existent files.

### Expected code shape
```ts
return (YAML.load(readFileSync(path, "utf-8")) ?? {}) as Record<string, unknown>;
```

### Tests / checks
- Add a unit test for empty YAML files returning `{}`.
- Run adapter helper tests if present.

### Risks / edge cases
- A YAML file whose root is a scalar or array should also be handled deliberately.
- Decide whether to reject or coerce those values.

---

## 14) [P1] Zed adapter uses `JSON.parse()` for JSONC settings file

**Review summary:** Zed settings files often contain comments and trailing commas, but the adapter reads them with `JSON.parse()`.

### Evidence in current code
- `src/adapters/platforms/zed.ts:29-33`
  ```ts
  readConfig() {
    const p = this.configPath();
    if (!p || !existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  ```

### Root cause
`JSON.parse()` cannot parse JSONC. Real-world Zed settings commonly include comments, so the adapter will throw at runtime.

### Exact implementation steps
1. Parse Zed settings with a JSONC-capable parser instead of raw `JSON.parse()`.
2. Reuse the shared JSON5 helper if acceptable for Zed settings, or add a JSONC helper if the file format requires strict comment support.
3. Keep the write path in mind: if comments need to be preserved, a write strategy broader than `JSON.stringify()` may be needed.

### Expected code shape
```ts
import { readJson5 } from "../helpers/json5.js";
...
return readJson5(p);
```

### Tests / checks
- Add a Zed adapter test with comments and trailing commas in `settings.json`.
- Verify discovery still works after parsing.

### Risks / edge cases
- If Zed expects a format stricter than JSON5 on write, the write path may need separate treatment.

---

## 15) [P2] `compressTextFile` subprocess path is fragile and should be simplified or explicitly kept

**Review summary:** `src/core/compression.ts` still spawns a Node subprocess, while the compressor is also exposed through `src/core/toon_bridge.ts` and wrapped by `src/core/toon_bridge_cli.js`. The earlier review claim that this is dead code is stale; there is a real CLI entrypoint.

### Evidence in current code
- `src/core/compression.ts:54-78`
  ```ts
  export async function runToonBridge(validPath: string, budget: number): Promise<string | null> {
      return new Promise((resolve) => {
          const child = spawn(process.execPath, [_BRIDGE, validPath, String(budget)], {
              stdio: ['ignore', 'pipe', 'pipe'],
          });
  ```
- `src/core/toon_bridge.ts:1-50`
  ```ts
  export async function compressToon(...): Promise<string> { ... }
  ```
- `src/core/toon_bridge_cli.js:1-19`
  ```js
  import { compressToon } from './toon_bridge.js';
  ...
  const compressed = await compressToon(content, budget, validPath);
  process.stdout.write(compressed);
  ```

### Root cause
The subprocess path is still indirect and harder to maintain than a direct in-process call, but it is not currently dead because the CLI wrapper exists and is part of the tree.

### Exact implementation steps
1. Decide whether to keep the subprocess wrapper or replace it with an in-process call.
2. If keeping the subprocess path, ensure `src/core/toon_bridge_cli.js` is included in the build/package and remains aligned with `runToonBridge`.
3. If simplifying, call `compressToon` directly from `compression.ts` and delete the subprocess path after the new flow is proven.
4. Verify the production packaging still ships the entrypoint that `compression.ts` expects.

### Expected code shape
If the direct path is chosen:
```ts
import { compressToon } from './toon_bridge.js';
...
const compressed = await compressToon(rawText, targetBudget, validPath);
```

### Tests / checks
- Add or update compression tests to exercise the actual bridge path used in production.
- Run `tests/compression-core.test.js` and `tests/tool-compression.test.js`.

### Risks / edge cases
- Changing from subprocess to in-process may alter performance or isolation characteristics.
- Verify large-file behavior and error handling remain acceptable.

---

## 16) [P2] `_retryState` Map in refactor_batch grows unboundedly

**Review summary:** `src/tools/refactor_batch.ts` keeps retry counters in a module-level `Map` with no eviction.

### Evidence in current code
- `src/tools/refactor_batch.ts:126-145`
  ```ts
  const CACHE_MAX_ENTRIES = 64;
  ...
  const _loadCache = new Map<string, LoadCache>();
  // Reserved for Task 2.1 (apply/reapply) — declared now so Wave 2 only extends.
  const _payloadCache = new Map<string, PayloadCache>();
  // Keyed by `${repoRoot}::${sessionId}::${symbolName}`. Locks a group after 1 failed retry.
  const _retryState = new Map<string, number>();
  ```

### Root cause
The retry map is module-global and never evicted, so every unique repo/session/symbol combination persists for the life of the process.

### Exact implementation steps
1. Add eviction to `_retryState` consistent with the other module caches.
2. Reuse the existing `evictOldest()` helper or add cleanup when entries are reset/completed.
3. Remove keys when retry state is no longer needed, especially after successful completion or when a symbol group is abandoned.

### Expected code shape
A simple eviction policy after insertions is sufficient, or explicit delete-on-success logic if the retry state is only needed transiently.

### Tests / checks
- Add a test that inserts many retry-state keys and asserts the map is trimmed.
- Run `tests/refactor-batch.test.js`.

### Risks / edge cases
- Ensure eviction does not break in-progress retries for active sessions.
- If the map is used for locking semantics, confirm cleanup only occurs when safe.

---

## 17) [P3] `patchToolsInConfig` may consume trailing newline when `### Tools` is last section

**Review summary:** `src/config/loader.ts` replaces from the `### Tools` header to EOF when tools are the last section, which can drop the file’s trailing newline/formatting.

### Evidence in current code
- `src/config/loader.ts:178-251`
  ```ts
  const lines = fileContent.split("\n");
  let toolsStart = -1;
  let toolsEnd = lines.length;
  ...
  lines.splice(toolsStart, toolsEnd - toolsStart, ...newBlock);
  ```

### Root cause
When the tools block is at EOF, the splice can rewrite the trailing empty segment created by `split("\n")`, altering the final newline behavior.

### Exact implementation steps
1. Preserve whether the original file ended with a newline before splitting.
2. When rebuilding the file, ensure the final newline is restored if it was present originally.
3. If only the tools block changes, avoid rewriting the trailing newline semantics of the entire file.

### Expected code shape
Track `const hadTrailingNewline = fileContent.endsWith("\n")` and restore it after join.

### Tests / checks
- Add a loader test with `### Tools` as the last section and a final newline, then verify newline preservation.

### Risks / edge cases
- Be careful not to introduce duplicate blank lines while preserving EOF newline state.

---

## 18) [P3] Raycast adapter lists Linux as supported platform — Raycast is macOS-only

**Review summary:** `src/adapters/platforms/raycast.ts` claims Linux support, but the app is macOS-only.

### Evidence in current code
- `src/adapters/platforms/raycast.ts:6-14`
  ```ts
  class RaycastAdapter extends MCPConfigAdapter {
    toolName = "raycast";
    displayName = "Raycast";
    configFormat = "json" as const;
    supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos", "linux"];
  ```

### Root cause
The supportedPlatforms declaration does not match the actual product availability.

### Exact implementation steps
1. Remove Linux from `supportedPlatforms` unless the adapter is intentionally targeting a Linux-compatible configuration derivative.
2. Confirm whether Windows should also be excluded.
3. Keep the config path logic unchanged unless another review item requires it.

### Expected code shape
```ts
supportedPlatforms: ("macos" | "linux" | "windows")[] = ["macos"];
```

### Tests / checks
- Add a small adapter-support test to assert Linux is skipped.
- Run adapter registry tests.

### Risks / edge cases
- If the adapter is repurposed later, this may need revisiting.

---

## 19) [P3] `formatSize` doesn't guard against negative byte values

**Review summary:** `src/core/lib.ts` assumes byte counts are non-negative. Negative values can produce `NaN` from `Math.log()`.

### Evidence in current code
- `src/core/lib.ts:74-83`
  ```ts
  export function formatSize(bytes: number): string {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      if (bytes === 0)
          return '0 B';
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      if (i < 0 || i === 0)
          return `${bytes} ${units[0]}`;
      const unitIndex = Math.min(i, units.length - 1);
      return `${(bytes / Math.pow(1024, unitIndex)).toFixed(2)} ${units[unitIndex]}`;
  }
  ```

### Root cause
The function does not guard against negative values before calling `Math.log()`.

### Exact implementation steps
1. Add an early return for negative values, likely using the byte count directly in `B`.
2. Keep existing behavior for zero and positive values.
3. Consider whether non-finite values should also be handled explicitly.

### Expected code shape
```ts
if (bytes <= 0) return `${bytes} B`;
```

### Tests / checks
- Add a test in `tests/lib-utilities.test.js` for a negative input like `-1`.

### Risks / edge cases
- Decide whether negative values should be shown verbatim or clamped to `0 B`.

---

## 20) [P3] Tokenizer regex inconsistency between `bmx-index.ts` and `bmx-plus.ts`

**Review summary:** Retrieval and toon tokenizers use different regexes, which can lead to inconsistent scoring if compared or reused interchangeably.

### Evidence in current code
- `src/retrieval/ranking/bmx-index.ts:50-55`
  ```ts
  private _tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const matches = lower.match(/[a-z0-9_]+/g) ?? [];
    return matches.filter((t) => t.length > 1 || t === "a" || t === "i");
  }
  ```
- `src/toon/bmx-plus.ts:30-33, 120-126`
  ```ts
  const _WORD_RE = /[\p{L}\p{N}_]+/gu;
  ...
  const matches = lower.match(_WORD_RE);
  ```

### Root cause
The two ranking systems tokenize text differently, so identical inputs can produce different token bags and scoring behavior.

### Exact implementation steps
1. Choose one tokenization strategy and standardize both modules on it.
2. Add a shared tokenizer helper instead of copy-pasted regexes.
3. Verify downstream scoring does not assume one token set or the other.

### Expected code shape
A shared tokenizer helper exported from a common utility module is safer than copy-pasted regexes.

### Tests / checks
- Add regression tests that compare tokenization output across both modules for the same sample strings.
- Run the retrieval/toon ranking tests.

### Risks / edge cases
- Changing tokenization can affect ranking results and snapshots.
- Review underscore handling and Unicode word-boundary behavior.

---

## 21) [P3] Median calculation uses floor-based upper median instead of true median

**Review summary:** `src/toon/pipeline.ts` uses `sorted_ss[Math.floor(n / 2)]` instead of averaging the two middle values for even-length arrays.

### Evidence in current code
- `src/toon/pipeline.ts:433-438`
  ```ts
  const sorted_ss = [...self_scores].sort((a, b) => a - b);
  const median_ss = sorted_ss[Math.floor(n / 2)];
  const abs_devs = self_scores
    .map((s) => Math.abs(s - median_ss))
    .sort((a, b) => a - b);
  const mad = abs_devs[Math.floor(n / 2)] * 1.4826; // MAD to std conversion factor
  ```

### Root cause
For even sample sizes, the code takes the upper middle element instead of the true median. That shifts MAD/hubness thresholds.

### Exact implementation steps
1. Compute the true median for even-length arrays by averaging the two middle values.
2. Apply the same approach to MAD if the downstream logic expects an actual median.
3. Keep the existing `1.4826` conversion factor unless the statistical model changes.

### Expected code shape
```ts
const mid = Math.floor(n / 2);
const median_ss = n % 2 === 0 ? (sorted_ss[mid - 1] + sorted_ss[mid]) / 2 : sorted_ss[mid];
```

### Tests / checks
- Add toon pipeline tests for even-length arrays with known medians.
- Run the toon pipeline test suite.

### Risks / edge cases
- Median changes can alter hub detection thresholds and output ordering.
- Validate whether a different median convention is intentional for the upstream algorithm.

---

## 22) [P2] Session creation race condition in streamable HTTP transport

**Review summary:** In `src/server/http.ts`, the session is added to `sessions` only after `transport.handleRequest()` returns. A follow-up request using the session ID can arrive before the map is populated.

### Evidence in current code
- `src/server/http.ts:196-217`
  ```ts
  const { ctx, server } = createSessionPair();
  const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
  });
  ...
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  const sid = transport.sessionId;
  if (sid) {
      sessions.set(sid, { type: 'streamable', transport, server, ctx, lastSeenAt: Date.now() });
  }
  ```

### Root cause
The server waits until after the initialize request has finished before publishing the session in the shared map.

### Exact implementation steps
1. Store a provisional session entry before or immediately when the transport session ID becomes available.
2. If the transport can expose the session ID earlier, register it before `handleRequest()` completes.
3. Ensure cleanup still happens correctly if initialization fails.
4. If a provisional session cannot be stored safely, narrow the race window with a transport-specific workaround.

### Expected code shape
This is a flow change: the session should be discoverable before client follow-up requests can be processed.

### Tests / checks
- Add a streamable HTTP integration test that sends initialize and immediate follow-up traffic and confirms the session exists.
- Run HTTP server tests.

### Risks / edge cases
- Be careful not to register sessions that never complete initialization.
- Ensure the cleanup path removes provisional entries on failure.

---

## 23) [P2] `readFileSync` in `freqPrior` blocks event loop on every `getToolsForList` call

**Review summary:** `src/retrieval/pipeline.ts` reads the retrieval log synchronously in `freqPrior`, which can block the event loop as the log grows.

### Evidence in current code
- `src/retrieval/pipeline.ts:234-266`
  ```ts
  if (!p || !existsSync(p)) return [];
  ...
  for (const line of readFileSync(p, "utf-8").split("\n")) {
  ```

### Root cause
A synchronous file read occurs on the hot path of tool-list ranking.

### Exact implementation steps
1. Replace the synchronous read with an async read or a cached incremental strategy.
2. If the method must remain synchronous for call-site simplicity, cache parsed results and refresh on a timer or background task.
3. Preserve current filtering semantics (`alert`, `shadow`, timestamp cutoff).

### Expected code shape
Prefer an async preloaded cache, or a bounded in-memory summary updated by the logger.

### Tests / checks
- Add a regression test or performance-oriented check that verifies large logs do not force synchronous reads on the main path.
- Run retrieval pipeline tests.

### Risks / edge cases
- Switching to async ranking may alter timing and ordering.
- The cache must remain coherent when logs rotate or are truncated.

---

## 24) [P2] FileRetrievalLogger race condition — log calls can precede directory creation

**Review summary:** `src/retrieval/observability/logger.ts` starts `mkdir()` in the constructor without awaiting it, so the first `appendFile()` can race with directory creation.

### Evidence in current code
- `src/retrieval/observability/logger.ts:41-45`
  ```ts
  constructor(logPath: string) {
    this._path = logPath;
    // Ensure parent directory exists
    mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }
  ```

### Root cause
The directory creation is fire-and-forget; the logger can be used before the promise resolves.

### Exact implementation steps
1. Move directory creation into an awaited initialization path or lazily ensure the directory exists before every append.
2. Optionally store a promise in the constructor and await it at the start of each `log()`/`logAlert()` call.
3. Avoid swallowing the mkdir failure unless you have a fallback that makes writes reliable.

### Expected code shape
```ts
private readonly _dirReady: Promise<void>;
...
this._dirReady = mkdir(dirname(logPath), { recursive: true });
...
await this._dirReady;
await appendFile(...);
```

### Tests / checks
- Add a logger test that writes immediately after construction in a fresh directory.
- Run observability logger tests.

### Risks / edge cases
- Awaiting setup may add slight latency to the first log call, but it is preferable to losing entries.

---

## 25) [P2] Missing `process.exit` after usage error in CLI entry point

**Review summary:** `src/cli/stdio.ts` prints a usage error when no directories are provided but continues into normal startup.

### Evidence in current code
- `src/cli/stdio.ts:15-28`
  ```ts
  if (dirArgs.length === 0) {
    console.error("Usage: zenith-mcp [allowed-directory] [additional-directories...]");
    console.error("Note: Allowed directories can be provided via:");
    console.error("  1. Command-line arguments (shown above)");
    console.error("  2. MCP roots protocol (if client supports it)");
    console.error("At least one directory must be provided by EITHER method for the server to operate.");
  }
  ```

### Root cause
The CLI reports the usage error but does not terminate, so it keeps starting the server even though the input is invalid.

### Exact implementation steps
1. After printing the usage message, call `process.exit(1)` or throw a fatal error.
2. Verify the desired behavior matches the product intent; the review indicates it should stop.
3. Leave the later startup logic unchanged.

### Expected code shape
```ts
if (dirArgs.length === 0) {
  ...
  process.exit(1);
}
```

### Tests / checks
- Add a CLI test or update an existing one to assert the process exits non-zero when no directories are given.
- Run the CLI test suite if present.

### Risks / edge cases
- If the server is intentionally supposed to rely only on MCP roots, this is a behavior change; the review indicates the current implementation is incorrect.

---

## 26) [P2] Opencode adapter's `writeConfig` always writes plain JSON, destroying JSONC comments

**Review summary:** `src/adapters/platforms/opencode.ts` may read JSONC but always writes plain JSON, so comments are lost when config is saved.

### Evidence in current code
- `src/adapters/platforms/opencode.ts:46-50`
  ```ts
  writeConfig(data: Record<string, any>) {
    const p = this.configPath()!;
    this.backup(p);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
  ```
- The read path currently treats files as possibly JSONC at `src/adapters/platforms/opencode.ts:40-43`.

### Root cause
The adapter parses in a comment-aware way but serializes using plain JSON, permanently stripping comments and formatting.

### Exact implementation steps
1. Decide whether OpenCode configs should preserve JSONC comments or convert the file format to plain JSON.
2. If comments must be preserved, implement a comment-preserving write path or a JSONC serializer.
3. If plain JSON is acceptable, update the read path and docs so behavior is consistent and no false promise is implied.
4. Align the file extension/path selection with the chosen format.

### Expected code shape
If preserving comments is required, the write path must stop using `JSON.stringify(...)` directly.

### Tests / checks
- Add a round-trip test for a commented JSONC file.
- Verify comment preservation or intentional conversion behavior is documented.

### Risks / edge cases
- Comment-preserving writes are more complex than parsing.
- A non-preserving conversion is simpler but should be explicit.

---

## 27) [P2] SQLite connection is never closed — WAL journal may not checkpoint on exit

**Review summary:** `src/config/backup.ts` creates a lazy SQLite connection that is never closed.

### Evidence in current code
- `src/config/backup.ts:32-43`
  ```ts
  let _db: Database | null = null;
  let _tableReady = false;

  function getDb(): Database {
      if (_db) return _db;
      mkdirSync(ZENITH_HOME, { recursive: true });
      _db = new Database(GLOBAL_DB_PATH);
      _db.pragma('journal_mode = WAL');
      _db.pragma('synchronous = NORMAL');
      _db.pragma('busy_timeout = 5000');
      return _db;
  }
  ```

### Root cause
The module owns a long-lived DB handle but never exposes a shutdown path or closes the connection on process exit.

### Exact implementation steps
1. Add a `closeBackupDb()` or `shutdown()` helper that closes `_db` when the process exits cleanly.
2. Register it from the CLI/server startup path or expose it to the main shutdown sequence.
3. Make it safe to call multiple times.

### Expected code shape
```ts
export function closeBackupDb(): void {
  _db?.close();
  _db = null;
  _tableReady = false;
}
```

### Tests / checks
- Add a unit test that the close helper is idempotent.
- Run config backup tests if present.

### Risks / edge cases
- Ensure close is not called while a backup operation is in flight.
- A best-effort close on shutdown is sufficient; abrupt kills will still bypass cleanup.

---

## 28) [P2] `sessionIdFromExtra` falls back to `"default"` — multi-client state bleeding

**Review summary:** In `src/retrieval/zenith-integration.ts`, requests without a session ID are all mapped to the same default session, so unrelated clients can share routing state.

### Evidence in current code
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

### Root cause
When neither `sessionId` nor `requestId` is present, every caller shares the same fallback state, which makes tool histories and promotions bleed across clients.

### Exact implementation steps
1. Replace the shared fallback with a per-connection or per-request identity.
2. If the SDK guarantees a stable request ID, use that; otherwise require the caller to provide one.
3. Avoid the global `"default"` bucket for long-lived state.
4. Verify any session-scoped state now remains isolated across concurrent clients.

### Expected code shape
A stable per-client session key is needed here; the current shared default must go away.

### Tests / checks
- Add a retrieval integration test that simulates two requests without explicit session IDs and verifies they do not share routing state.

### Risks / edge cases
- Changing the fallback key can alter tool-history continuity for clients that currently depend on `default`.
- Make sure any new key is still stable enough for a single client lifecycle.
