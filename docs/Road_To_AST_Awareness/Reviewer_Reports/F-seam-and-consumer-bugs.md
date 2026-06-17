# Reviewer F — Cross-Package Seam Contract & Consumer-Tool Bugs

**PR:** #23 / branch `pr-23` / HEAD `a13fa71`
**Scope:** the MCP↔TOON seam shape, the read-tool wiring around it, refactor_batch's outlier check, and the `RawFileFacts` payload's internal line-base consistency.

## Summary

Five findings, all valid against the actual PR code. Three are seam-contract bugs (#1, #2, #5) that cross the MCP↔TOON package boundary and can silently violate Priority 0 / Priority 0.5; two are consumer-tool bugs (#3, #4) that drop functionality silently. None are blocked by anything in PR 23's own scope — every fix is local and small.

| # | Finding | Severity | Constraint violated |
|---|---|---|---|
| 1 | MCP pre-truncates `content` before handing it to TOON | **High** | Priority 0.5 (compression decision in MCP) + Priority 0 (line numbers TOON sees can't be true to source) |
| 2 | `read_multiple_files` final-budget slice can chop mid-line / mid-marker in TOON output | **High** | Priority 0 (verbatim lines + intact markers) |
| 3 | Small files zero-out `effectiveBudget` due to per-entry label overhead | Medium | none directly; user-visible regression (11 tests red) |
| 4 | `refactor_batch` structural outlier check silently no-ops on single-member groups and on dot-qualified symbol names | Medium | none directly; silent correctness loss |
| 5 | `RawFileFacts` payload mixes 0-based (anchors) and 1-based (defs/imports/injections) line numbers | **High** | Priority 0 (off-by-one across the package seam) |

---

## 1. MCP pre-truncates `content` before calling `compressForTool`

### Where
- `packages/zenith-mcp/src/tools/read_file.ts` ~lines 105–117 (the inline truncator then the compression call)
- `packages/zenith-mcp/src/tools/read_multiple_files.ts` ~lines 137–151 (same pattern, per file)

### Issue
The current order is:

```ts
if (content.length > maxChars) {
    let cutoff = content.lastIndexOf('\n', maxChars);
    if (cutoff === -1) cutoff = maxChars;
    content = content.slice(0, cutoff);
    truncated = true;
}
if (args.compression) {
    const compressed = await compressForTool(validPath, content, maxChars);
    if (compressed !== null) content = compressed;
}
```

MCP chops the file to `maxChars` *before* TOON sees it. Two failure modes:

- **Priority 0 line-truth break.** Facts (defs/anchors/imports/injections) were extracted from the *whole* file via the symbol index. The `source` TOON receives is only the head. Any fact referencing a line beyond `cutoff` is now dangling — `lines[anchor.line]` is undefined. TOON's Phase-H assertion (line existence + ascending + valid markers) can fail simply because MCP truncated underneath it.
- **Priority 0.5 leak.** Truncation *is* a compression decision. By the time TOON is asked to "compress to ~70%", MCP has already thrown away the 30% TOON might have wanted to keep. TOON has no slack to make a real structural choice; it's compressing an already-mutilated head.

The truncator was correct when `compressForTool` did not exist — it has not been re-ordered for the new seam.

### Recommended fix
Send full raw text and raw `maxChars` to TOON. Truncate only as the fallback path when compression is off or TOON returns `null`. Tightest version:

```ts
if (args.compression) {
    const compressed = await compressForTool(validPath, rawContent, maxChars);
    if (compressed !== null) {
        content = compressed;
    } else {
        // Fallback: TOON declined (e.g. file under budget, language unsupported).
        // Only now does MCP do its dumb byte truncation.
        if (rawContent.length > maxChars) {
            let cutoff = rawContent.lastIndexOf('\n', maxChars);
            if (cutoff === -1) cutoff = maxChars;
            content = rawContent.slice(0, cutoff);
            truncated = true;
        } else {
            content = rawContent;
        }
    }
} else {
    // No compression requested → same fallback as above.
    ...
}
```

### Related: double-numbering
TOON now mandates `N. ` on every line (constraints §5). If `read_file`/`read_multiple_files` also applies `showLineNumbers` to the result of `compressForTool`, the output becomes `1. 1. content`. The compressed return must bypass any MCP-side line-number prefixing. Audit: confirm the `showLineNumbers` branch is short-circuited when `compressed !== null` (or, equivalently, when the string came from TOON at all).

---

## 2. `read_multiple_files` final budget slice can chop TOON output

### Where
- `packages/zenith-mcp/src/tools/read_multiple_files.ts` — the post-loop concatenation + total-budget cut.

### Issue
After per-file `compressForTool` returns compressed text and MCP concatenates with label headers, a final total-budget step can slice the joined string mid-line or mid-`[TRUNCATED: lines X-Y]` marker. Either outcome is a hard Priority 0 violation:

- A half-printed verbatim line is no longer verbatim — model edits keyed on that line will fail.
- A half-printed marker (e.g. `[TRUNCATED: lines 14-`) is no longer parseable as the discontinuity signal — model loses the position guarantee.

### Recommended fix
The final budget step must be line-aware *and* marker-aware, or it must operate at file granularity (drop entire files, never byte-cut a file's content). Cleanest:

- Track byte boundaries of each per-file block during concatenation.
- If total > budget, drop whole trailing per-file blocks until under budget; never byte-slice within a block.
- If even one file alone exceeds the per-file budget after TOON, that's TOON's problem to refuse (return `null`) — MCP must not "trim" a returned compressed string.

---

## 3. Small files over-truncated by per-entry overhead

### Where
- `packages/zenith-mcp/src/tools/read_multiple_files.ts` — `effectiveBudget` computation.

### Issue
`effectiveBudget = perFileBudget − labelOverhead`. For tiny files (or many-file batches), this goes negative or near-zero, and the entry produces `- file.txt\n\n[truncated]` with zero actual file content. This is the cause of **11 of the pre-existing test failures** in `read-multiple-files*.test.js` — they fail identically on main and on PR 23.

This is documented in the PR 23 description as pre-existing and not fixed.

### Recommended fix
Floor `effectiveBudget` so it cannot zero-out file content for files that would otherwise fit:

```ts
const naturalSize = content.length;
const minFloor = Math.min(naturalSize, labelOverhead + 200);
const effectiveBudget = Math.max(perFileBudget - labelOverhead, minFloor);
```

Or simpler: skip budget enforcement entirely for any single file under, say, 4 KB — they cost nothing to include whole and trying to budget-trim them is what produces the empty `[truncated]` output. Either approach unblocks the 11 failing tests.

---

## 4. `refactor_batch` structural outlier check silently disappears

### Where
- `packages/zenith-mcp/src/tools/refactor_batch.ts:471` (`loadDiff` handler)
- `packages/zenith-mcp/src/tools/refactor_batch.ts:980` (`reapply` handler)

```ts
const dbStructs = findSymbolStructuresByName(db, symName);
const structs = group.map(occ => {
    const match = dbStructs.find(s => s.file_path === occ.relPath && s.line === occ.line);
    if (!match) return null;
    return { params: match.params, returnKind: match.returnText, ... };
});
```

### Two sub-bugs

**4a. Single-member groups.** When `group.length === 1`, the modal/outlier comparison (`findModal` / `firstDiffReason`) has nothing to compare against and quietly returns "no outlier". The structural gate becomes a no-op. The edit proceeds with no warning. For a multi-site refactor that's expected; for a single-site "structural similarity" gate that's a silent loss of protection.

**4b. Dot-qualified symbol names.** `findSymbolStructuresByName(db, symName)` does `WHERE s.name = ?`. PR 23's `extract.ts:53` stores `nameCapture.node.text` — for most tree-sitter grammars this is the *short* name (`bar`), not the qualified name (`Foo.bar`). So a `symName` of `"AuthService.login"` returns zero rows, every `structs[i]` is `null`, and the outlier check silently passes. Resolver code in `indexing/resolve.ts:47–55` already implements the correct strict dot-qualified lookup — it is not reused here.

### Recommended fix

For 4b, factor the resolve.ts dot-qualified lookup into a shared helper and call it from `findSymbolStructuresByName` callers:

```ts
async function lookupStructures(db, symName) {
    const direct = findSymbolStructuresByName(db, symName);
    if (direct.length > 0) return direct;
    const dotIdx = symName.lastIndexOf('.');
    if (dotIdx <= 0) return [];
    const qualifier = symName.slice(0, dotIdx);
    const shortName = symName.slice(dotIdx + 1);
    const candidates = findSymbolStructuresByName(db, shortName);
    return candidates.filter(c => /* parent.name === qualifier check via findSymbolParent */);
}
```

For 4a, make the no-outlier-possible case explicit: when `group.length < 2`, emit a one-line `loadDiff` hint ("single-occurrence symbol; structural similarity gate skipped") rather than silently no-opping. Don't change the gate behavior — just stop hiding that it didn't run.

---

## 5. `RawFileFacts` mixes 0-based (anchors) and 1-based (defs/imports/injections) line numbers

### Where
- `packages/zenith-mcp/src/core/tree-sitter/anchors.ts` — `AnchorEntry.line: node.startPosition.row` (**0-based**)
- `packages/zenith-mcp/src/core/indexing/extract.ts` Step 1 — `SymbolRow.line: row + 1` (**1-based**) for defs
- `packages/zenith-mcp/src/core/tree-sitter/injections.ts` — `startLine: row + 1` (**1-based**)
- `packages/zenith-mcp/src/core/indexing/types.ts:30` — `AnchorRow.line` documented as "0-based line index"
- `packages/zenith-mcp/src/core/db-adapter.ts::getFileFacts` — passes both through unchanged
- `packages/zenith-mcp/src/core/compression.ts:60` — hands both to TOON in the same `RawFileFacts` payload

### Issue
TOON receives `RawFileFacts` with `defs[i].line` 1-based, `imports[i].line` 1-based, `injections[i].startLine` 1-based, and `anchors[i].line` 0-based. Same field name on related arrays, different conventions. TOON cannot tell the difference at the data layer — it must apply one rule and will be wrong about whichever convention doesn't match.

Off-by-one means TOON resolves the anchor for `return` on file-line 42 to file-line 41 and keeps the line *before* the actual return. This propagates everywhere TOON uses anchors for selection priority — the line-truth invariant holds (the wrong line is shown verbatim at its real number), but the *selection* is structurally wrong by exactly one line.

The previous internal contract (anchors as StructureBlock 0-based indices) was correct *for the old in-MCP StructureBlock construction path*. PR 23 moved structure construction into TOON and changed the contract to `RawFileFacts`, but the anchor extractor was not converted to the new convention.

### Recommended fix
Make anchors 1-based at the extractor boundary so the entire `RawFileFacts` payload is uniformly 1-based:

```ts
// packages/zenith-mcp/src/core/tree-sitter/anchors.ts
anchors.push({
    line: node.startPosition.row + 1,        // was: node.startPosition.row
    endLine: node.endPosition.row + 1,       // was: node.endPosition.row
    kind: rule.kind,
    priority: rule.priority,
});
```

And update the matching comment in `types.ts:33` and `extract.ts:135` (the `lines[a.line]!.slice(0, 80)` text-snippet read uses `a.line` directly — that will need `lines[a.line - 1]!` after the conversion).

This is a one-line semantic fix plus two pointer-arithmetic edits in the consumers. After it, the entire `RawFileFacts` payload follows a single 1-based convention end-to-end, no per-field rule needed.

---

## Combined acceptance criteria for the seam

If all five fixes land, the MCP↔TOON seam holds these invariants (worth pinning as a comment block in `compression.ts`):

1. MCP passes TOON the **full** raw file text. MCP never pre-truncates inputs to compression.
2. MCP places TOON's returned string **untouched** in the tool response. No byte slicing, no re-prefixing, no re-truncation.
3. `read_multiple_files` aggregates at file granularity. Whole files may be dropped to fit a total budget; individual returned strings are never byte-cut.
4. `RawFileFacts` line numbers are **uniformly 1-based**.
5. Symbol lookups for refactor structural gates resolve dot-qualified names through the same strict policy as the edge resolver (`findSymbolByNameUnique` + `findSymbolParent`).

These are the five conditions under which the constraints doc's Priority 0 and Priority 0.5 hold *across the package seam*, not just inside TOON.
