# Tool Schema & Response Refactor — Subagent Prompt

You are refactoring a single MCP tool file in `/home/tanner/Projects/Zenith-MCP/dist/tools/`.

## What to do

### 1. Schema — Use `z.discriminatedUnion` for multi-mode tools

If the tool has multiple mutually exclusive modes (detected by params that only make sense together), convert the `inputSchema` from a flat `z.object` with all optional params to a `z.discriminatedUnion("mode", [...])` where each branch is a `z.object` containing ONLY the params for that mode.

Add a `mode` field with `z.literal("modeName")` as the discriminator in each branch.

Shared params that apply to ALL modes (like `path`) go in every branch — do NOT use `.and()` or intersection types, they don't serialize properly. Just repeat the shared param in each branch object.

**Example — before:**
```js
inputSchema: {
    path: z.string(),
    contentQuery: z.string().optional().describe("Text to search"),
    symbolQuery: z.string().optional().describe("Search symbols"),
    listSymbols: z.boolean().optional().describe("List all symbols"),
    contextLines: z.number().optional().describe("Context lines for content search"),
}
```

**Example — after:**
```js
inputSchema: z.discriminatedUnion("mode", [
    z.object({
        mode: z.literal("content").describe("Search file contents by text or regex."),
        path: z.string(),
        contentQuery: z.string().describe("Text or regex to search."),
        contextLines: z.number().optional().default(0).describe("Context lines around matches."),
    }),
    z.object({
        mode: z.literal("symbols").describe("Search or list symbols."),
        path: z.string(),
        symbolQuery: z.string().optional().describe("Symbol name to search."),
        listSymbols: z.boolean().optional().default(false).describe("List all symbols."),
    }),
])
```

**If the tool is simple with no mutually exclusive modes** (like `create_directory`, `delete_file`, `move_file`, `write_file`, `get_file_info`, `read_media_file`, `read_multiple_files`), leave the schema as a flat `z.object`. Do NOT force branching where it doesn't exist. Just clean up descriptions per the rules below.

### 2. Handler — Dispatch on `edit.mode` or `args.mode`

After converting the schema, update the handler to check `args.mode` (or `edit.mode` for edit arrays) instead of sniffing for the presence of params like `if (args.contentQuery)`.

### 3. Descriptions — Minimal and direct

- Describe what the param DOES, not how it works internally.
- No backend implementation details (no mention of SQLite, ripgrep, tree-sitter, caching mechanisms, etc.).
- No "If true, ..." phrasing when avoidable — just say what it does: `"Append instead of overwrite."` not `"If true, appends content to the end of an existing file. Creates the file if it doesn't exist."`.
- Tool-level description: one short sentence. What does calling this tool do?
- Keep `.default()` values. Keep `.optional()` where appropriate.

### 4. Responses — No decoration, no parroting

Search the entire file for response strings returned to the model. Fix these:

- **No path parroting.** Never echo back the path the model just sent. The model knows what path it provided. Exception: `list`, `read`, or browse modes where the model is discovering entries it didn't create.
- **No `JSON.stringify` dumps.** Format responses as plain text. If returning a diff, return the diff string directly. If returning a count, return `"1284 bytes"` not `{"dryRun":true,"path":"/foo","bytes":1284}`.
- **No fancy separators** in response strings: no `---`, `===`, `###`, `## heading ##`, `---separator---`, etc. Just plain text with newlines.
- **No markdown formatting** in responses: no `**bold**`, no `# headers`, no `- bullet lists`. Plain text only.
- Code comments inside the file (like `// ---- MODE NAME ----`) are fine to keep — those aren't sent to the model.

### 5. Schema ordering

Present the most commonly used mode FIRST in the discriminatedUnion array. For search tools, content search is most common. For read tools, standard read is most common.

### 6. Do NOT change

- Business logic, algorithms, or how the tool actually works.
- Import statements (unless removing an unused one).
- Error handling logic.
- File paths or function names.
- The tool's registered name (e.g., `"read_text_file"`, `"search_files"`).

## Files to refactor

Each subagent gets ONE file. Here's the list:

- `read_text_file.js` — Has modes: grep, symbol, aroundLine/ranges (window), head/tail/offset (standard read). Candidates for branching.
- `search_files.js` — Has modes: content search, file glob, symbol query, symbol list, structural similarity. Candidates for branching.
- `find_files.js` — Has modes: file find (glob/path/extension) vs symbol definition search. Candidate for branching.
- `directory_tree.js` — Flat, no branching needed. Clean descriptions and responses only.
- `list_directory.js` — Flat, no branching needed. Clean descriptions and responses only.
- `read_multiple_files.js` — Flat, no branching needed. Clean descriptions and responses only.
- `write_file.js` — Flat, no branching needed. Clean descriptions and responses only.
- `create_directory.js` — Flat, trivial. Clean descriptions and responses only.
- `delete_file.js` — Flat, trivial. Clean descriptions and responses only.
- `move_file.js` — Flat, trivial. Clean descriptions and responses only.
- `get_file_info.js` — Flat, trivial. Clean descriptions and responses only.
- `read_media_file.js` — Flat, trivial. Clean descriptions and responses only.

**Do NOT touch:** `edit_file.js`, `stash_restore.js`, `_parked_batch_analysis.js` — these are already done.

## Validation

After making changes, run: `node -c dist/tools/YOUR_FILE.js`

This checks syntax. If it fails, fix it before finishing.
