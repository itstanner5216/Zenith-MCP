# Full Codebase Review — Zenith-MCP

**Reviewer:** AI Assistant  
**Date:** 2025-07-17  
**Scope:** Full codebase review of all `src/` modules (~90 files across adapters, cli, config, core, retrieval, server, toon, tools, utils)

---

## Findings

### [P0] Stateful regex with `g` flag silently drops ~50% of content search matches

| Field | Value |
|:---|:---|
| **File** | `src/tools/search_files.ts` |
| **Lines** | 571–654 |
| **Priority** | 0 |
| **Confidence** | 0.95 |

In the JS fallback content search path, `contentRegex` is created with the `'gi'` flags (line 574). A `RegExp` with the global flag is stateful — `.test()` advances `lastIndex` on each successful match, causing alternating `true`/`false` results for identical input on subsequent calls. Since this regex is reused across lines in `grepFile` (line 652), roughly half of all matching lines are silently skipped. The `g` flag should be removed, or `lastIndex` reset to 0 before each `.test()` call.

---

### [P1] Path traversal bypass on Windows — hardcoded `/` separator in containment check

| Field | Value |
|:---|:---|
| **File** | `src/core/path-validation.ts` |
| **Lines** | 10–13 |
| **Priority** | 1 |
| **Confidence** | 0.85 |

`isPathWithinAllowedDirectories` uses `normalizedDir + '/'` for the `startsWith` check. On Windows, `path.resolve` produces backslash-separated paths, so this prefix check never matches, effectively bypassing the path containment security check entirely. Should use `path.sep` instead of `'/'`.

---

### [P1] `stripJsoncComments` regex corrupts URLs and string values containing `//`

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/opencode.ts` |
| **Lines** | 28–31 |
| **Priority** | 1 |
| **Confidence** | 0.80 |

The regex-based JSONC comment stripper (`\/\/.*?$`) strips content inside JSON string values that contain `//`. For example, `"url": "http://example.com"` becomes `"url": "http:`. This silently corrupts config data for any string value containing URL-like content. A proper JSONC parser should be used instead. The detection heuristic `content.includes("//")` at line 40 makes this worse — any JSON file with URLs triggers the broken stripping even if it's plain JSON.

---

### [P1] `win32.basename()` used unconditionally — produces wrong backup filenames on macOS/Linux

| Field | Value |
|:---|:---|
| **File** | `src/adapters/base.ts` |
| **Lines** | 22 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

`path.win32.basename` is used unconditionally on all platforms. On Unix systems, it won't find backslash separators, so for a path like `/home/user/.config/foo.json`, it returns the full path string as the "filename." This means backup files get created with the entire absolute path as their name. Should use the platform-native `basename` from `path`.

---

### [P1] `getProjectContext` singleton silently ignores different `ctx` arguments after first call

| Field | Value |
|:---|:---|
| **File** | `src/core/project-context.ts` |
| **Lines** | 258–265 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

`getProjectContext` creates a `ProjectContext` with the first `ctx` provided and returns that same instance for all subsequent calls, regardless of the argument. If different callers pass different `FsContext` objects (e.g., with different allowed directories), only the first one will be used. The function signature suggests it respects the argument, but the implementation silently ignores it.

---

### [P1] `file://` URI parsing doesn't handle percent-encoding or three-slash form correctly

| Field | Value |
|:---|:---|
| **File** | `src/core/roots-utils.ts` |
| **Lines** | 8 |
| **Priority** | 1 |
| **Confidence** | 0.80 |

`parseRootUri` strips `file://` by naive `slice(7)`, which breaks for URIs with authorities (`file://host/share`) and percent-encoded characters (`file:///path%20with%20spaces`). Since MCP clients send standard `file://` URIs, paths with spaces or special characters will silently fail validation and be dropped. Should use `new URL(uri).pathname` with `decodeURIComponent`.

---

### [P1] Broken `_fnmatch` glob matcher in security-sensitive denylist

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/telemetry/scanner.ts` |
| **Lines** | 84–93 |
| **Priority** | 1 |
| **Confidence** | 0.95 |

The `_fnmatch` function checks if pattern parts (split by `*`) appear sequentially in the name, but doesn't anchor the match. Pattern `.env` matches any filename containing `.env` anywhere — `my.environment.txt` and `some.envoy.config` would be incorrectly denied. Pattern `id_rsa` would match any path containing that substring. The denylist is both overly broad (false positives) and doesn't actually protect against the targeted filenames.

---

### [P1] Fire-and-forget dynamic import causes race condition — Tier 1 fusion unreliable on cold starts

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/pipeline.ts` |
| **Lines** | 40–43 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

The fusion module is loaded via a top-level `import().then()` with no synchronization. `_weightedRrf` and `_computeAlpha` start as `null` and are populated asynchronously. If `getToolsForList` is called before the import resolves, Tier 1 fusion is silently skipped. The module is in the same package — a static import should be used.

---

### [P1] Fragile coupling to MCP SDK private internals

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/zenith-integration.ts` |
| **Lines** | 205–208 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

`installRetrievalRequestHandlers` accesses `server.server._requestHandlers` — a private internal property of the MCP SDK. If the SDK changes this property on any version update, both `defaultList` and `defaultCall` would be `undefined`, causing the `throw` at line 212 on every startup. The `as unknown as` cast chain makes this invisible to TypeScript.

---

### [P1] User-supplied regex enables ReDoS — can hang the event loop

| Field | Value |
|:---|:---|
| **File** | `src/tools/search_files.ts` |
| **Lines** | 573–574 |
| **Priority** | 1 |
| **Confidence** | 0.90 |

When `literalSearch` is false, `args.contentQuery` is passed directly to `new RegExp()` with no validation. A maliciously crafted regex pattern (e.g., `(a+)+$`) can cause catastrophic backtracking, hanging the server's event loop indefinitely. The regex should be validated, a timeout imposed, or the search limited to ripgrep (which is immune to ReDoS).

---

### [P1] `search_files` definition mode crashes if `definesSymbol` omitted

| Field | Value |
|:---|:---|
| **File** | `src/tools/search_files.ts` |
| **Lines** | 400 |
| **Priority** | 1 |
| **Confidence** | 0.85 |

`args.definesSymbol` is asserted with `!` but there's no validation that it was actually provided. If a user calls `search_files` with `mode: "definition"` but omits `definesSymbol`, `symbolName` will be `undefined`, and the subsequent filter comparison will return zero results with no error message explaining why.

---

### [P1] `x-forwarded-prefix` header injection risk

| Field | Value |
|:---|:---|
| **File** | `src/server/http.ts` |
| **Lines** | 265–271 |
| **Priority** | 1 |
| **Confidence** | 0.75 |

The `X-Forwarded-Prefix` header value is used directly to construct the SSE message endpoint URL sent back to clients. A malicious reverse proxy or attacker who can set this header could inject arbitrary path prefixes (e.g., `/../admin`), potentially redirecting clients to post messages to unintended endpoints. The header should be validated/sanitized beyond simple trim and trailing-slash removal.

---

### [P1] Empty YAML config files cause runtime TypeError in adapters

| Field | Value |
|:---|:---|
| **File** | `src/adapters/helpers/yaml.ts` |
| **Lines** | 8 |
| **Priority** | 1 |
| **Confidence** | 0.85 |

`YAML.load()` returns `undefined` for empty YAML files. The result is cast `as Record<string, unknown>` but callers treat it as a guaranteed object (e.g., `data.mcpServers`). Any subsequent property access throws a runtime TypeError. Should default to `?? {}`.

---

### [P1] Zed adapter uses `JSON.parse()` for JSONC settings file

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/zed.ts` |
| **Lines** | 29–32 |
| **Priority** | 1 |
| **Confidence** | 0.70 |

Zed's `settings.json` uses JSONC format (comments and trailing commas are common). This adapter reads it with `JSON.parse()`, which will throw a `SyntaxError` at runtime for most real Zed installations that have comments in their settings file, making the adapter completely non-functional.

---

### [P2] `compressTextFile` subprocess path is likely broken — dead code path

| Field | Value |
|:---|:---|
| **File** | `src/core/compression.ts` |
| **Lines** | 54–78 |
| **Priority** | 2 |
| **Confidence** | 0.75 |

`runToonBridge` spawns a child process to run `toon_bridge.js`, but `toon_bridge.ts` is now an in-process module. If the compiled `.js` bridge doesn't have a CLI entrypoint (it exports an async function, not a script), the subprocess exits immediately with no output, causing `compressTextFile` to always return `null`.

---

### [P2] `offsetReadFile` returns inaccurate `totalLines` when stream is destroyed early

| Field | Value |
|:---|:---|
| **File** | `src/core/lib.ts` |
| **Lines** | 303–330 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

When `collected.length >= length`, the stream is destroyed early. `totalLines` only reflects lines read up to termination, not the file's actual line count. Consumers relying on `totalLines` for pagination or progress get incorrect values.

---

### [P2] `tailFile` can corrupt multi-byte UTF-8 characters at chunk boundaries

| Field | Value |
|:---|:---|
| **File** | `src/core/lib.ts` |
| **Lines** | 237–270 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

`tailFile` reads fixed 1024-byte chunks from the end of a file and converts each to UTF-8. If a multi-byte character (emoji, CJK) spans a chunk boundary, it will be decoded incorrectly, producing replacement characters (`\uFFFD`) or garbled text.

---

### [P2] `applyFileEdits` only replaces first occurrence of `oldText`

| Field | Value |
|:---|:---|
| **File** | `src/core/lib.ts` |
| **Lines** | 171–172 |
| **Priority** | 2 |
| **Confidence** | 0.90 |

`String.replace` with a string argument only replaces the first occurrence. If `oldText` appears multiple times and the user expects all to be replaced, only the first will change. This behavior is undocumented.

---

### [P2] `better-sqlite3` `prepare<T>()` generic parameterizes bind params, not result type

| Field | Value |
|:---|:---|
| **File** | `src/core/stash.ts` |
| **Lines** | 39, 53, 71 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

Multiple files use `db.prepare<RowType>(sql).get(...)` assuming the generic types the return value. In `better-sqlite3`, the generic parameterizes bind parameters, not the result. The code compiles but provides false type safety — the return is `unknown` at the type level. Same issue in `backup.ts` line 131 and `project-context.ts` lines 184, 195.

---

### [P2] Shared mutable `zenithServerEntry` reference inserted into all platform configs

| Field | Value |
|:---|:---|
| **File** | `src/config/auto-write.ts` |
| **Lines** | 18–21 |
| **Priority** | 2 |
| **Confidence** | 0.70 |

The same object reference is used when writing to all platform configs. If any platform adapter mutates the entry after insertion (e.g., adding platform-specific fields), the mutation leaks across all configs.

---

### [P2] `directory.ts` tree mode ignores user-specified `depth` parameter

| Field | Value |
|:---|:---|
| **File** | `src/tools/directory.ts` |
| **Lines** | 108–187 |
| **Priority** | 2 |
| **Confidence** | 0.90 |

In "tree" mode, the `buildTree` function recurses without checking the `depth` parameter — it only stops at `TREE_MAX_ENTRIES`. The `depth` argument is only used in "list" mode. Requesting `depth: 1` in tree mode will still recurse deeply, contrary to user expectations and the schema description.

---

### [P2] Module-level `loadConfig()` call at import time can crash server startup

| Field | Value |
|:---|:---|
| **File** | `src/tools/search_files.ts` |
| **Lines** | 13–14 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

`loadConfig()` is called at module import time. If the config file doesn't exist or has parse errors, this throws during module initialization and crashes the entire server before any tool registration occurs. Same pattern in `refactor_batch.ts` (lines 16–19).

---

### [P2] `refactor_batch.ts` fire-and-forget freshness check causes stale query results

| Field | Value |
|:---|:---|
| **File** | `src/tools/refactor_batch.ts` |
| **Lines** | 297–304 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

In query mode, when the index already has entries, the freshness refresh is a fire-and-forget `async ()` IIFE with no `await`. The query runs against a potentially stale index. A recently edited file's symbols may be at wrong line numbers, causing silent failures.

---

### [P2] JetBrains adapter re-throws parse errors, crashing entire discovery

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/jetbrains.ts` |
| **Lines** | 88–90 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

`discoverServers()` re-throws JSON parse errors. A single malformed `.junie/mcp/mcp.json` anywhere in the directory ancestry crashes the entire discovery process, preventing discovery of servers from all other valid config files. The error should be logged and skipped.

---

### [P2] Codex CLI and Codex Desktop adapters share identical config path

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/codex-cli.ts` |
| **Lines** | 13–14 |
| **Priority** | 2 |
| **Confidence** | 0.90 |

Both `CodexCLIAdapter` and `CodexDesktopAdapter` return `~/.codex/config.toml` as their config path. Registering a server on one silently affects the other. One likely needs a different path.

---

### [P2] `_isStackTrace` misclassifies normal text containing "Error" or "Exception"

| Field | Value |
|:---|:---|
| **File** | `src/toon/string-codec.ts` |
| **Lines** | 77–93 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

`_isStackTrace` returns `true` for any text containing "Error", "Exception", or "Traceback" in the first 2000 characters, even if it's documentation or JSON. Misclassified text gets processed through `_compressStackTrace`, which reorders lines and drops content in ways designed for actual stack traces, potentially corrupting normal content.

---

### [P2] `_fastSigmoid` Padé approximation returns values > 1.0 for moderate negative inputs

| Field | Value |
|:---|:---|
| **File** | `src/toon/bmx-plus.ts` |
| **Lines** | 42 |
| **Priority** | 2 |
| **Confidence** | 0.75 |

The approximation `(x³ + 6x + 12) / (x³ + 12x + 48)` returns values > 1.0 for inputs near -4 (before the -8.0 clamp kicks in). For example at x = -4: result ≈ 1.19, while actual sigmoid(-4) ≈ 0.018. This produces incorrect entropy calculations affecting scoring quality in both `bmx-plus.ts` and `sagerank.ts`.

---

### [P2] RelevanceRanker score grouping creates arbitrarily wide groups

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/ranking/ranker.ts` |
| **Lines** | 37–40 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

Score groups compare against the *first* element's score, not the previous element's. For a slowly-decaying sequence like [1.0, 0.96, 0.92, 0.88], the first three are all within tolerance of 1.0, creating a single wide group. This "anchor-based" grouping may not match the intended "similar scores" semantics; a sliding-window comparison would produce tighter groups.

---

### [P2] Synchronous `existsSync` calls in marker detection loop block event loop

| Field | Value |
|:---|:---|
| **File** | `src/utils/project-scope.ts` |
| **Lines** | 223 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

`_resolveFromMarkers` calls `fs.existsSync()` for every marker (15) at every directory level walking up to root. This performs dozens of synchronous filesystem calls, blocking the Node.js event loop. In the HTTP server context, this blocks all concurrent request processing during project resolution.

---

### [P2] Unbounded `_cache` Map in project-scope grows without limit

| Field | Value |
|:---|:---|
| **File** | `src/utils/project-scope.ts` |
| **Lines** | 50 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

`_cache` is a module-level `Map<string, string | null>` that grows without bound as files are resolved. In a long-running server, this leaks memory indefinitely. An LRU cache with a size limit would be more appropriate.

---

### [P2] `patchToolsInConfig` catch block is too broad — may overwrite config on permission errors

| Field | Value |
|:---|:---|
| **File** | `src/config/loader.ts` |
| **Lines** | 157–163 |
| **Priority** | 2 |
| **Confidence** | 0.50 |

The `catch` block catches any `readFileSync` error (not just `ENOENT`) and falls back to a full `saveConfig`. If the config file exists but is temporarily unreadable (permission error), this could silently overwrite it with defaults on the next call. Consider narrowing to `ENOENT` only.

---

### [P2] `read_file.ts` puts `[truncated]` at top instead of bottom

| Field | Value |
|:---|:---|
| **File** | `src/tools/read_file.ts` |
| **Lines** | 112 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

When `budgetExhausted` is true, the truncation notice is prepended: `'[truncated]\n' + outputLines.join('\n')`. This puts the marker at the top, implying the beginning was truncated when actually the end was cut off. Inconsistent with other tools (e.g., `directory.ts` appends it).

---

### [P2] Session creation race condition in streamable HTTP transport

| Field | Value |
|:---|:---|
| **File** | `src/server/http.ts` |
| **Lines** | 196–218 |
| **Priority** | 2 |
| **Confidence** | 0.70 |

Between `transport.handleRequest()` (which sends the response with a session ID) and storing the session in the `sessions` map (line 216), the client could send a follow-up request with the session ID that won't be found yet. In high-throughput scenarios, this race produces "Unknown or mismatched session" errors.

---

### [P2] `readFileSync` in `freqPrior` blocks event loop on every `getToolsForList` call

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/pipeline.ts` |
| **Lines** | 244–246 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

The frequency prior reads a log file synchronously with `readFileSync` on every `getToolsForList` call when Tier 5 is reached. For large log files this blocks the event loop, causing latency spikes that grow worse over time as the log grows.

---

### [P2] FileRetrievalLogger race condition — log calls can precede directory creation

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/observability/logger.ts` |
| **Lines** | 44 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

The constructor creates the parent directory asynchronously with `.catch(() => {})`. If the first `log()` call happens before `mkdir` completes, `appendFile` will fail because the directory doesn't exist yet. The first few ranking events on fresh deployments can be silently lost.

---

### [P2] Missing `process.exit` after usage error in CLI entry point

| Field | Value |
|:---|:---|
| **File** | `src/cli/stdio.ts` |
| **Lines** | 19–25 |
| **Priority** | 2 |
| **Confidence** | 0.85 |

When no directory arguments are provided, the code prints a usage message to stderr but does not exit. Execution continues into the normal startup path with an empty directory list.

---

### [P2] Opencode adapter's `writeConfig` always writes plain JSON, destroying JSONC comments

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/opencode.ts` |
| **Lines** | 46–50 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

`writeConfig` always writes plain JSON, but `readConfig` may have read from a JSONC file. Any comments in the original file are permanently destroyed on write, causing data loss for users with carefully commented configs.

---

### [P2] SQLite connection is never closed — WAL journal may not checkpoint on exit

| Field | Value |
|:---|:---|
| **File** | `src/config/backup.ts` |
| **Lines** | 32–43 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

The lazy SQLite connection is opened but never closed. WAL journal files may remain and not checkpoint properly on CLI exit paths, potentially leaving the database in an inconsistent state if the process exits abruptly.

---

### [P2] `sessionIdFromExtra` falls back to `"default"` — multi-client state bleeding

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/zenith-integration.ts` |
| **Lines** | 82–89 |
| **Priority** | 2 |
| **Confidence** | 0.80 |

All requests without a session ID share a single pipeline session state (`"default"`). Tool histories, turn counts, and demotion decisions bleed across unrelated clients, creating unpredictable tool filtering behavior.

---

### [P2] `_retryState` Map in refactor_batch grows unboundedly

| Field | Value |
|:---|:---|
| **File** | `src/tools/refactor_batch.ts` |
| **Lines** | 140–144 |
| **Priority** | 2 |
| **Confidence** | 0.70 |

The `_retryState` Map is never evicted. Over a long-running server process, it grows without bound as retry counts are keyed by `${repoRoot}::${sessionId}::${symbolName}` and never cleaned up.

---

### [P3] `patchToolsInConfig` may consume trailing newline when `### Tools` is last section

| Field | Value |
|:---|:---|
| **File** | `src/config/loader.ts` |
| **Lines** | 182–196 |
| **Priority** | 3 |
| **Confidence** | 0.70 |

When `### Tools` is the last section in the file, `toolsEnd` defaults to `lines.length`. The splice replaces everything from the header to EOF, potentially consuming a trailing newline that editors may expect.

---

### [P3] Raycast adapter lists Linux as supported platform — Raycast is macOS-only

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/raycast.ts` |
| **Lines** | 10 |
| **Priority** | 3 |
| **Confidence** | 0.60 |

`isSupported()` returns `true` on Linux, but Raycast is macOS-only. The adapter will attempt to read/write a config file that will never exist on Linux.

---

### [P3] `formatSize` doesn't guard against negative byte values

| Field | Value |
|:---|:---|
| **File** | `src/core/lib.ts` |
| **Lines** | 74–83 |
| **Priority** | 3 |
| **Confidence** | 0.70 |

`Math.log(negative)` returns `NaN`, making the unit index calculation fall through. While negative file sizes shouldn't normally occur, upstream code could pass delta values.

---

### [P3] Tokenizer regex inconsistency between `bmx-index.ts` and `bmx-plus.ts`

| Field | Value |
|:---|:---|
| **File** | `src/retrieval/ranking/bmx-index.ts` |
| **Lines** | 54 |
| **Priority** | 3 |
| **Confidence** | 0.70 |

The retrieval module's BMXIndex uses `/[a-z0-9_]+/g` while the toon module's BMXPlusIndex uses `/\b\w+\b/g`. Different tokenization between these indexes produces inconsistent scores if they're ever compared or used interchangeably.

---

### [P3] Median calculation uses floor-based upper median instead of true median

| Field | Value |
|:---|:---|
| **File** | `src/toon/pipeline.ts` |
| **Lines** | 433–438 |
| **Priority** | 3 |
| **Confidence** | 0.85 |

The hubness detection uses `sorted_ss[Math.floor(n / 2)]` which is the upper median for even-length arrays. The true median should average the two middle elements. This inaccuracy propagates into MAD calculations and hub detection z-scores.

---

### [P3] Warp adapter `configPath()` returns directory on macOS/Windows, file on Linux

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/warp.ts` |
| **Lines** | 12–31 |
| **Priority** | 3 |
| **Confidence** | 0.70 |

The semantic meaning of `configPath()` varies by platform — directory vs file. This inconsistency is fragile and can cause issues with backup operations that expect a file path.

---

### [P3] Silent swallowing of parse errors in Warp directory mode

| Field | Value |
|:---|:---|
| **File** | `src/adapters/platforms/warp.ts` |
| **Lines** | 53–55 |
| **Priority** | 3 |
| **Confidence** | 0.70 |

Individual file parse errors are silently swallowed with empty `catch {}` blocks. Users with malformed JSON in the Warp MCP directory get no indication why their server isn't being discovered.

---

## Overall Assessment

| Field | Value |
|:---|:---|
| **Verdict** | `patch is incorrect` |
| **Confidence** | 0.90 |

The codebase has several high-severity issues that affect correctness and security. The P0 stateful regex bug silently drops ~50% of content search results. Multiple P1 issues include path traversal bypass on Windows, JSONC corruption in adapters, a broken security denylist glob matcher, and ReDoS vulnerability from unvalidated user regex. Additionally, there are numerous P2 issues around race conditions, synchronous I/O blocking the event loop, memory leaks in unbounded caches, and cross-platform incompatibilities. The core application logic is well-structured, but these bugs span enough critical paths to warrant attention before a production release.
