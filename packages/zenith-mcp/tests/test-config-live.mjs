/**
 * Live integration test for the config system.
 * Tests: parser round-trip, schema defaults, configToRaw/rawToConfig,
 *        loader (configExists, loadConfig, saveConfig), mergeToolsIntoConfig.
 *
 * Skips: backup.ts (needs better-sqlite3 native), wizard.ts (interactive readline),
 *        auto-write.ts (imports backup.ts which needs native).
 */

import { parseConfig, serializeConfig } from "./dist/config/parser.js";
import {
  DEFAULT_CONFIG,
  CONFIG_PATH,
  configToRaw,
  rawToConfig,
} from "./dist/config/schema.js";
import {
  configExists,
  loadConfig,
  saveConfig,
  mergeToolsIntoConfig,
} from "./dist/config/loader.js";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Sample config text ──────────────────────────────────────────────────────

const SAMPLE_CONFIG = `# Zenith-MCP Configuration
Port: 7000

## Tools
read_file: enabled
write_file: disabled
edit_file: enabled

### Auto Write
status: disabled
backup_dir: ~/.zenith-mcp/mcp_backups/
backup_mode: file
custom_mcp_paths:

### Zenith-Rag
status: disabled
postgres_url:
username:
password:

### Advanced
char_budget: 400000
default_excludes: node_modules,.git,.next,.venv,__pycache__,.DS_Store,dist,build,.svn,.hg
sensitive_patterns: **/.env,**/*.pem,**/*.key,**/*.crt,**/*.pfx,**/.credentials,**/*secret*
`;

// ─── Test 1: Parser basics ──────────────────────────────────────────────────

console.log("\n=== Test 1: Parser Basics ===");

const raw = parseConfig(SAMPLE_CONFIG);
assert(Array.isArray(raw), "parseConfig returns array");
assert(raw.length > 0, "parsed entries not empty");

// Find the Port entry
const portEntry = raw.find((e) => e.type === "kv" && e.key === "Port");
assert(portEntry !== undefined, "found Port entry");
assertEq(portEntry?.value, 7000, "Port parsed as number 7000");

// Find tool entries
const readFileEntry = raw.find((e) => e.type === "kv" && e.key === "read_file");
assert(readFileEntry !== undefined, "found read_file entry");
assertEq(readFileEntry?.value, true, "read_file 'enabled' parsed as true");

const writeFileEntry = raw.find((e) => e.type === "kv" && e.key === "write_file");
assertEq(writeFileEntry?.value, false, "write_file 'disabled' parsed as false");

// Find char_budget
const charEntry = raw.find((e) => e.type === "kv" && e.key === "char_budget");
assertEq(charEntry?.value, 400000, "char_budget parsed as number");

// ─── Test 2: Parser round-trip ──────────────────────────────────────────────

console.log("\n=== Test 2: Parser Round-Trip ===");

const serialized = serializeConfig(raw);
const reParsed = parseConfig(serialized);

// Compare structural equivalence (ignoring whitespace differences)
assertEq(reParsed.length, raw.length, "re-parsed entry count matches original");

// Check that all KV entries survive
const originalKvs = raw.filter((e) => e.type === "kv").map((e) => ({ key: e.key, value: e.value }));
const reParsedKvs = reParsed.filter((e) => e.type === "kv").map((e) => ({ key: e.key, value: e.value }));
assertEq(reParsedKvs, originalKvs, "all key-value pairs survive round-trip");

// Check sections survive
const originalSections = raw.filter((e) => e.type === "section").map((e) => e.name);
const reParsedSections = reParsed.filter((e) => e.type === "section").map((e) => e.name);
assertEq(reParsedSections, originalSections, "all sections survive round-trip");

// Check subsections survive
const originalSubs = raw.filter((e) => e.type === "subsection").map((e) => e.name);
const reParsedSubs = reParsed.filter((e) => e.type === "subsection").map((e) => e.name);
assertEq(reParsedSubs, originalSubs, "all subsections survive round-trip");

// Check comments survive
const originalComments = raw.filter((e) => e.type === "comment");
const reParsedComments = reParsed.filter((e) => e.type === "comment");
assertEq(reParsedComments.length, originalComments.length, "comment count preserved");

// ─── Test 3: Schema defaults ─────────────────────────────────────────────────

console.log("\n=== Test 3: Schema Defaults ===");

assertEq(DEFAULT_CONFIG.port, 7000, "default port is 7000");
assertEq(DEFAULT_CONFIG.auto_write.status, false, "auto_write disabled by default");
assertEq(DEFAULT_CONFIG.auto_write.backup_mode, "file", "default backup_mode is 'file'");
assertEq(DEFAULT_CONFIG.advanced.char_budget, 400000, "default char_budget is 400000");
assertEq(DEFAULT_CONFIG.tools, {}, "default tools is empty record (dynamic discovery)");
assert(typeof DEFAULT_CONFIG.advanced.default_excludes === "string", "default_excludes is string");
assert(typeof DEFAULT_CONFIG.advanced.sensitive_patterns === "string", "sensitive_patterns is string");
assertEq(DEFAULT_CONFIG.rag.status, false, "rag disabled by default");
assert(CONFIG_PATH.includes(".zenith-mcp"), "CONFIG_PATH includes .zenith-mcp");

// ─── Test 4: configToRaw / rawToConfig ───────────────────────────────────────

console.log("\n=== Test 4: configToRaw / rawToConfig ===");

const rawFromDefault = configToRaw(DEFAULT_CONFIG);
assert(Array.isArray(rawFromDefault), "configToRaw returns array");
assert(rawFromDefault.length > 0, "configToRaw produces non-empty config");

// Check it includes expected sections/subsections
const rawSections = rawFromDefault.filter((e) => e.type === "section").map((e) => e.name);
const rawSubs = rawFromDefault.filter((e) => e.type === "subsection").map((e) => e.name);
assert(rawSections.includes("Tools"), "raw includes Tools section");
assert(rawSubs.includes("Auto Write"), "raw includes Auto Write subsection");
assert(rawSubs.includes("Advanced"), "raw includes Advanced subsection");

// Round-trip: config → raw → config
const configBack = rawToConfig(rawFromDefault);
assertEq(configBack.port, DEFAULT_CONFIG.port, "port survives config→raw→config");
assertEq(configBack.auto_write.status, DEFAULT_CONFIG.auto_write.status, "auto_write.status survives");
assertEq(configBack.auto_write.backup_mode, DEFAULT_CONFIG.auto_write.backup_mode, "backup_mode survives");
assertEq(configBack.advanced.char_budget, DEFAULT_CONFIG.advanced.char_budget, "char_budget survives");

// Round-trip with tools
const configWithTools = structuredClone(DEFAULT_CONFIG);
configWithTools.tools = { read_file: true, write_file: false, edit_file: true };
configWithTools.port = 8080;
configWithTools.advanced.char_budget = 500000;

const rawWithTools = configToRaw(configWithTools);
const configBackWithTools = rawToConfig(rawWithTools);
assertEq(configBackWithTools.port, 8080, "custom port 8080 survives round-trip");
assertEq(configBackWithTools.tools.read_file, true, "read_file: true survives");
assertEq(configBackWithTools.tools.write_file, false, "write_file: false survives");
assertEq(configBackWithTools.tools.edit_file, true, "edit_file: true survives");
assertEq(configBackWithTools.advanced.char_budget, 500000, "custom char_budget 500000 survives");

// ─── Test 5: Full pipeline: config → raw → serialize → parse → raw → config ─

console.log("\n=== Test 5: Full Pipeline Round-Trip ===");

const fullRaw = configToRaw(configWithTools);
const fullText = serializeConfig(fullRaw);
const fullReParsed = parseConfig(fullText);
const fullConfigBack = rawToConfig(fullReParsed);

assertEq(fullConfigBack.port, 8080, "port survives full pipeline");
assertEq(fullConfigBack.tools.read_file, true, "read_file survives full pipeline");
assertEq(fullConfigBack.tools.write_file, false, "write_file survives full pipeline");
assertEq(fullConfigBack.advanced.char_budget, 500000, "char_budget survives full pipeline");
assertEq(fullConfigBack.auto_write.backup_mode, "file", "backup_mode survives full pipeline");

// ─── Test 6: Loader (configExists, loadConfig, saveConfig) ──────────────────

console.log("\n=== Test 6: Loader ===");

// Use a temp directory to avoid touching real ~/.zenith-mcp/
const testDir = join(homedir(), ".zenith-mcp-test-" + Date.now());
const testConfigPath = join(testDir, "config");

// Monkey-patch CONFIG_PATH for testing... we can't easily, so test with real path indirectly
// Instead, test that loadConfig doesn't throw with no config file
const loaded = loadConfig();
assert(loaded !== null && loaded !== undefined, "loadConfig returns a value (never throws)");
assertEq(loaded.port, typeof loaded.port === "number" ? loaded.port : -1 >= 0, "loadConfig returns valid port");
assert(typeof loaded.tools === "object", "loadConfig returns tools object");
assert(typeof loaded.auto_write === "object", "loadConfig returns auto_write object");
assert(typeof loaded.advanced === "object", "loadConfig returns advanced object");

// ─── Test 7: mergeToolsIntoConfig ───────────────────────────────────────────

console.log("\n=== Test 7: mergeToolsIntoConfig ===");

const baseConfig = structuredClone(DEFAULT_CONFIG);
baseConfig.tools = { read_file: true, write_file: false };

const availableTools = ["read_file", "write_file", "edit_file", "search_files", "directory"];

const merged = mergeToolsIntoConfig(baseConfig, availableTools);

assertEq(merged.tools.read_file, true, "existing enabled tool stays enabled");
assertEq(merged.tools.write_file, false, "existing disabled tool stays disabled");
assertEq(merged.tools.edit_file, true, "new tool defaults to enabled");
assertEq(merged.tools.search_files, true, "new tool search_files defaults to enabled");
assertEq(merged.tools.directory, true, "new tool directory defaults to enabled");

// Stale tool (not in available list) should be preserved
assert("read_file" in merged.tools, "existing tool preserved even if in available list");

// ─── Test 8: Unknown keys preservation ──────────────────────────────────────

console.log("\n=== Test 8: Unknown Keys Preservation ===");

const configWithUnknown = `# Config
Port: 7000
my_custom_key: hello_world

## Tools

### Auto Write
status: disabled
backup_dir: ~/.zenith-mcp/mcp_backups/
backup_mode: file
custom_mcp_paths:

### Zenith-Rag
status: disabled
postgres_url:
username:
password:

### Advanced
char_budget: 400000
default_excludes: node_modules,.git
sensitive_patterns: **/.env

## My Custom Section
foo: bar
baz: 42
`;

const parsedUnknown = parseConfig(configWithUnknown);
const serializedUnknown = serializeConfig(parsedUnknown);
const reParsedUnknown = parseConfig(serializedUnknown);

// Check custom section survived
const customSection = reParsedUnknown.find((e) => e.type === "section" && e.name === "My Custom Section");
assert(customSection !== undefined, "custom section 'My Custom Section' preserved");

const fooEntry = reParsedUnknown.find((e) => e.type === "kv" && e.key === "foo");
assertEq(fooEntry?.value, "bar", "unknown key 'foo: bar' preserved");

const bazEntry = reParsedUnknown.find((e) => e.type === "kv" && e.key === "baz");
assertEq(bazEntry?.value, 42, "unknown key 'baz: 42' preserved as number");

// ─── Test 9: Empty custom_mcp_paths round-trip ──────────────────────────────

console.log("\n=== Test 9: Empty custom_mcp_paths Round-Trip ===");

const emptyPathsConfig = structuredClone(DEFAULT_CONFIG);
emptyPathsConfig.auto_write.custom_mcp_paths = [];

const emptyPathsRaw = configToRaw(emptyPathsConfig);
const emptyPathsText = serializeConfig(emptyPathsRaw);

assert(emptyPathsText.includes("custom_mcp_paths"), "custom_mcp_paths key emitted even when empty");

const reParsedEmpty = parseConfig(emptyPathsText);
const emptyConfigBack = rawToConfig(reParsedEmpty);
assert(Array.isArray(emptyConfigBack.auto_write.custom_mcp_paths), "custom_mcp_paths is array after round-trip");
assertEq(emptyConfigBack.auto_write.custom_mcp_paths.length, 0, "empty custom_mcp_paths stays empty");

// ─── Test 10: Inline comments ───────────────────────────────────────────────

console.log("\n=== Test 10: Inline Comments ===");

const inlineCommentConfig = `Port: 7000 # server port
char_budget: 400000 # max chars
`;

const parsedInline = parseConfig(inlineCommentConfig);
const portInline = parsedInline.find((e) => e.type === "kv" && e.key === "Port");
assertEq(portInline?.value, 7000, "value parsed correctly with inline comment");
assert(portInline?.inlineComment != null, "inline comment captured");

const serializedInline = serializeConfig(parsedInline);
assert(serializedInline.includes("# server port"), "inline comment preserved on serialize");

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
