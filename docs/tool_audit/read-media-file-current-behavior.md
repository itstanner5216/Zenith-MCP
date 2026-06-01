# `read_media_file` — Current Implementation Breakdown

> **Purpose:** Reference document for understanding the complete behavior of the `read_media_file` tool.
> Documents what the tool currently does in exhaustive detail so the intended behavior can be redesigned from an accurate baseline.

---

## Tool: `read_media_file`

**Source:** `packages/zenith-mcp/src/tools/read_media_file.ts`

**Registration name:** `"read_media_file"` (in `TOOL_REGISTRY` at `core/server.ts` line 90)

**Title:** `"Read Media File"`

**Description (as registered):** `"Read an image or audio file. Returns base64 data and MIME type."`

**Annotations:**
```
readOnlyHint: true
idempotentHint: not set (absent — defaults to server/SDK default)
destructiveHint: not set (absent — defaults to server/SDK default)
```

**Schema:**
```
path: string (required) — path to the media file
```

That is the entire schema. There is one field. No optional parameters, no modes, no enums, no defaults, no constraints beyond Zod `z.string()`.

---

## Process (step by step)

1. **Path validation** — calls `ctx.validatePath(args.path)`
   - Expands `~` via `expandHome()`
   - Resolves to absolute path (relative paths resolved against `process.cwd()`)
   - Normalizes the path (null-byte check, quote stripping, slash normalization via `normalizePath()`)
   - Resolves symlinks via `fs.realpath()`
   - Re-normalizes the resolved path
   - If the path doesn't exist (`ENOENT`): tries to resolve the parent directory; if the parent also doesn't exist, throws `"Parent directory does not exist: <parentDir>"`
   - **Note:** Zenith's `validatePath()` does NOT enforce an allowed-directory sandbox. The comment in the source explicitly states: *"Zenith is intentionally not a sandbox. MCP roots / CLI directories are kept as project-context hints only; they must never block filesystem access."* It only resolves and normalizes.

2. **Extension extraction** — `path.extname(validPath).toLowerCase()`
   - Extracts the file extension from the validated (resolved) path
   - Lowercases it for lookup

3. **MIME type resolution** — looks up the lowercase extension in the hardcoded `MIME_TYPES` map
   - If found: uses the mapped MIME type
   - If NOT found: falls back to `"application/octet-stream"`

4. **File read** — calls `readFileAsBase64Stream(validPath)` from `core/shared.ts`
   - Creates a Node.js `createReadStream()` on the file
   - Collects all `data` chunks into a `Buffer[]` array
   - On each chunk: if the chunk is already a `Buffer`, uses it directly; if it's a string, wraps it with `Buffer.from(chunk)`
   - On `end`: concatenates all buffers via `Buffer.concat()` and converts to base64 via `.toString('base64')`
   - On `error`: rejects the promise (error propagates to the tool handler as-is)
   - **No size limit** — reads the entire file into memory regardless of size
   - **No timeout** — the read stream has no explicit timeout

5. **Type coercion safety** — `const data = typeof rawData === 'string' ? rawData : String(rawData)`
   - The Promise in `readFileAsBase64Stream` resolves with `resolve(...)` without a type annotation (typed as `Promise<unknown>` at runtime)
   - This guard ensures `data` is always a string, even if the promise somehow resolves with a non-string value
   - In practice, `Buffer.concat(...).toString('base64')` always returns a string, so `String(rawData)` is never exercised

6. **Content type classification** — determines the MCP content `type` field:
   - If `mimeType` starts with `"image/"` → `type = "image"`
   - Else if `mimeType` starts with `"audio/"` → `type = "audio"`
   - Else → `type = "blob"`
   - This is a ternary chain, not a map lookup

7. **Response construction** — returns:
   ```json
   {
     "content": [
       {
         "type": "image" | "audio" | "blob",
         "data": "<base64-encoded file contents>",
         "mimeType": "<resolved MIME type>"
       }
     ]
   }
   ```
   - The `content` array always has exactly one element
   - The content item type is `ToolImageContent`, `ToolAudioContent`, or `ToolBlobContent` from `tools/types.ts`

---

## Supported MIME Types

| Extension | MIME Type | Content Type |
|-----------|-----------|-------------|
| `.png` | `image/png` | `"image"` |
| `.jpg` | `image/jpeg` | `"image"` |
| `.jpeg` | `image/jpeg` | `"image"` |
| `.gif` | `image/gif` | `"image"` |
| `.webp` | `image/webp` | `"image"` |
| `.bmp` | `image/bmp` | `"image"` |
| `.svg` | `image/svg+xml` | `"image"` |
| `.mp3` | `audio/mpeg` | `"audio"` |
| `.wav` | `audio/wav` | `"audio"` |
| `.ogg` | `audio/ogg` | `"audio"` |
| `.flac` | `audio/flac` | `"audio"` |

**Total: 11 extensions (7 image, 4 audio)**

Any extension not in the map gets `mimeType = "application/octet-stream"` and `type = "blob"`.

---

## Key Details

- **No file size limit or guard** — the tool reads the entire file into memory as a single base64 string. A 1GB video file would be read, base64-encoded (increasing size by ~33%), and returned in full. There is no size check, no streaming output, no truncation, no budget awareness.

- **No file-type validation** — the tool does not verify that the file is actually a media file. It reads any file that passes path validation. A `.txt` file renamed to `.png` would be read and returned as `image/png`. A file with an unrecognized extension (e.g., `.mp4`, `.pdf`, `.zip`) would be read and returned as `application/octet-stream` with `type = "blob"`.

- **No sensitive file filtering** — unlike search tools, `read_media_file` does not call `isSensitive()`. A file at `.env.png` or `secret.wav` would be read without any sensitive-pattern check.

- **SVG is treated as image** — SVG files (`image/svg+xml`) are base64-encoded despite being XML text. The tool does not offer a text-mode fallback for SVG.

- **No video support** — despite the tool description mentioning "media", no video MIME types are in the map. Common video extensions (`.mp4`, `.avi`, `.mov`, `.mkv`, `.webm`) are not mapped and would fall through to `application/octet-stream` / `"blob"`.

- **readFileAsBase64Stream is streaming in name only** — while it uses `createReadStream()`, it collects all chunks into memory before concatenating and encoding. It does not stream base64 output. The "stream" in the name refers to the input read mechanism, not the output.

- **The tool does not use `getCharBudget()` or any budget system** — output size is uncapped and not subject to the char budget that constrains other tools like `read_file`, `search_files`, etc.

- **Error handling is minimal** — any filesystem error from the read stream (permission denied, file not found after validation, I/O error) surfaces as an unhandled promise rejection from `readFileAsBase64Stream`. The tool handler has no try/catch around the read call; errors propagate to the MCP framework's error handler.

- **The source file has a trailing source map comment** — line 43 contains `//# sourceMappingURL=read_media_file.js.map`, which is a build artifact that was committed to the TypeScript source file.

---

## Params That Don't Do What They Suggest

1. **`path`** — the description says "Read an image or audio file" but `path` accepts any file path. There is no validation that the file is actually an image or audio file. Any file will be read and returned, with unrecognized extensions getting the `application/octet-stream` fallback.

---

## Comparison with `read_file`

| Aspect | `read_media_file` | `read_file` |
|--------|-------------------|-------------|
| Input type | Any file (no guard) | Text files |
| Output format | Base64-encoded binary in `data` field | UTF-8 text in `text` field |
| Size limit | None | `maxChars` (default 50K, max ~400K) |
| Budget awareness | None | Uses `getCharBudget()` |
| Compression support | None | Optional TOON compression |
| Windowing | None | `head`, `tail`, `offset`, `aroundLine`, `ranges` |
| Sensitive file check | None | None (validated path only) |
| Line numbers | N/A | Optional `showLineNumbers` |
| Content type returned | `image`, `audio`, or `blob` | `text` |

---

## Known Issues / Smells

1. **No file size guard** — the tool will attempt to read arbitrarily large files into memory, base64-encode them (1.33× size expansion), and return the entire encoded payload. This can trivially cause OOM conditions or exceed MCP transport limits for large media files.

2. **Missing video MIME types** — the tool description says "media file" but only maps image and audio extensions. Common video types (`.mp4`, `.webm`, `.mov`, `.avi`) silently fall through to `application/octet-stream` / `"blob"`. The MCP `ToolContent` type union in `types.ts` also has no `video` variant — only `text`, `image`, `audio`, and `blob`.

3. **No content validation** — the tool trusts the file extension entirely. It does not inspect file magic bytes or headers. A corrupted file, a mislabeled file, or a non-media file with a media extension will be returned with a media MIME type, potentially causing downstream failures in clients that attempt to decode the data.

4. **readFileAsBase64Stream's Promise is untyped** — the function returns `Promise<unknown>` (the `new Promise((resolve, reject) => ...)` constructor without a type parameter). The tool handler compensates with a `typeof rawData === 'string'` guard, but this is a type-safety smell.

5. **SVG base64 encoding is wasteful** — SVG files are XML text and could be returned as text content, which would be more useful to LLM callers and significantly smaller than base64 encoding. Instead, they are treated identically to raster images.

6. **Trailing sourcemap comment in TypeScript source** — line 43 (`//# sourceMappingURL=read_media_file.js.map`) is a JavaScript build artifact that appears in the TypeScript source file. This suggests the source file may have been copied from or confused with its compiled output at some point.

7. **No sensitive file filtering** — other read/search tools apply `isSensitive()` checks. `read_media_file` does not, creating an inconsistency in the security posture. While most sensitive patterns target text-based credential files, a caller could use this tool to read any binary file in the allowed directories without sensitive-pattern filtering.

8. **The MIME fallback `"application/octet-stream"` produces `type: "blob"`** — MCP clients may not know how to handle `blob` content items. The tool silently succeeds with an opaque blob rather than failing fast when it encounters an unsupported file type.

9. **No `idempotentHint` or `destructiveHint` annotation** — the tool sets `readOnlyHint: true` but does not explicitly set the other two annotation fields. While the omission is semantically fine (read-only implies non-destructive), the other tools in the registry are also inconsistent about which annotations they set.
