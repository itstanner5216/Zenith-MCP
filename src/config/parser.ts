/**
 * Parser and serializer for Zenith's custom plain-text config format.
 *
 * The format supports:
 *   - `## Section`  / `### Subsection` headers
 *   - `# comment` lines (single `#`, not `##` or `###`)
 *   - `key: value` pairs (split on first `: `)
 *   - Inline comments (` # ...` at end of a value)
 *   - Special values: `enabled` -> true, `disabled` -> false, numeric strings -> number
 *   - Blank lines for readability
 *
 * Everything — including unknown sections and keys — is preserved on round-trip.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SectionEntry {
  type: "section";
  name: string;
  /** The raw line exactly as it appeared (e.g. `## Tools`). */
  raw: string;
}

export interface SubsectionEntry {
  type: "subsection";
  name: string;
  raw: string;
}

export interface CommentEntry {
  type: "comment";
  /** The full comment line including the leading `#`. */
  text: string;
}

export interface BlankEntry {
  type: "blank";
}

export interface KVEntry {
  type: "kv";
  key: string;
  /** Parsed value: boolean for enabled/disabled, number for numerics, string otherwise. */
  value: boolean | number | string;
  /** The raw value string before type coercion (without inline comment). */
  rawValue: string;
  /** Inline comment text (without the leading ` # `), or null if none. */
  inlineComment: string | null;
}

export type ConfigEntry =
  | SectionEntry
  | SubsectionEntry
  | CommentEntry
  | BlankEntry
  | KVEntry;

/**
 * Ordered list of config entries that fully describes the file.
 * Using an array (not a map) preserves original ordering and allows
 * lossless round-tripping.
 */
export type RawConfig = ConfigEntry[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a trimmed string value into the appropriate JS type.
 *   - `"enabled"`  -> `true`
 *   - `"disabled"` -> `false`
 *   - Numeric strings (integer or float, including negatives) -> `number`
 *   - Everything else stays a `string`
 */
function coerceValue(raw: string): boolean | number | string {
  if (raw === "enabled") return true;
  if (raw === "disabled") return false;

  // Match integers, floats, negative numbers.  Reject empty strings and
  // strings that are purely whitespace so we don't accidentally coerce them.
  if (raw.length > 0 && /^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }

  return raw;
}

/**
 * Reverse of `coerceValue`: turn a parsed value back into the raw string
 * form that the config file uses.
 */
function uncoerceValue(value: boolean | number | string): string {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return String(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse Zenith's plain-text config format into an ordered array of entries.
 *
 * Every line is categorised and stored so that `serializeConfig(parseConfig(text))`
 * reproduces the original text byte-for-byte.
 */
export function parseConfig(text: string): RawConfig {
  const lines = text.split("\n");
  const entries: RawConfig = [];

  for (const line of lines) {
    // --- Subsection header (must be checked before section) ----------------
    if (line.startsWith("### ")) {
      entries.push({
        type: "subsection",
        name: line.slice(4).trim(),
        raw: line,
      });
      continue;
    }

    // --- Section header ----------------------------------------------------
    if (line.startsWith("## ")) {
      entries.push({
        type: "section",
        name: line.slice(3).trim(),
        raw: line,
      });
      continue;
    }

    // --- Comment (single `#`, but not `##` or `###`) -----------------------
    if (line.startsWith("#")) {
      entries.push({ type: "comment", text: line });
      continue;
    }

    // --- Blank line --------------------------------------------------------
    if (line.trim() === "") {
      entries.push({ type: "blank" });
      continue;
    }

    // --- Key-value pair ----------------------------------------------------
    const kvSep = line.indexOf(": ");
    if (kvSep !== -1) {
      const key = line.slice(0, kvSep);
      let rest = line.slice(kvSep + 2); // everything after first `: `

      // Detect inline comment: ` # ` (space-hash-space) in the value.
      // Requires the space after the hash so that values containing ` #`
      // without a trailing space (e.g. file paths like `/opt/my #project`)
      // are not incorrectly truncated.  The serializer always writes
      // ` # comment`, so the round-trip is preserved.
      let inlineComment: string | null = null;
      const commentIdx = rest.indexOf(" # ");
      if (commentIdx !== -1) {
        inlineComment = rest.slice(commentIdx + 3);
        rest = rest.slice(0, commentIdx);
      }

      const rawValue = rest;
      const value = coerceValue(rawValue);

      entries.push({ type: "kv", key, value, rawValue, inlineComment });
      continue;
    }

    // --- Fallback: treat anything else as a comment to avoid data loss -----
    entries.push({ type: "comment", text: line });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Reconstruct the plain-text config from a structured `RawConfig`.
 */
export function serializeConfig(config: RawConfig): string {
  const lines: string[] = [];

  for (const entry of config) {
    switch (entry.type) {
      case "section":
        lines.push(entry.raw ?? `## ${entry.name}`);
        break;

      case "subsection":
        lines.push(entry.raw ?? `### ${entry.name}`);
        break;

      case "comment":
        lines.push(entry.text);
        break;

      case "blank":
        lines.push("");
        break;

      case "kv": {
        // Prefer the raw value when it exists so round-tripping is lossless.
        // Fall back to uncoercing the parsed value for entries created in code.
        const valStr = entry.rawValue !== undefined
          ? entry.rawValue
          : uncoerceValue(entry.value);

        let line = `${entry.key}: ${valStr}`;
        if (entry.inlineComment != null) {
          line += ` # ${entry.inlineComment}`;
        }
        lines.push(line);
        break;
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline self-test (only runs when this file is executed directly)
// ---------------------------------------------------------------------------

const isDirectRun =
  typeof process !== "undefined" &&
  typeof import.meta?.url === "string" &&
  (
    // Node >= 20.11 exposes process.argv[1] as file URL sometimes
    import.meta.url === `file://${process.argv[1]}` ||
    // More common: process.argv[1] is an absolute path
    import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    // tsx / ts-node may use the .ts path directly
    process.argv[1]?.endsWith("config/parser.ts")
  );

if (isDirectRun) {
  const SAMPLE = [
    "# Zenith MCP Configuration",
    "Port: 7000 # default port",
    "max_tokens: 400000",
    "",
    "## General",
    "name: My Zenith Instance",
    "log_level: debug",
    "",
    "## Retrieval",
    "strategy: hybrid",
    "top_k: 10",
    "",
    "### Advanced",
    "use_cache: enabled",
    "experimental_flag: disabled",
    "",
    "## Tools",
    "read_file: enabled",
    "search_file: disabled",
    "edit_file: enabled",
    "",
    "## UnknownFutureSection",
    "mystery_key: some future value",
    "another_future_key: 42",
    "",
    "# End of config",
  ].join("\n");

  const parsed = parseConfig(SAMPLE);
  const serialized = serializeConfig(parsed);
  const reparsed = parseConfig(serialized);
  const reserialized = serializeConfig(reparsed);

  // Round-trip check: text must be identical.
  if (serialized !== SAMPLE) {
    console.error("FAIL: first serialization differs from original input.");
    console.error("--- EXPECTED ---");
    console.error(SAMPLE);
    console.error("--- GOT ---");
    console.error(serialized);
    process.exit(1);
  }

  if (reserialized !== serialized) {
    console.error("FAIL: second round-trip serialization differs.");
    process.exit(1);
  }

  // Deep equality of parsed structures.
  if (JSON.stringify(parsed) !== JSON.stringify(reparsed)) {
    console.error("FAIL: parsed structures differ after round-trip.");
    process.exit(1);
  }

  // Spot-check coerced values.
  const kvs = parsed.filter((e): e is KVEntry => e.type === "kv");

  const port = kvs.find(e => e.key === "Port");
  console.assert(port?.value === 7000, "Port should be number 7000");
  console.assert(port?.inlineComment === "default port", "Port inline comment");

  const maxTokens = kvs.find(e => e.key === "max_tokens");
  console.assert(maxTokens?.value === 400000, "max_tokens should be number 400000");

  const name = kvs.find(e => e.key === "name");
  console.assert(name?.value === "My Zenith Instance", "name should be string");

  const useCache = kvs.find(e => e.key === "use_cache");
  console.assert(useCache?.value === true, "use_cache should be boolean true");

  const expFlag = kvs.find(e => e.key === "experimental_flag");
  console.assert(expFlag?.value === false, "experimental_flag should be boolean false");

  const readFile = kvs.find(e => e.key === "read_file");
  console.assert(readFile?.value === true, "read_file should be boolean true");

  const searchFile = kvs.find(e => e.key === "search_file");
  console.assert(searchFile?.value === false, "search_file should be boolean false");

  const mystery = kvs.find(e => e.key === "mystery_key");
  console.assert(mystery?.value === "some future value", "unknown key preserved as string");

  const anotherFuture = kvs.find(e => e.key === "another_future_key");
  console.assert(anotherFuture?.value === 42, "unknown numeric key preserved as number");

  // Verify section/subsection preservation.
  const sections = parsed.filter((e): e is SectionEntry => e.type === "section");
  const subsections = parsed.filter((e): e is SubsectionEntry => e.type === "subsection");
  console.assert(sections.length === 4, `Expected 4 sections, got ${sections.length}`);
  console.assert(subsections.length === 1, `Expected 1 subsection, got ${subsections.length}`);
  console.assert(
    sections.map(s => s.name).join(", ") === "General, Retrieval, Tools, UnknownFutureSection",
    "Section names preserved in order",
  );

  // Verify comments and blanks are preserved.
  const comments = parsed.filter((e): e is CommentEntry => e.type === "comment");
  const blanks = parsed.filter(e => e.type === "blank");
  console.assert(comments.length === 2, `Expected 2 comments, got ${comments.length}`);
  console.assert(blanks.length === 6, `Expected 6 blank lines, got ${blanks.length}`);

  // Verify that ` #` without trailing space is NOT treated as inline comment.
  // This protects path values like `/opt/my #project/file` from truncation.
  const hashInValue = parseConfig("path_key: /opt/my #project/file");
  const hashKv = hashInValue.find((e): e is KVEntry => e.type === "kv" && e.key === "path_key");
  console.assert(
    hashKv?.value === "/opt/my #project/file",
    `Space-hash without trailing space should be part of value, got: "${hashKv?.value}"`,
  );
  console.assert(
    hashKv?.inlineComment === null,
    `Should have no inline comment, got: "${hashKv?.inlineComment}"`,
  );

  // Verify that ` # ` WITH trailing space IS still detected as inline comment.
  const hashComment = parseConfig("port_key: 7000 # my comment");
  const commentKv = hashComment.find((e): e is KVEntry => e.type === "kv" && e.key === "port_key");
  console.assert(
    commentKv?.value === 7000,
    `Value should be 7000, got: "${commentKv?.value}"`,
  );
  console.assert(
    commentKv?.inlineComment === "my comment",
    `Comment should be 'my comment', got: "${commentKv?.inlineComment}"`,
  );

  console.log("All parser self-tests passed.");
}
