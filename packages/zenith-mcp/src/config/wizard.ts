import { createInterface } from "node:readline";
import { DEFAULT_CONFIG } from "./schema.js";
import type { ZenithConfig } from "./schema.js";
import { saveConfig } from "./loader.js";
import { autoWriteToMcpConfigs, formatAutoWriteSummary } from "./auto-write.js";

// ---------------------------------------------------------------------------
// ANSI styling — zero dependencies, red/black/white/gray theme
// ---------------------------------------------------------------------------

const S = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  red:       "\x1b[31m",
  brightRed: "\x1b[91m",
  white:     "\x1b[97m",
  gray:      "\x1b[90m",
  bgRed:     "\x1b[41m",
};

/** Dim gray text */
function gray(text: string): string {
  return `${S.dim}${S.gray}${text}${S.reset}`;
}

/** Red prompt arrow */
function prompt(text: string): string {
  return `${S.bold}${S.brightRed}  > ${S.reset}${S.white}${text}${S.reset}`;
}

/** Section divider */
function divider(): string {
  return `${S.dim}${S.red}  ${"─".repeat(50)}${S.reset}`;
}

/** Section header */
function sectionHeader(title: string): string {
  return `\n${S.bold}${S.brightRed}  :: ${S.white}${title}${S.reset}`;
}

/** Styled option line for menus */
function option(key: string, label: string, note?: string): string {
  const noteStr = note ? `  ${S.dim}${S.gray}${note}${S.reset}` : "";
  return `${S.gray}    ${S.reset}${S.bold}${S.brightRed}[${key}]${S.reset} ${S.white}${label}${S.reset}${noteStr}`;
}

/** Error message */
function errorMsg(text: string): string {
  return `${S.brightRed}  x ${text}${S.reset}`;
}

/** Info note */
function note(text: string): string {
  return `${S.dim}${S.gray}    ${text}${S.reset}`;
}

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------

function createQuestionHelper() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (p: string) =>
    new Promise<string>((resolve) => rl.question(p, resolve));
  return { rl, question };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(): void {
  const lines = [
    "",
    `${S.dim}${S.red}  ┌──────────────────────────────────────────────────┐${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}                                                  ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}         ${S.bold}${S.white}Z E N I T H ${S.dim}${S.gray}—${S.reset} ${S.bold}${S.white}M C P${S.reset}              ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}                                                  ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}   ${S.dim}${S.gray}The MCP filesystem your agent deserves.${S.reset}        ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}   ${S.dim}${S.gray}Let's get you set up.${S.reset}                          ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  │${S.reset}                                                  ${S.dim}${S.red}│${S.reset}`,
    `${S.dim}${S.red}  └──────────────────────────────────────────────────┘${S.reset}`,
    "",
  ];
  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// Completion banner
// ---------------------------------------------------------------------------

function printComplete(configPath: string): void {
  console.log("");
  console.log(divider());
  console.log("");
  console.log(`  ${S.bold}${S.brightRed}>${S.reset} ${S.bold}${S.white}Configuration saved.${S.reset}`);
  console.log(note(configPath));
  console.log(note("Edit this file anytime to change settings."));
  console.log("");
  console.log(divider());
  console.log("");
}

// ---------------------------------------------------------------------------
// runFirstRunWizard
// ---------------------------------------------------------------------------

export async function runFirstRunWizard(): Promise<ZenithConfig> {
  const { rl, question } = createQuestionHelper();

  try {
    printBanner();

    // ── Auto-write ──────────────────────────────────────────────────────
    console.log(sectionHeader("Auto-Write"));
    console.log(note("Register Zenith in your other AI tools automatically."));
    console.log(note("Zenith will back up each config file before touching it."));
    console.log("");

    const autoWriteEnabled = await askYesNo(
      question,
      prompt("Enable auto-write? ") + gray("[y/N] "),
      false,
    );

    // ── Backup (only if auto-write) ─────────────────────────────────────
    let backupMode: "file" | "sqlite" | "none" = "file";
    let backupDir: string = DEFAULT_CONFIG.auto_write.backup_dir;

    if (autoWriteEnabled) {
      console.log("");
      console.log(sectionHeader("Backup Mode"));
      console.log(note("How should Zenith store config backups?"));
      console.log("");
      console.log(option("1", "File backups", "~/.zenith-mcp/mcp_backups/  (default)"));
      console.log(option("2", "SQLite", "auto-deleted after 24 hours"));
      console.log(option("3", "Custom path", "you choose the directory"));
      console.log(option("4", "No backups", "not recommended"));
      console.log("");

      const backupChoice = await askBackupMode(question);
      backupMode = backupChoice.mode;
      backupDir = backupChoice.dir;
    }

    // ── Custom MCP paths (only if auto-write) ───────────────────────────
    let customMcpPaths: string[] = [];

    if (autoWriteEnabled) {
      console.log("");
      console.log(sectionHeader("Custom MCP Paths"));
      console.log(note("Extra config files or directories for Zenith to register in."));
      console.log(note("Leave blank if your tools use standard locations."));
      console.log("");

      customMcpPaths = await askCustomMcpPaths(question);
    }

    // ── Port ────────────────────────────────────────────────────────────
    console.log("");
    console.log(sectionHeader("Server Port"));
    console.log(note("Network port for HTTP mode. Doesn't matter for stdio."));
    console.log("");

    const port = await askPort(question);

    // ── Character budget ────────────────────────────────────────────────
    console.log("");
    console.log(sectionHeader("Character Budget"));
    console.log(note("Max characters Zenith returns per file read."));
    console.log(note("Higher = more content but uses more context window."));
    console.log("");

    const charBudget = await askCharBudget(question);

    // ── Build config ────────────────────────────────────────────────────
    const config: ZenithConfig = structuredClone(DEFAULT_CONFIG);
    config.port = port;
    config.advanced.char_budget = charBudget;
    config.auto_write.status = autoWriteEnabled;
    config.auto_write.backup_mode = backupMode;
    config.auto_write.backup_dir = backupDir;
    config.auto_write.custom_mcp_paths = customMcpPaths;

    // ── Persist ─────────────────────────────────────────────────────────
    saveConfig(config);
    printComplete("~/.zenith-mcp/config");

    // ── Run auto-write if enabled ───────────────────────────────────────
    if (autoWriteEnabled) {
      console.log(`  ${S.bold}${S.brightRed}>${S.reset} ${S.white}Running auto-write...${S.reset}`);
      console.log("");
      const result = autoWriteToMcpConfigs(config);
      const summary = formatAutoWriteSummary(result);

      if (result.errors.length === 0 && result.written.length > 0) {
        console.log(`  ${S.bold}${S.brightRed}>${S.reset} ${S.white}${summary}${S.reset}`);
      } else if (result.errors.length > 0) {
        console.log(`  ${S.brightRed}! ${summary}${S.reset}`);
      } else {
        console.log(`  ${S.dim}${S.gray}${summary}${S.reset}`);
      }

      if (result.written.length > 0) {
        for (const path of result.written) {
          console.log(note(`  written: ${path}`));
        }
      }

      console.log("");
    }

    return config;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// askYesNo
// ---------------------------------------------------------------------------

async function askYesNo(
  question: (p: string) => Promise<string>,
  styledPrompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = (await question(styledPrompt)).trim().toLowerCase();

    if (answer === "") return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;

    console.log(errorMsg('Enter "y" or "n".'));
  }
}

// ---------------------------------------------------------------------------
// askBackupMode
// ---------------------------------------------------------------------------

async function askBackupMode(
  question: (p: string) => Promise<string>,
): Promise<{ mode: "file" | "sqlite" | "none"; dir: string }> {
  for (;;) {
    const choice = (await question(prompt("Choice ") + gray("[1] "))).trim();

    if (choice === "" || choice === "1") {
      return { mode: "file", dir: DEFAULT_CONFIG.auto_write.backup_dir };
    }

    if (choice === "2") {
      return { mode: "sqlite", dir: DEFAULT_CONFIG.auto_write.backup_dir };
    }

    if (choice === "3") {
      const customDir = await askCustomPath(question);
      return { mode: "file", dir: customDir };
    }

    if (choice === "4") {
      return { mode: "none", dir: DEFAULT_CONFIG.auto_write.backup_dir };
    }

    console.log(errorMsg("Enter 1, 2, 3, or 4."));
  }
}

// ---------------------------------------------------------------------------
// askCustomPath
// ---------------------------------------------------------------------------

async function askCustomPath(
  question: (p: string) => Promise<string>,
): Promise<string> {
  for (;;) {
    const path = (await question(prompt("Backup path: "))).trim();
    if (path !== "") return path;
    console.log(errorMsg("Path cannot be empty."));
  }
}

// ---------------------------------------------------------------------------
// askCustomMcpPaths
// ---------------------------------------------------------------------------

async function askCustomMcpPaths(
  question: (p: string) => Promise<string>,
): Promise<string[]> {
  const answer = (
    await question(prompt("Extra paths ") + gray("(comma-separated, Enter to skip) "))
  ).trim();

  if (answer === "") return [];

  return answer
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// askPort
// ---------------------------------------------------------------------------

async function askPort(
  question: (p: string) => Promise<string>,
): Promise<number> {
  for (;;) {
    const answer = (
      await question(prompt("Port ") + gray(`[${DEFAULT_CONFIG.port}] `))
    ).trim();

    if (answer === "") return DEFAULT_CONFIG.port;

    const parsed = Number(answer);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }

    console.log(errorMsg("Enter a valid port (1–65535)."));
  }
}

// ---------------------------------------------------------------------------
// askCharBudget
// ---------------------------------------------------------------------------

async function askCharBudget(
  question: (p: string) => Promise<string>,
): Promise<number> {
  for (;;) {
    const answer = (
      await question(
        prompt("Max characters ") +
          gray(`[${DEFAULT_CONFIG.advanced.char_budget.toLocaleString()}] `),
      )
    ).trim();

    if (answer === "") return DEFAULT_CONFIG.advanced.char_budget;

    const parsed = Number(answer.replace(/,/g, ""));
    if (Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 2_000_000) {
      return parsed;
    }

    console.log(errorMsg("Enter a number between 10,000 and 2,000,000."));
  }
}
