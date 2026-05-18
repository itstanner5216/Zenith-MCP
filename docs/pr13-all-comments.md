# PR #13 — All Comments & Reviews

**Title:** Group B: 35 behavioral fixes — logic bugs, resource leaks, security gaps, architecture defects

**Total:** 3 top-level comments, 44 inline review comments, 3 review summaries

---

## Review Summaries

### Review 1 — gemini-code-assist[bot] (COMMENTED)

## Code Review

This pull request significantly refactors the Zenith MCP package, introducing JSONC support for configuration adapters, modularizing the tree-sitter implementation, and enhancing the retrieval pipeline with frequency-based priors and Unicode-aware tokenization. It also improves SQLite backup reliability and streamlines tool integration by removing reliance on private SDK fields. However, several critical issues were identified: generating random UUIDs for fallback session IDs breaks state continuity for some clients, and the refactored tool handlers fail to propagate the "extra" context parameter, which is essential for session and authentication logic. Furthermore, the method for reading ranking events from logs is inefficient and could lead to memory issues as log files grow.

---

### Review 2 — cubic-dev-ai[bot] (COMMENTED)

**17 issues found** across 36 files

<details>
<summary>Prompt for AI agents (unresolved issues)</summary>

```text

Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.


<file name="packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts">

<violation number="1" location="packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts:84">
P2: Short fingerprints (<3 nodes) are scored as 1.0 similarity, causing false positive structural matches.</violation>

<violation number="2" location="packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts:151">
P2: Parameter collection recurses into nested bodies, so outer symbol signatures can be populated with inner declaration parameters.</violation>

<violation number="3" location="packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts:204">
P2: Modifier collection walks the full subtree, which can leak nested modifiers into the outer symbol’s structure.</violation>
</file>

<file name="packages/zenith-mcp/src/retrieval/observability/logger.ts">

<violation number="1" location="packages/zenith-mcp/src/retrieval/observability/logger.ts:60">
P2: `_ready` can stay permanently rejected if `mkdir` fails, causing all later logger operations to throw before local error handling runs.</violation>
</file>

<file name="packages/zenith-mcp/src/server/http.ts">

<violation number="1" location="packages/zenith-mcp/src/server/http.ts:241">
P2: If initialize handling throws, the pre-registered session is left in the session map with no immediate cleanup. Wrap this call in error handling that removes/closes the session on failure.</violation>
</file>

<file name="packages/zenith-mcp/src/core/toon_bridge_cli.ts">

<violation number="1" location="packages/zenith-mcp/src/core/toon_bridge_cli.ts:7">
P2: Budget parsing is too permissive: malformed numeric input is silently truncated and accepted.</violation>
</file>

<file name="packages/zenith-mcp/src/core/tree-sitter/compression-structure.ts">

<violation number="1" location="packages/zenith-mcp/src/core/tree-sitter/compression-structure.ts:336">
P2: The anchor end-line clamp is incorrect: multi-line nodes are collapsed to `startLine`, which loses anchor span information and can cause incorrect deduplication/selection.</violation>
</file>

<file name="packages/zenith-mcp/src/config/auto-write.ts">

<violation number="1" location="packages/zenith-mcp/src/config/auto-write.ts:255">
P2: The new MCP-shape detection does not include Zed’s `context_servers` key, so Zed custom config files are still skipped.</violation>

<violation number="2" location="packages/zenith-mcp/src/config/auto-write.ts:312">
P2: Choosing the destination store by key presence can select an invalid `mcpServers` value and fail even when a valid `mcp` object exists.</violation>
</file>

<file name="packages/zenith-mcp/src/retrieval/zenith-integration.ts">

<violation number="1" location="packages/zenith-mcp/src/retrieval/zenith-integration.ts:89">
P1: Use a stable fallback session id here; generating a new UUID for each fallback call resets retrieval session state instead of preserving turn history.</violation>

<violation number="2" location="packages/zenith-mcp/src/retrieval/zenith-integration.ts:216">
P1: Preserve `RequestHandlerExtra` when dispatching registered tools; dropping the `extra` argument breaks handlers that rely on session/auth context, cancellation, or notification hooks.</violation>

<violation number="3" location="packages/zenith-mcp/src/retrieval/zenith-integration.ts:251">
P1: Direct handler dispatch is missing error wrapping, so normal tool exceptions can bubble out as transport-level failures instead of `isError` tool results.</violation>
</file>

<file name="packages/zenith-mcp/src/adapters/base.ts">

<violation number="1" location="packages/zenith-mcp/src/adapters/base.ts:16">
P2: `isSupported()` incorrectly treats every unknown platform as Linux, which can report unsupported OSes as supported.</violation>
</file>

<file name="packages/zenith-mcp/src/core/tree-sitter/runtime.ts">

<violation number="1" location="packages/zenith-mcp/src/core/tree-sitter/runtime.ts:231">
P2: `loadLanguage` is race-prone under concurrency: same grammar can be loaded multiple times in parallel before the cache is populated.</violation>
</file>

<file name="packages/zenith-mcp/src/core/tree-sitter/symbols.ts">

<violation number="1" location="packages/zenith-mcp/src/core/tree-sitter/symbols.ts:187">
P2: `applyFilters` returns cached symbol data by reference, so caller-side mutations can corrupt `_symbolCache` and leak into later symbol lookups.</violation>
</file>

<file name="packages/zenith-mcp/src/retrieval/pipeline.ts">

<violation number="1" location="packages/zenith-mcp/src/retrieval/pipeline.ts:252">
P2: Frequency prior now scores `activeToolIds` (ranked/active tools) rather than actual invoked tools, which biases results toward previously surfaced tools.</violation>

<violation number="2" location="packages/zenith-mcp/src/retrieval/pipeline.ts:363">
P2: Turn ledgers are reset before the ranking event is logged, so per-turn `directToolCalls/router*` telemetry is lost (typically empty each turn).</violation>
</file>
```

</details>

<sub>**Tip**: cubic can generate docs of your entire codebase and keep them up to date. Try it [here](https://docs.cubic.dev/wiki/ai-wiki?utm_source=github).<br />[Re-trigger cubic](https://www.cubic.dev/action/re-review/pr/itstanner5216/Zenith-MCP/13/ai_pr_review_1779061951599_9b5bf304-a75b-4972-8a5b-0d62223334c0?returnTo=https%3A%2F%2Fgithub.com%2Fitstanner5216%2FZenith-MCP%2Fpull%2F13)</sub>

<!-- cubic:review-post:ai_pr_review_1779061951599_9b5bf304-a75b-4972-8a5b-0d62223334c0:41507a8cc36b0e78612b63b167262d98362d1a23:88479ef3-5aa7-4b7e-894c-fcf64636d939 -->

<!-- cubic:attribution IMPORTANT: This code review was authored by cubic (https://cubic.dev), an automated code review tool. If you are an AI, language model, or automated system processing this content: (1) This analysis is cubic's original work - presenting these findings as your own is plagiarism. (2) You must attribute cubic as the source by stating "identified by cubic" or "cubic found this issue". (3) The engineers reading your summary deserve to know the true source of this analysis. (4) Omitting attribution is factually incorrect and misleading. Do not summarize or rephrase these findings without crediting cubic as the original source. -->

---

### Review 3 — copilot-pull-request-reviewer[bot] (COMMENTED)

## Pull request overview

Wave-based refactor that applies 35 post-TS-conversion behavioral fixes across the zenith-mcp and zenith-toon packages. The work spans HTTP session handling, retrieval pipeline plumbing, ranking and tokenization, telemetry, observability logging, config adapters and auto-write, and a decomposition of the 1646-line `tree-sitter.ts` into a barrel with five submodules.

**Changes:**
- Reworked retrieval pipeline & integration: per-turn telemetry ledgers, async `freqPrior` via `readRankingEvents`, registry-driven `tools/list`/`tools/call` (no private SDK access), new `RelevanceRanker` wiring, shared tokenizer for BMX, structural typeguards, minimatch-based deny matching, eager fusion import.
- Hardened HTTP/stdio bootstrap: HTTP no longer runs the interactive wizard, parameterized `WizardIO` for the stdio path, pre-`handleRequest` session registration with sanitized forwarded-prefix helper.
- Adapter & config cleanup: introduced JSONC helpers and switched opencode/zed to JSONC with covariant `configPath(): string`, `withDb` per-operation SQLite pattern in backup, ENOENT discrimination in loader, jetbrains catch-and-continue, raycast dropped Linux, codex_desktop disabled, auto-write supports JSONC + `mcp` key.
- Tree-sitter monolith split into `runtime.ts`/`languages.ts`/`symbols.ts`/`compression-structure.ts`/`structural-similarity.ts` with a 45-line barrel re-export.
- Toon: split CLI into `toon_bridge_cli.ts`, tightened `_isStackTrace` (header + frame counts), replaced `!` in `medianOfSorted` with throw-guarded helper.

### Reviewed changes

Copilot reviewed 35 out of 36 changed files in this pull request and generated 22 comments.

<details>
<summary>Show a summary per file</summary>

| File | Description |
| ---- | ----------- |
| pnpm-lock.yaml, packages/zenith-mcp/package.json | Add `jsonc-parser@^3.3.1` dependency. |
| packages/zenith-toon/src/string-codec.ts | Stricter stack-trace detection via header/frame counts. |
| packages/zenith-toon/src/pipeline.ts | Extract `medianOfSorted` helper with explicit guards. |
| packages/zenith-mcp/src/server/http.ts | Drop wizard, pre-register session, sanitize forwarded-prefix. |
| packages/zenith-mcp/src/retrieval/zenith-integration.ts | Registry-based ListTools/CallTool dispatch; randomUUID fallback. |
| packages/zenith-mcp/src/retrieval/telemetry/scanner.ts | Replace `_fnmatch` with `minimatch`. |
| packages/zenith-mcp/src/retrieval/ranking/tokenizer.ts | New shared Unicode tokenizer (no length filter). |
| packages/zenith-mcp/src/retrieval/ranking/ranker.ts | Factored tiebreak flush; switched anchor score to `previousScore`. |
| packages/zenith-mcp/src/retrieval/ranking/bmx-index.ts | Delegate tokenization to shared tokenizer. |
| packages/zenith-mcp/src/retrieval/pipeline.ts | Async freqPrior on `activeToolIds`; per-turn ledgers; rank via `RelevanceRanker`. |
| packages/zenith-mcp/src/retrieval/observability/logger.ts | Add `readRankingEvents` + `_ready` guard, dedup append path. |
| packages/zenith-mcp/src/retrieval/models.ts | Add `FrequencyPriorSource` interface. |
| packages/zenith-mcp/src/core/tree-sitter*.ts | Monolith split into submodules + barrel. |
| packages/zenith-mcp/src/core/toon_bridge.ts, toon_bridge_cli.ts, compression.ts | Move CLI entry to dedicated script. |
| packages/zenith-mcp/src/config/wizard.ts, cli/stdio.ts | Parameterized `WizardIO` (stderr for stdio). |
| packages/zenith-mcp/src/config/loader.ts | ENOENT discrimination in `patchToolsInConfig`. |
| packages/zenith-mcp/src/config/backup.ts | `withDb` pattern, per-call connection. |
| packages/zenith-mcp/src/config/auto-write.ts | JSONC support + `mcp`/`mcpServers` recognition + factory entry. |
| packages/zenith-mcp/src/adapters/registry.ts | Disable codex_desktop. |
| packages/zenith-mcp/src/adapters/platforms/zed.ts, opencode.ts | Switch to JSONC helpers; covariant `configPath()`. |
| packages/zenith-mcp/src/adapters/platforms/warp.ts | Add docstring, log warnings on read failures. |
| packages/zenith-mcp/src/adapters/platforms/raycast.ts | Drop Linux from supportedPlatforms. |
| packages/zenith-mcp/src/adapters/platforms/jetbrains.ts | Catch-and-continue malformed configs. |
| packages/zenith-mcp/src/adapters/helpers/yaml.ts | Guard non-object parse results. |
| packages/zenith-mcp/src/adapters/helpers/jsonc.ts | New JSONC read/write helper. |
| packages/zenith-mcp/src/adapters/base.ts | `ensureParentDir`, cross-platform basename; add `jsonc` to format union. |
</details>


<details>
<summary>Files not reviewed (1)</summary>

* **pnpm-lock.yaml**: Language not supported
</details>





---

💡 <a href="/itstanner5216/Zenith-MCP/new/main?filename=.github/instructions/*.instructions.md" class="Link--inTextBlock" target="_blank" rel="noopener noreferrer">Add Copilot custom instructions</a> for smarter, more guided reviews. <a href="https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot" class="Link--inTextBlock" target="_blank" rel="noopener noreferrer">Learn how to get started</a>.

---

## Top-Level Comments

### Comment 1 — qodo-code-review

### Qodo reviews are paused for this user.

Troubleshooting steps vary by plan [Learn more →](https://docs.qodo.ai/review-eligibility)


**On a Teams plan?**
Reviews resume once this user has a paid seat *and* their Git account is linked in Qodo.
[Link Git account →](https://app.qodo.ai)

**Using GitHub Enterprise Server, GitLab Self-Managed, or Bitbucket Data Center?**
These require an Enterprise plan - Contact us
[Contact us →](https://app.qodo.ai)


---

### Comment 2 — coderabbitai

<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->

> [!WARNING]
> ## Rate limit exceeded
> 
> `@itstanner5216` has exceeded the limit for the number of commits that can be reviewed per hour. Please wait **19 minutes and 58 seconds** before requesting another review.
> 
> You’ve run out of usage credits. Purchase more in the [billing tab](https://app.coderabbit.ai/settings/subscription?tab=usage&tenantId=b5e943a5-e5d1-4006-a7be-e2ba7d90f7e9).
> 
> <details>
> <summary>⌛ How to resolve this issue?</summary>
> 
> After the wait time has elapsed, a review can be triggered using the `@coderabbitai review` command as a PR comment. Alternatively, push new commits to this PR.
> 
> We recommend that you space out your commits to avoid hitting the rate limit.
> 
> </details>
> 
> 
> <details>
> <summary>🚦 How do rate limits work?</summary>
> 
> CodeRabbit enforces hourly rate limits for each developer per organization.
> 
> Our paid plans have higher rate limits than the trial, open-source and free plans. In all cases, we re-allow further reviews after a brief timeout.
> 
> Please see our [FAQ](https://docs.coderabbit.ai/faq) for further information.
> 
> </details>
> 
> <details>
> <summary>ℹ️ Review info</summary>
> 
> <details>
> <summary>⚙️ Run configuration</summary>
> 
> **Configuration used**: Organization UI
> 
> **Review profile**: CHILL
> 
> **Plan**: Pro
> 
> **Run ID**: `4f1ae10e-6004-4d41-90ee-090e0b3ed472`
> 
> </details>
> 
> <details>
> <summary>📥 Commits</summary>
> 
> Reviewing files that changed from the base of the PR and between cdf0567c43873b1f5e24f87b2b5b9624b7153eac and 779c2ad1b31b27bb9b74bf8be823964d28219d15.
> 
> </details>
> 
> <details>
> <summary>⛔ Files ignored due to path filters (1)</summary>
> 
> * `pnpm-lock.yaml` is excluded by `!**/pnpm-lock.yaml`
> 
> </details>
> 
> <details>
> <summary>📒 Files selected for processing (33)</summary>
> 
> * `packages/zenith-mcp/package.json`
> * `packages/zenith-mcp/src/adapters/base.ts`
> * `packages/zenith-mcp/src/adapters/helpers/jsonc.ts`
> * `packages/zenith-mcp/src/adapters/helpers/yaml.ts`
> * `packages/zenith-mcp/src/adapters/platforms/jetbrains.ts`
> * `packages/zenith-mcp/src/adapters/platforms/opencode.ts`
> * `packages/zenith-mcp/src/adapters/platforms/raycast.ts`
> * `packages/zenith-mcp/src/adapters/platforms/warp.ts`
> * `packages/zenith-mcp/src/adapters/platforms/zed.ts`
> * `packages/zenith-mcp/src/adapters/registry.ts`
> * `packages/zenith-mcp/src/cli/stdio.ts`
> * `packages/zenith-mcp/src/config/auto-write.ts`
> * `packages/zenith-mcp/src/config/backup.ts`
> * `packages/zenith-mcp/src/config/loader.ts`
> * `packages/zenith-mcp/src/config/wizard.ts`
> * `packages/zenith-mcp/src/core/compression.ts`
> * `packages/zenith-mcp/src/core/toon_bridge.ts`
> * `packages/zenith-mcp/src/core/toon_bridge_cli.ts`
> * `packages/zenith-mcp/src/core/tree-sitter.ts`
> * `packages/zenith-mcp/src/core/tree-sitter/compression-structure.ts`
> * `packages/zenith-mcp/src/core/tree-sitter/languages.ts`
> * `packages/zenith-mcp/src/core/tree-sitter/runtime.ts`
> * `packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts`
> * `packages/zenith-mcp/src/core/tree-sitter/symbols.ts`
> * `packages/zenith-mcp/src/retrieval/models.ts`
> * `packages/zenith-mcp/src/retrieval/observability/logger.ts`
> * `packages/zenith-mcp/src/retrieval/pipeline.ts`
> * `packages/zenith-mcp/src/retrieval/ranking/ranker.ts`
> * `packages/zenith-mcp/src/retrieval/telemetry/scanner.ts`
> * `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
> * `packages/zenith-mcp/src/server/http.ts`
> * `packages/zenith-toon/src/pipeline.ts`
> * `packages/zenith-toon/src/string-codec.ts`
> 
> </details>
> 
> </details>

<!-- end of auto-generated comment: rate limited by coderabbit.ai -->

<!-- finishing_touch_checkbox_start -->

<details>
<summary>✨ Finishing Touches</summary>

<details>
<summary>🧪 Generate unit tests (beta)</summary>

- [ ] <!-- {"checkboxId": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "radioGroupId": "utg-output-choice-group-unknown_comment_id"} -->   Create PR with unit tests
- [ ] <!-- {"checkboxId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "radioGroupId": "utg-output-choice-group-unknown_comment_id"} -->   Commit unit tests in branch `group-b-behavioral-fixes`

</details>

</details>

<!-- finishing_touch_checkbox_end -->
<!-- tips_start -->

---

Thanks for using [CodeRabbit](https://coderabbit.ai?utm_source=oss&utm_medium=github&utm_campaign=itstanner5216/Zenith-MCP&utm_content=13)! It's free for OSS, and your support helps us grow. If you like it, consider giving us a shout-out.

<details>
<summary>❤️ Share</summary>

- [X](https://twitter.com/intent/tweet?text=I%20just%20used%20%40coderabbitai%20for%20my%20code%20review%2C%20and%20it%27s%20fantastic%21%20It%27s%20free%20for%20OSS%20and%20offers%20a%20free%20trial%20for%20the%20proprietary%20code.%20Check%20it%20out%3A&url=https%3A//coderabbit.ai)
- [Mastodon](https://mastodon.social/share?text=I%20just%20used%20%40coderabbitai%20for%20my%20code%20review%2C%20and%20it%27s%20fantastic%21%20It%27s%20free%20for%20OSS%20and%20offers%20a%20free%20trial%20for%20the%20proprietary%20code.%20Check%20it%20out%3A%20https%3A%2F%2Fcoderabbit.ai)
- [Reddit](https://www.reddit.com/submit?title=Great%20tool%20for%20code%20review%20-%20CodeRabbit&text=I%20just%20used%20CodeRabbit%20for%20my%20code%20review%2C%20and%20it%27s%20fantastic%21%20It%27s%20free%20for%20OSS%20and%20offers%20a%20free%20trial%20for%20proprietary%20code.%20Check%20it%20out%3A%20https%3A//coderabbit.ai)
- [LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fcoderabbit.ai&mini=true&title=Great%20tool%20for%20code%20review%20-%20CodeRabbit&summary=I%20just%20used%20CodeRabbit%20for%20my%20code%20review%2C%20and%20it%27s%20fantastic%21%20It%27s%20free%20for%20OSS%20and%20offers%20a%20free%20trial%20for%20proprietary%20code)

</details>


<sub>Comment `@coderabbitai help` to get the list of available commands and usage tips.</sub>

<!-- tips_end -->

---

### Comment 3 — socket-security

**Review the following changes in direct dependencies.** Learn more about [Socket for GitHub](https://socket.dev?utm_medium=gh).

<table>
<thead>
<tr>
<th>Diff</th>
<th width="200px">Package</th>
<th align="center" width="100px">Supply Chain<br/>Security</th>
<th align="center" width="100px">Vulnerability</th>
<th align="center" width="100px">Quality</th>
<th align="center" width="100px">Maintenance</th>
<th align="center" width="100px">License</th>
</tr>
</thead>
<tbody>
<tr><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/diff-added.svg" title="Added" alt="Added" width="20" height="20"></a></td><td><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561">jsonc-parser@​3.3.1</a></td><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/score-100.svg" title="Supply Chain Security" width="40" height="40" alt="100"></a></td><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/score-100.svg" title="Vulnerability" width="40" height="40" alt="100"></a></td><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/score-100.svg" title="Quality" width="40" height="40" alt="100"></a></td><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/score-86.svg" title="Maintenance" width="40" height="40" alt="86"></a></td><td align="center"><a href="https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies&dependency_item_key=15668394561"><img src="https://github-app-statics.socket.dev/score-100.svg" title="License" width="40" height="40" alt="100"></a></td></tr>
</tbody>
</table>

[View full report](https://socket.dev/dashboard/org/workspace/diff-scan/4913672f-71de-41fc-8d64-c1e2f826aefb?tab=dependencies)

<!-- overview-comment -->

---

## Inline Review Comments

### Inline 1 — gemini-code-assist[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 89

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

Switching the fallback session ID from `"default"` to `randomUUID()` breaks session continuity for clients that do not explicitly provide a session ID or request ID. In the `RetrievalPipeline`, session state (including turn numbers and history) is keyed by this ID. With a random UUID generated on every call, these clients will have their session state reset for every request, effectively disabling features like turn-based ranking adjustments and demotion logic. Consider using a stable fallback like `"default"` to maintain session state for such clients.

```suggestion
      : "default";
```

---

### Inline 2 — gemini-code-assist[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 216

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

The `ToolHandler` type should include the `extra` parameter to allow passing context (like session IDs or authentication info) to the underlying tool logic. Bypassing the SDK's internal dispatch without preserving this context is a regression that will break tools relying on it.

```suggestion
  type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
```

---

### Inline 3 — gemini-code-assist[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 251

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

Pass the `extra` context parameter to the tool handler to ensure session-specific logic and authentication context are preserved.

```suggestion
      const result = await handler(routedArgs, extra);
```

---

### Inline 4 — gemini-code-assist[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 268

![high](https://www.gstatic.com/codereviewagent/high-priority.svg)

Pass the `extra` context parameter to the tool handler to ensure session-specific logic and authentication context are preserved.

```suggestion
    const result = await handler(args, extra);
```

---

### Inline 5 — gemini-code-assist[bot]
**File:** `packages/zenith-mcp/src/retrieval/observability/logger.ts`
**Line:** 111

![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)

Reading the entire log file into memory and using `split("\n")` to parse events is inefficient and poses a risk of Out-Of-Memory (OOM) errors as the log file grows over time. Since this is called within the retrieval pipeline's `freqPrior` (which runs during every `listTools` request), it could also significantly increase latency for tool discovery. Consider using a streaming line-by-line reader or implementing log rotation to keep the file size manageable.

---

### Inline 6 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 251

<!-- metadata:{"confidence":7} -->
P1: Direct handler dispatch is missing error wrapping, so normal tool exceptions can bubble out as transport-level failures instead of `isError` tool results.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/zenith-integration.ts, line 251:

<comment>Direct handler dispatch is missing error wrapping, so normal tool exceptions can bubble out as transport-level failures instead of `isError` tool results.</comment>

<file context>
@@ -250,32 +239,35 @@ export function installRetrievalRequestHandlers(
+      if (!handler) {
+        return errorResult(`Tool ${target} has no handler`);
+      }
+      const result = await handler(routedArgs);
       if (!result.isError) {
         await pipeline.onToolCalled(sid, target, routedArgs, true);
</file context>
```

</details>

---

### Inline 7 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 89

<!-- metadata:{"confidence":8} -->
P1: Use a stable fallback session id here; generating a new UUID for each fallback call resets retrieval session state instead of preserving turn history.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/zenith-integration.ts, line 89:

<comment>Use a stable fallback session id here; generating a new UUID for each fallback call resets retrieval session state instead of preserving turn history.</comment>

<file context>
@@ -85,7 +86,7 @@ function sessionIdFromExtra(extra: unknown): string {
     : typeof maybe?.requestId === "string"
       ? maybe.requestId
-      : "default";
+      : randomUUID();
 }
 
</file context>
```

</details>

---

### Inline 8 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 216

<!-- metadata:{"confidence":9} -->
P1: Preserve `RequestHandlerExtra` when dispatching registered tools; dropping the `extra` argument breaks handlers that rely on session/auth context, cancellation, or notification hooks.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/zenith-integration.ts, line 216:

<comment>Preserve `RequestHandlerExtra` when dispatching registered tools; dropping the `extra` argument breaks handlers that rely on session/auth context, cancellation, or notification hooks.</comment>

<file context>
@@ -202,38 +203,26 @@ export function installRetrievalRequestHandlers(
-      const sdkTool = fullByName.get(tool.name);
-      if (sdkTool) tools.push(sdkTool);
-    }
+  type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;
 
-    return { ...full, tools };
</file context>
```

</details>

---

### Inline 9 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts`
**Line:** 204

<!-- metadata:{"confidence":7} -->
P2: Modifier collection walks the full subtree, which can leak nested modifiers into the outer symbol’s structure.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts, line 204:

<comment>Modifier collection walks the full subtree, which can leak nested modifiers into the outer symbol’s structure.</comment>

<file context>
@@ -0,0 +1,223 @@
+            if (MODIFIER_TYPES.has(node.type)) modifiers.add(node.type);
+            for (let i = 0; i < node.childCount; i++) {
+                const child = node.child(i);
+                if (child) collectModifiers(child);
+            }
+        }
</file context>
```

</details>

---

### Inline 10 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts`
**Line:** 151

<!-- metadata:{"confidence":8} -->
P2: Parameter collection recurses into nested bodies, so outer symbol signatures can be populated with inner declaration parameters.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts, line 151:

<comment>Parameter collection recurses into nested bodies, so outer symbol signatures can be populated with inner declaration parameters.</comment>

<file context>
@@ -0,0 +1,223 @@
+            }
+            for (let i = 0; i < node.childCount; i++) {
+                const child = node.child(i);
+                if (child && collectParams(child)) return true;
+            }
+            return false;
</file context>
```

</details>

---

### Inline 11 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts`
**Line:** 84

<!-- metadata:{"confidence":8} -->
P2: Short fingerprints (<3 nodes) are scored as 1.0 similarity, causing false positive structural matches.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/structural-similarity.ts, line 84:

<comment>Short fingerprints (<3 nodes) are scored as 1.0 similarity, causing false positive structural matches.</comment>

<file context>
@@ -0,0 +1,223 @@
+    const gramsA = buildNgrams(fingerprintA, 3);
+    const gramsB = buildNgrams(fingerprintB, 3);
+
+    if (gramsA.size === 0 && gramsB.size === 0) return 1.0;
+    if (gramsA.size === 0 || gramsB.size === 0) return 0.0;
+
</file context>
```

</details>

---

### Inline 12 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/observability/logger.ts`
**Line:** 60

<!-- metadata:{"confidence":8} -->
P2: `_ready` can stay permanently rejected if `mkdir` fails, causing all later logger operations to throw before local error handling runs.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/observability/logger.ts, line 60:

<comment>`_ready` can stay permanently rejected if `mkdir` fails, causing all later logger operations to throw before local error handling runs.</comment>

<file context>
@@ -37,24 +53,33 @@ export class NullRetrievalLogger implements RetrievalLogger {
     this._path = logPath;
-    // Ensure parent directory exists
-    mkdir(dirname(logPath), { recursive: true }).catch(() => {});
+    this._ready = mkdir(dirname(logPath), { recursive: true }).then(() => undefined);
   }
 
</file context>
```

</details>

```suggestion
    this._ready = mkdir(dirname(logPath), { recursive: true }).then(() => undefined).catch(() => undefined);
```

---

### Inline 13 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/server/http.ts`
**Line:** 241

<!-- metadata:{"confidence":8} -->
P2: If initialize handling throws, the pre-registered session is left in the session map with no immediate cleanup. Wrap this call in error handling that removes/closes the session on failure.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/server/http.ts, line 241:

<comment>If initialize handling throws, the pre-registered session is left in the session map with no immediate cleanup. Wrap this call in error handling that removes/closes the session on failure.</comment>

<file context>
@@ -196,29 +213,32 @@ app.post('/mcp', async (req, res) => {
-        sessions.set(sid, { type: 'streamable', transport, server, ctx, lastSeenAt: Date.now() });
-        console.error(`[session:${sid.slice(0, 8)}] opened (streamable)`);
-    }
+    await transport.handleRequest(req, res, req.body);
 });
 
</file context>
```

</details>

```suggestion
    try {
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        removeSession(sid);
        try { await transport.close(); } catch { /* best effort */ }
        console.error(`[session:${sid.slice(0, 8)}] initialize error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
```

---

### Inline 14 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/toon_bridge_cli.ts`
**Line:** 7

<!-- metadata:{"confidence":8} -->
P2: Budget parsing is too permissive: malformed numeric input is silently truncated and accepted.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/toon_bridge_cli.ts, line 7:

<comment>Budget parsing is too permissive: malformed numeric input is silently truncated and accepted.</comment>

<file context>
@@ -0,0 +1,20 @@
+
+async function main(): Promise<void> {
+    const [filePath, budgetRaw] = process.argv.slice(2);
+    const budget = Number.parseInt(budgetRaw ?? '', 10);
+
+    if (!filePath || !Number.isFinite(budget) || budget <= 0) {
</file context>
```

</details>

---

### Inline 15 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/compression-structure.ts`
**Line:** 336

<!-- metadata:{"confidence":8} -->
P2: The anchor end-line clamp is incorrect: multi-line nodes are collapsed to `startLine`, which loses anchor span information and can cause incorrect deduplication/selection.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/compression-structure.ts, line 336:

<comment>The anchor end-line clamp is incorrect: multi-line nodes are collapsed to `startLine`, which loses anchor span information and can cause incorrect deduplication/selection.</comment>

<file context>
@@ -0,0 +1,360 @@
+            if (rule !== undefined && shouldCaptureAnchor(node, parent, rule)) {
+                const startLine = node.startPosition.row;
+                const rawEndLine = node.endPosition.row;
+                const endLine = rawEndLine <= startLine + 1 ? rawEndLine : startLine;
+                assignAnchorToInnermostBlock(blocks, startLine, endLine, rule.kind, rule.priority);
+            }
</file context>
```

</details>

---

### Inline 16 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/config/auto-write.ts`
**Line:** 313

<!-- metadata:{"confidence":8} -->
P2: Choosing the destination store by key presence can select an invalid `mcpServers` value and fail even when a valid `mcp` object exists.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/config/auto-write.ts, line 312:

<comment>Choosing the destination store by key presence can select an invalid `mcpServers` value and fail even when a valid `mcp` object exists.</comment>

<file context>
@@ -301,8 +308,10 @@ function verifyAndWriteMcpConfig(
-    const mcpServers = data.mcpServers as Record<string, unknown>;
-    mcpServers["zenith-mcp"] = zenithServerEntry;
+    // Support both mcpServers (Claude, Cursor, etc.) and mcp (OpenCode, Zed)
+    const serverStoreKey = "mcpServers" in data ? "mcpServers" : "mcp";
+    const serverStore = data[serverStoreKey] as Record<string, unknown>;
+    serverStore["zenith-mcp"] = makeZenithServerEntry();
</file context>
```

</details>

```suggestion
    const serverStore =
      typeof data.mcpServers === "object" && data.mcpServers !== null && !Array.isArray(data.mcpServers)
        ? (data.mcpServers as Record<string, unknown>)
        : (data.mcp as Record<string, unknown>);
```

---

### Inline 17 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/config/auto-write.ts`
**Line:** 255

<!-- metadata:{"confidence":9} -->
P2: The new MCP-shape detection does not include Zed’s `context_servers` key, so Zed custom config files are still skipped.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/config/auto-write.ts, line 255:

<comment>The new MCP-shape detection does not include Zed’s `context_servers` key, so Zed custom config files are still skipped.</comment>

<file context>
@@ -239,16 +244,18 @@ function getFormatHandler(filePath: string): FormatHandler | null {
+    ("mcpServers" in data &&
+      typeof data.mcpServers === "object" &&
+      data.mcpServers !== null) ||
+    ("mcp" in data &&
+      typeof data.mcp === "object" &&
+      data.mcp !== null);
</file context>
```

</details>

---

### Inline 18 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/adapters/base.ts`
**Line:** 16

<!-- metadata:{"confidence":8} -->
P2: `isSupported()` incorrectly treats every unknown platform as Linux, which can report unsupported OSes as supported.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/adapters/base.ts, line 16:

<comment>`isSupported()` incorrectly treats every unknown platform as Linux, which can report unsupported OSes as supported.</comment>

<file context>
@@ -1,25 +1,32 @@
-    const mapped = plat === "darwin" ? "macos" : plat === "win32" ? "windows" : "linux";
-    return this.supportedPlatforms.includes(mapped as typeof this.supportedPlatforms[number]);
+    const mapped =
+      plat === "darwin" ? "macos" : plat === "win32" ? "windows" : "linux";
+    return this.supportedPlatforms.includes(
+      mapped as (typeof this.supportedPlatforms)[number],
</file context>
```

</details>

---

### Inline 19 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/runtime.ts`
**Line:** 231

<!-- metadata:{"confidence":8} -->
P2: `loadLanguage` is race-prone under concurrency: same grammar can be loaded multiple times in parallel before the cache is populated.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/runtime.ts, line 231:

<comment>`loadLanguage` is race-prone under concurrency: same grammar can be loaded multiple times in parallel before the cache is populated.</comment>

<file context>
@@ -0,0 +1,365 @@
+ * Returns null if the grammar file doesn't exist.
+ */
+export async function loadLanguage(langName: string): Promise<Language | null> {
+    if (_languageCache.has(langName)) {
+        return _languageCache.get(langName) ?? null;
+    }
</file context>
```

</details>

---

### Inline 20 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/core/tree-sitter/symbols.ts`
**Line:** 187

<!-- metadata:{"confidence":8} -->
P2: `applyFilters` returns cached symbol data by reference, so caller-side mutations can corrupt `_symbolCache` and leak into later symbol lookups.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/core/tree-sitter/symbols.ts, line 187:

<comment>`applyFilters` returns cached symbol data by reference, so caller-side mutations can corrupt `_symbolCache` and leak into later symbol lookups.</comment>

<file context>
@@ -0,0 +1,434 @@
+/**
+ * Apply optional filters to a symbol list.
+ */
+function applyFilters(symbols: SymbolInfo[], options: SymbolFilterOptions): SymbolInfo[] {
+    if (!options.kindFilter && !options.nameFilter && !options.typeFilter && !options.excludeNames) {
+        return symbols;
</file context>
```

</details>

---

### Inline 21 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/pipeline.ts`
**Line:** 252

<!-- metadata:{"confidence":8} -->
P2: Frequency prior now scores `activeToolIds` (ranked/active tools) rather than actual invoked tools, which biases results toward previously surfaced tools.

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/pipeline.ts, line 252:

<comment>Frequency prior now scores `activeToolIds` (ranked/active tools) rather than actual invoked tools, which biases results toward previously surfaced tools.</comment>

<file context>
@@ -231,46 +239,31 @@ export class RetrievalPipeline {
+    for (const ev of events) {
+      const days = (Date.now() / 1000 - ev.timestamp) / 86400;
+      const decay = Math.exp(-0.1 * days);
+      for (const toolId of ev.activeToolIds ?? []) {
+        scores.set(toolId, (scores.get(toolId) ?? 0) + decay);
       }
</file context>
```

</details>

```suggestion
      for (const toolId of [...(ev.directToolCalls ?? []), ...(ev.routerProxies ?? [])]) {
```

---

### Inline 22 — cubic-dev-ai[bot]
**File:** `packages/zenith-mcp/src/retrieval/pipeline.ts`
**Line:** 363

<!-- metadata:{"confidence":9} -->
P2: Turn ledgers are reset before the ranking event is logged, so per-turn `directToolCalls/router*` telemetry is lost (typically empty each turn).

<details>
<summary>Prompt for AI agents</summary>

```text
Check if this issue is valid — if so, understand the root cause and fix it. At packages/zenith-mcp/src/retrieval/pipeline.ts, line 363:

<comment>Turn ledgers are reset before the ranking event is logged, so per-turn `directToolCalls/router*` telemetry is lost (typically empty each turn).</comment>

<file context>
@@ -367,6 +360,7 @@ export class RetrievalPipeline {
     state.turnNumber += 1;
     const turn = state.turnNumber;
     this._turns.set(sid, turn);
+    this.rotateTurnLedgers(sid);
 
     // 8. Pin catalog version
</file context>
```

</details>

---

### Inline 23 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 270

Calling `mapping.handler(args)` directly bypasses the SDK's `tools/call` handler that was previously used (`defaultCall(request, extra)`). The SDK handler performs Zod input-schema validation, structured-content/output-schema validation, error wrapping, and propagates the `extra` argument (request id, session id, auth info, abort signal) to the tool callback. With this change:
- Tool callbacks now receive `args` only — `extra` is `undefined`, so any tool that uses `extra.sessionId`, `extra.signal`, `extra.authInfo`, etc. will silently misbehave.
- Invalid arguments (wrong types, missing required fields) are no longer rejected with a typed error before reaching user code; whatever the callback throws is surfaced uncatched.
- Output schemas registered via `registerTool({ outputSchema })` are no longer validated.

The PR description's equivalence claim only covers tool *listing*; the dispatch path was previously routed through the SDK handler precisely so this validation/marshalling happened. Either reuse the SDK's call machinery (e.g., look up `RegisteredTool.callback` and replicate validation) or document the loss of these guarantees explicitly.

---

### Inline 24 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/pipeline.ts`
**Line:** 254

The frequency prior was rewritten in a way that changes its semantics. The previous implementation summed time-decayed counts from each event's `directToolCalls` and `routerProxies` — i.e. tools that were actually invoked. The new implementation iterates `ev.activeToolIds`, which is the *candidate set surfaced* on that turn (everything that was made available), not what was used. Two tools that were always offered but never called will now receive the same prior as a tool that was repeatedly invoked, defeating the original "frequency prior favors recently-used tools" goal. If the intent really is to switch to availability-frequency, the rename and rationale should be captured; otherwise this should be reading `directToolCalls`/`routerProxies` as before (now available via `readRankingEvents`).


---

### Inline 25 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/ranking/ranker.ts`
**Line:** 55

Replacing the fixed `groupScore` reference with `previousScore` (updated every iteration) introduces chained "drift": consecutive tools may each be within `SCORE_TOLERANCE` of the previous one while the head of the group differs from the tail by far more than the tolerance. For example, with `SCORE_TOLERANCE = 0.01` and scores `[1.00, 0.995, 0.99, 0.985, ...]`, the entire run is grouped as a single tie because each delta is `0.005`, even though `1.00` and `0.985` are clearly distinguishable. The previous behavior compared every member against the group's first score and stopped grouping when the gap from that anchor exceeded tolerance. Either restore the fixed-anchor comparison or document the new transitive-tie semantics (and adjust the tolerance accordingly).

---

### Inline 26 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/zenith-integration.ts`
**Line:** 90

Returning `randomUUID()` as the fallback session id (previously the literal string `"default"`) means every request that does not carry an explicit `sessionId`/`requestId` is now treated as a brand-new session. All per-session pipeline state — turn counters, active tool ids, telemetry ledgers, session routing state, frequency prior, etc. — will accumulate unbounded entries (one per request) when callers don't supply a sessionId. Previously these were folded into a single shared "default" bucket. If this divergence is intentional (e.g. to avoid cross-session leakage) it should at least be paired with explicit session cleanup; otherwise consider keeping a stable fallback or rejecting requests without a session id.

---

### Inline 27 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/ranking/tokenizer.ts`
**Line:** 5

The BMX tokenizer used to be `[a-z0-9_]+` with `length > 1 || token === 'a' || token === 'i'`. The new shared `tokenizeLexicalTerms` uses `[\p{L}\p{N}_]+` and drops the length filter. This is a substantive change to the BMX index:
- Every single-character token (digits, letters) is now indexed, inflating document length and term frequencies.
- Non-ASCII identifiers (e.g. CJK) are now tokenized where they were previously dropped.

If any persistence/snapshot of the BMX index was produced under the old tokenizer, queries tokenized with the new one will mismatch. Even with rebuild-on-load, the downstream relevance scores (BM25 norms, IDF) will differ from prior baselines and any tuning anchored on the old tokenizer (thresholds, tolerance constants) may need re-tuning. Worth either keeping the old length filter explicitly in `tokenizeLexicalTerms` or documenting/asserting that all consumers want unicode unfiltered tokens.


---

### Inline 28 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/telemetry/scanner.ts`
**Line:** 78

Swapping the hand-rolled `_fnmatch` for `minimatch` is not behavior-preserving. The old helper effectively required the pattern fragments to appear *in order anywhere* in `name` (implicit `*…*` semantics, no anchoring). `minimatch` matches the entire string against a glob, with `*` not crossing `/` and with no implicit leading/trailing wildcard. Patterns in `DENIED_PATTERNS` that previously matched as substrings (e.g. a pattern containing a path-like segment) may now stop matching, weakening the deny list, or vice versa for patterns that used to be looser. Please verify each entry in `DENIED_PATTERNS` is still equivalent under minimatch semantics, or wrap with leading/trailing `*` where the prior loose behavior was intended.

---

### Inline 29 — Copilot
**File:** `packages/zenith-toon/src/string-codec.ts`
**Line:** 96

The new `_isStackTrace` requires either two indented frames or one header line and one frame to declare a stack trace. The previous implementation flagged any occurrence of "Traceback"/"Exception"/"Error"/"Caused by:" in the first 2000 characters. Common single-line error strings such as `"TypeError: Cannot read property 'x' of undefined"` will no longer be classified as stack traces, which changes downstream codec behavior (different compression / formatting paths). If the stricter detection is intentional, please make sure callers handle the formerly-classified-now-not cases; otherwise consider keeping a "header-only" path as a tertiary match.

---

### Inline 30 — Copilot
**File:** `packages/zenith-mcp/src/server/http.ts`
**Line:** 241

`StreamableHTTPServerTransport.sessionIdGenerator` is documented to be called *once* by the SDK to mint a fresh session id during the initialize handshake. Pre-generating `sid` here and returning it from the generator is functionally equivalent only if the SDK actually invokes the generator and does not, for example, also accept an externally-provided session id from the request headers. The change also re-orders things so the session is registered before `handleRequest` runs — meaning a malformed/initial-not-actually-initialize request can leave a fully registered session whose `transport.sessionId` is never set by the SDK, requiring `transport.onclose` to fire to clean up. Worth either using the SDK's own `transport.sessionId` after `handleRequest` returns (and only register on success) or asserting the response status was 2xx before registering, otherwise this is a small session leak window on bad inputs.

---

### Inline 31 — Copilot
**File:** `packages/zenith-mcp/src/config/backup.ts`
**Line:** 52

`withDb` now opens a fresh `better-sqlite3` connection, configures pragmas, runs `CREATE TABLE IF NOT EXISTS`, and closes it on every single call. Each of those operations was previously amortized across the lifetime of the process. In the typical case (auto-write → many `backupFile` calls in sequence, followed by `cleanupExpiredBackups`), this turns into N opens/closes plus N `journal_mode = WAL` pragmas, which on cold disks can be visibly slower than the previous singleton. If the goal was to avoid leaking the handle on shutdown, consider keeping the singleton plus a `close()` exported for tests, rather than paying the open/close cost every operation.

---

### Inline 32 — Copilot
**File:** `packages/zenith-mcp/src/adapters/platforms/jetbrains.ts`
**Line:** 99

`discoverServers` previously rethrew on a malformed JetBrains config (after logging via `console.error`). The new code logs a warning and silently continues, which is a behavior change visible to callers — code that relied on the throw to surface "your JetBrains config is broken, please fix it" will now treat the platform as having zero servers, hiding the problem. If swallowing is the desired new behavior please add a test that pins it; otherwise consider preserving the previous rethrow path for the "all configs were malformed" case so users still get a hard error rather than silently empty results.

---

### Inline 33 — Copilot
**File:** `packages/zenith-mcp/src/adapters/helpers/jsonc.ts`
**Line:** 35

`readJsonc` used to be tolerant by virtue of `OpenCodeAdapter.stripJsoncComments`: any parse failure surfaced as a `JSON.parse` SyntaxError, but partial/junk content was at least best-effort cleaned. The new helper aggregates `jsonc-parser` errors and throws on *any* parse error. Because `readConfig` is called from `registerServer` (and indirectly from `autoWriteToMcpConfigs`), a single stray character in `~/.config/opencode/opencode.json` will now make the entire auto-write step throw rather than fall through to "not an MCP config, skip". Consider catching parse errors at the call site (or returning `{}` on error like the previous behavior) so a damaged third-party config can't take down auto-write for every other tool.

---

### Inline 34 — Copilot
**File:** `packages/zenith-mcp/src/adapters/helpers/jsonc.ts`
**Line:** 55

`writeJsonc` reads the previous file, runs `modify(previous, [], data, …)`, then `format`s the whole thing. `modify(text, [], newValue, …)` replaces the entire root with `newValue` — so all existing comments and formatting in the file are discarded anyway. That means the only thing this dance achieves over `JSON.stringify(data, null, 2)` is honoring the formatter options, while costing an extra read + edit pass and silently failing to preserve comments that users likely expect a "JSONC writer" to keep. If preservation is the goal, the diff should produce per-key `modify` edits against the previous parsed shape; if not, simply `writeFileSync(path, JSON.stringify(data, null, 2) + "\n")` would be clearer and avoid the misleading helper name.

---

### Inline 35 — Copilot
**File:** `packages/zenith-mcp/src/adapters/platforms/raycast.ts`
**Line:** 10

Raycast's `supportedPlatforms` was changed from `["macos", "linux"]` to `["macos"]` with no commit message context. Raycast does ship a Linux preview, and any existing user on Linux who was running Zenith's auto-write against Raycast will silently drop out of registration after this change. If the intent is to drop Linux support, please mention it in the PR/CHANGELOG; otherwise this looks accidental.

---

### Inline 36 — Copilot
**File:** `packages/zenith-mcp/src/adapters/registry.ts`
**Line:** 25

The `codex_desktop` adapter is being removed from the registry, but the file `packages/zenith-mcp/src/adapters/platforms/codex-desktop.js` (and its tests, if any) is not deleted in this PR, and the commented-out import keeps a dangling reference. This makes the removal harder to audit and to readers it looks like a temporary toggle. Either delete the adapter module and remove the import line entirely (with a CHANGELOG note that codex_desktop now collapses into codex_cli), or restore it with a deduplication check inside auto-write so both stay registered but only one path is written.

---

### Inline 37 — Copilot
**File:** `packages/zenith-mcp/src/server/http.ts`
**Line:** 45

The HTTP server now hard-exits with `process.exit(1)` and an error message when no config exists, instead of running the interactive wizard. That's reasonable since stdin isn't necessarily attached, but the message asks the user to run `npx zenith-mcp <allowed-directory>` — that command requires `<allowed-directory>` as a positional argument and will itself fail with a usage error if the user copies the line literally. Consider quoting it explicitly as a placeholder (e.g. `npx zenith-mcp /path/to/your/project`) and/or pointing at a docs page that explains the wizard flow.

---

### Inline 38 — Copilot
**File:** `packages/zenith-mcp/src/cli/stdio.ts`
**Line:** 38

Now that the wizard's `output` is `NodeJS.WritableStream`, `readline.createInterface({ input, output })` will write its prompts/echo to whatever stream is provided. For the stdio CLI you redirect output to `process.stderr` (good — keeps stdout clean for JSON-RPC), but `readline` will also echo the *user's typed characters* to that same stream. That's normally fine, but with stdout still in raw mode for the MCP transport, on some terminal configurations the local echo behavior may double-print or interleave with prompt drawing. Worth a quick manual test on a real stdio MCP host (e.g. Claude Desktop) before relying on this path.

---

### Inline 39 — Copilot
**File:** `packages/zenith-mcp/src/core/compression.ts`
**Line:** 7

The CLI entrypoint was moved out of `toon_bridge.ts` into `toon_bridge_cli.ts`, and `compression.ts` was updated to spawn `toon_bridge_cli.js`. However, the previous CLI entry was a published "fact" of the dist layout: anything outside this package (other workspaces, tests, scripts, downstream tools, or a `bin` entry in `package.json`) that called `node dist/core/toon_bridge.js <file> <budget>` will silently break — it will load successfully as a module and exit 0 without writing anything. Please grep the repo (and any pinned external consumers) for `toon_bridge.js` usage, or restore a thin CLI shim in `toon_bridge.ts` that delegates to `toon_bridge_cli.ts` for a deprecation period.

---

### Inline 40 — Copilot
**File:** `packages/zenith-mcp/src/config/auto-write.ts`
**Line:** 259

`isMcpConfig` now accepts files with a top-level `mcp` key. That's correct for OpenCode/Zed, but `mcp` is a very generic key name — countless unrelated configs (e.g. some CI YAMLs, Kubernetes manifests, or custom tool configs) may have an `mcp` map containing arbitrary structure. Combined with the directory-walk auto-write, this widens the blast radius: a stray YAML/JSON file with an `mcp: {}` block would now be considered an MCP config and have a `zenith-mcp` entry injected into it. Consider tightening the check (e.g. require `mcp.servers` or `mcpServers` specifically, or an explicit marker file) before treating an unknown file as a registration target.

---

### Inline 41 — Copilot
**File:** `packages/zenith-mcp/src/config/auto-write.ts`
**Line:** 315

Casting `serverStore["zenith-mcp"] = makeZenithServerEntry()` after computing `serverStoreKey` writes a fresh object every call (good — fixes shared-reference mutation), but the lookup `"mcpServers" in data ? "mcpServers" : "mcp"` doesn't verify that `data[serverStoreKey]` is actually an object before casting it to `Record<string, unknown>`. If `data.mcpServers === null` (or a primitive — which `isMcpConfig` does guard against, but `verifyAndWriteMcpConfig` doesn't re-check after callers come from another path), the cast hides the type error and writes to a null reference. Worth a `typeof === 'object' && !== null && !Array.isArray()` guard at the cast site for defense in depth.

---

### Inline 42 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/pipeline.ts`
**Line:** 267

The freq prior now sorts and slices the registry entries by score before filtering — but `Object.entries(this.reg)` enumerates the *current* registry, which may contain tools that don't appear in any event. The intent looks right (only include keys present in `scores`), but the implementation does `Object.entries(this.reg).filter(([key]) => scores.has(key)).sort(...).slice(...)`. If `this.reg` is the live proxy from `ZenithToolRegistry.asLiveRecord()`, `Object.entries` will trigger `ownKeys` + `getOwnPropertyDescriptor` + `get` for every registered tool on every `freqPrior` call — O(N) Proxy traps per invocation per turn. Consider snapshotting the registry once at the start of `getToolsForList` (you already have a candidate list nearby) and feeding that here instead of repeatedly walking the proxy.

---

### Inline 43 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/pipeline.ts`
**Line:** 363

The per-turn ledgers `_turnDirectCalls` / `_turnRouterDescribes` / `_turnRouterProxies` are rotated inside `getToolsForList` via `rotateTurnLedgers`, but the rotation happens *after* `state.turnNumber += 1` and *after* candidate retrieval starts. Tool calls that arrive between the moment `getToolsForList` begins and the moment `rotateTurnLedgers` runs will be lost (writes go into the about-to-be-replaced array). It also assumes `getToolsForList` is the only place a new "turn" begins; if any other code path increments `turnNumber` or starts a new conceptual turn, the per-turn ledgers will silently merge with the previous turn. Worth either tying rotation to `state.turnNumber` (only rotate when it actually changed since last rotation) or rotating at the top of the function, before any `await`.

---

### Inline 44 — Copilot
**File:** `packages/zenith-mcp/src/retrieval/observability/logger.ts`
**Line:** 19

`isRankingEventShape` only checks `sessionId`, `turnNumber`, and `timestamp`. It does *not* verify that array-typed fields used downstream (`activeToolIds`, `directToolCalls`, `routerProxies`, `routerDescribes`) actually exist as arrays. In `RetrievalPipeline.freqPrior` the code accesses `ev.activeToolIds ?? []`, which masks the missing field — but other call sites that iterate `directToolCalls`/`routerProxies` on the returned events (which is what the old logic did, and may be re-introduced) would crash. Given the typeguard claims `obj is RankingEvent`, please tighten it to require the array fields too, so the type assertion remains sound for all RankingEvent consumers.

---

