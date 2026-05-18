import { createInterface } from "node:readline";
import { DEFAULT_CONFIG } from "./schema.js";
import type { ZenithConfig } from "./schema.js";
import { saveConfig } from "./loader.js";
import { autoWriteToMcpConfigs, formatAutoWriteSummary } from "./auto-write.js";

// ---------------------------------------------------------------------------
// WizardIO — parameterize I/O so callers can route stdout/stderr appropriately.
// In a stdio MCP server, process.stdout is the JSON transport pipe — wizard
// output must be redirected (typically to stderr) to keep that pipe clean.
// ---------------------------------------------------------------------------

export interface WizardIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const defaultIO: WizardIO = {
  input: process.stdin,
  output: process.stdout,
};

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

/** Write a single line to the WizardIO output. */
function writeLine(io: WizardIO, text: string): void {
  io.output.write(text + "\n");
}

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------

function createQuestionHelper(io: WizardIO) {
  const rl = createInterface({ input: io.input, output: io.output });
  const question = (p: string) =>
    new Promise<string>((resolve) => rl.question(p, resolve));
  return { rl, question };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner(io: WizardIO): void {
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
  for (const line of lines) writeLine(io, line);
}

// ---------------------------------------------------------------------------
// Completion banner
// ---------------------------------------------------------------------------

function printComplete(io: WizardIO, configPath: string): void {
  writeLine(io, "");
  writeLine(io, divider());
  writeLine(io, "");
  writeLine(io, `  ${S.bold}${S.brightRed}>${S.reset} ${S.bold}${S.white}Configuration saved.${S.reset}`);
  writeLine(io, note(configPath));
  writeLine(io, note("Edit this file anytime to change settings."));
  writeLine(io, "");
  writeLine(io, divider());
  writeLine(io, "");
}

// ---------------------------------------------------------------------------
// runFirstRunWizard
// ---------------------------------------------------------------------------

export async function runFirstRunWizard(io: WizardIO = defaultIO): Promise<ZenithConfig> {
  const { rl, question } = createQuestionHelper(io);

  try {
    printBanner(io);

    // ── Auto-write ──────────────────────────────────────────────────────
    writeLine(io, sectionHeader("Auto-Write"));
    writeLine(io, note("Register Zenith in your other AI tools automatically."));
    writeLine(io, note("Zenith will back up each config file before touching it."));
    writeLine(io, "");

    const autoWriteEnabled = await askYesNo(
      io,
      question,
      prompt("Enable auto-write? ") + gray("[y/N] "),
      false,
    );

    // ── Backup (only if auto-write) ─────────────────────────────────────
    let backupMode: "file" | "sqlite" | "none" = "file";
    let backupDir: string = DEFAULT_CONFIG.auto_write.backup_dir;

    if (autoWriteEnabled) {
      writeLine(io, "");
      writeLine(io, sectionHeader("Backup Mode"));
      writeLine(io, note("How should Zenith store config backups?"));
      writeLine(io, "");
      writeLine(io, option("1", "File backups", "~/.zenith-mcp/mcp_backups/  (default)"));
      writeLine(io, option("2", "SQLite", "auto-deleted after 24 hours"));
      writeLine(io, option("3", "Custom path", "you choose the directory"));
      writeLine(io, option("4", "No backups", "not recommended"));
      writeLine(io, "");

      const backupChoice = await askBackupMode(io, question);
      backupMode = backupChoice.mode;
      backupDir = backupChoice.dir;
    }

    // ── Custom MCP paths (only if auto-write) ───────────────────────────
    let customMcpPaths: string[] = [];

    if (autoWriteEnabled) {
      writeLine(io, "");
      writeLine(io, sectionHeader("Custom MCP Paths"));
      writeLine(io, note("Extra config files or directories for Zenith to register in."));
      writeLine(io, note("Leave blank if your tools use standard locations."));
      writeLine(io, "");

      customMcpPaths = await askCustomMcpPaths(question);
    }

    // ── Port ────────────────────────────────────────────────────────────
    writeLine(io, "");
    writeLine(io, sectionHeader("Server Port"));
    writeLine(io, note("Network port for HTTP mode. Doesn't matter for stdio."));
    writeLine(io, "");

    const port = await askPort(io, question);

    // ── Character budget ────────────────────────────────────────────────
    writeLine(io, "");
    writeLine(io, sectionHeader("Character Budget"));
    writeLine(io, note("Max characters Zenith returns per file read."));
    writeLine(io, note("Higher = more content but uses more context window."));
    writeLine(io, "");

    const charBudget = await askCharBudget(io, question);

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
    printComplete(io, "~/.zenith-mcp/config");

    // ── Run auto-write if enabled ───────────────────────────────────────
    if (autoWriteEnabled) {
      writeLine(io, `  ${S.bold}${S.brightRed}>${S.reset} ${S.white}Running auto-write...${S.reset}`);
      writeLine(io, "");
      const result = autoWriteToMcpConfigs(config);
      const summary = formatAutoWriteSummary(result);

      if (result.errors.length === 0 && result.written.length > 0) {
        writeLine(io, `  ${S.bold}${S.brightRed}>${S.reset} ${S.white}${summary}${S.reset}`);
      } else if (result.errors.length > 0) {
        writeLine(io, `  ${S.brightRed}! ${summary}${S.reset}`);
      } else {
        writeLine(io, `  ${S.dim}${S.gray}${summary}${S.reset}`);
      }

      if (result.written.length > 0) {
        for (const path of result.written) {
          writeLine(io, note(`  written: ${path}`));
        }
      }

      writeLine(io, "");
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
  io: WizardIO,
  question: (p: string) => Promise<string>,
  styledPrompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = (await question(styledPrompt)).trim().toLowerCase();

    if (answer === "") return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;

    writeLine(io, errorMsg('Enter "y" or "n".'));
  }
}

// ---------------------------------------------------------------------------
// askBackupMode
// ---------------------------------------------------------------------------

async function askBackupMode(
  io: WizardIO,
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
      const customDir = await askCustomPath(io, question);
      return { mode: "file", dir: customDir };
    }

    if (choice === "4") {
      return { mode: "none", dir: DEFAULT_CONFIG.auto_write.backup_dir };
    }

    writeLine(io, errorMsg("Enter 1, 2, 3, or 4."));
  }
}

// ---------------------------------------------------------------------------
// askCustomPath
// ---------------------------------------------------------------------------

async function askCustomPath(
  io: WizardIO,
  question: (p: string) => Promise<string>,
): Promise<string> {
  for (;;) {
    const path = (await question(prompt("Backup path: "))).trim();
    if (path !== "") return path;
    writeLine(io, errorMsg("Path cannot be empty."));
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
  io: WizardIO,
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

    writeLine(io, errorMsg("Enter a valid port (1–65535)."));
  }
}

// ---------------------------------------------------------------------------
// askCharBudget
// ---------------------------------------------------------------------------

async function askCharBudget(
  io: WizardIO,
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

    writeLine(io, errorMsg("Enter a number between 10,000 and 2,000,000."));
  }
}
