import { homedir } from "node:os";
import { join } from "node:path";
import type { RawConfig } from "./parser.js";

// ---------------------------------------------------------------------------
// ZenithConfig — typed representation of the Zenith-MCP config file
// ---------------------------------------------------------------------------

export interface ZenithConfig {
  port: number;
  tools: Record<string, boolean>;
  auto_write: {
    status: boolean;
    backup_dir: string;
    backup_mode: "file" | "sqlite" | "none";
    custom_mcp_paths: string[];
  };
  rag: {
    status: boolean;
    postgres_url: string;
    username: string;
    password: string;
  };
  advanced: {
    char_budget: number;
    search_char_budget: number;
    refactor_max_chars: number;
    refactor_max_context: number;
    refactor_version_ttl_hours: number;
    session_ttl_ms: number;
    default_excludes: string;
    sensitive_patterns: string;
  };
}

// ---------------------------------------------------------------------------
// Defaults (sourced from shared.ts constants)
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDES_STR =
  "node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo";

const DEFAULT_SENSITIVE_STR =
  "**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**";

export const DEFAULT_CONFIG: ZenithConfig = {
  port: 7000,
  tools: {},
  auto_write: {
    status: false,
    backup_dir: "",
    backup_mode: "file",
    custom_mcp_paths: [],
  },
  rag: {
    status: false,
    postgres_url: "",
    username: "",
    password: "",
  },
  advanced: {
    char_budget: 400_000,
    search_char_budget: 15_000,
    refactor_max_chars: 30_000,
    refactor_max_context: 30,
    refactor_version_ttl_hours: 24,
    session_ttl_ms: 1_800_000,
    default_excludes: DEFAULT_EXCLUDES_STR,
    sensitive_patterns: DEFAULT_SENSITIVE_STR,
  },
};

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

export const CONFIG_PATH: string = join(homedir(), ".zenith-mcp", "config");

// ---------------------------------------------------------------------------
// Helpers — tilde expansion for user-provided paths
// ---------------------------------------------------------------------------

/**
 * Replace a leading `~` or `~/` with the actual home directory.
 * Node's `fs` functions do NOT expand tilde — they would create a literal
 * directory named `~` in the cwd.  Call this on any user-supplied path
 * before passing it to the filesystem.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Helpers — status booleans <-> "enabled"/"disabled" strings
// ---------------------------------------------------------------------------

function statusToStr(v: boolean): string {
  return v ? "enabled" : "disabled";
}

function strToStatus(v: string): boolean {
  return v.trim().toLowerCase() === "enabled";
}

// ---------------------------------------------------------------------------
// Helpers — RawConfig entry constructors
// ---------------------------------------------------------------------------

type RawEntry =
  | { type: "section"; name: string; raw: string }
  | { type: "subsection"; name: string; raw: string }
  | { type: "kv"; key: string; value: boolean | number | string; rawValue: string; inlineComment: string | null }
  | { type: "comment"; text: string }
  | { type: "blank" };

function section(name: string): RawEntry {
  return { type: "section", name, raw: `## ${name}` };
}

function subsection(name: string): RawEntry {
  return { type: "subsection", name, raw: `### ${name}` };
}

function kv(key: string, value: boolean | number | string, rawValue?: string): RawEntry {
  return {
    type: "kv",
    key,
    value,
    rawValue: rawValue ?? String(value),
    inlineComment: null,
  };
}

function comment(text: string): RawEntry {
  return { type: "comment", text };
}

function blank(): RawEntry {
  return { type: "blank" };
}

// ---------------------------------------------------------------------------
// configToRaw — typed config -> parser's RawConfig array
// ---------------------------------------------------------------------------

export function configToRaw(config: ZenithConfig): RawConfig {
  const entries: RawEntry[] = [];

  // Top-level port (no section header — it sits above all sections)
  entries.push(kv("Port", config.port, String(config.port)));
  entries.push(blank());

  // ### Tools
  entries.push(subsection("Tools"));
  const toolNames = Object.keys(config.tools).sort();
  if (toolNames.length === 0) {
    entries.push(comment("# (no tools configured)"));
  } else {
    for (const name of toolNames) {
      entries.push(kv(name, config.tools[name], statusToStr(config.tools[name])));
    }
  }
  entries.push(blank());

  // ### Auto Write
  entries.push(subsection("Auto Write"));
  entries.push(kv("status", config.auto_write.status, statusToStr(config.auto_write.status)));
  entries.push(kv("backup_dir", config.auto_write.backup_dir, config.auto_write.backup_dir));
  entries.push(kv("backup_mode", config.auto_write.backup_mode, config.auto_write.backup_mode));
  entries.push(kv("custom_mcp_paths", config.auto_write.custom_mcp_paths.join(","), config.auto_write.custom_mcp_paths.join(",")));
  entries.push(blank());

  // ### Zenith-Rag
  entries.push(subsection("Zenith-Rag"));
  entries.push(kv("status", config.rag.status, statusToStr(config.rag.status)));
  entries.push(kv("postgres_url", config.rag.postgres_url, config.rag.postgres_url));
  entries.push(kv("username", config.rag.username, config.rag.username));
  entries.push(kv("password", config.rag.password, config.rag.password));
  entries.push(blank());

  // ### Advanced
  entries.push(subsection("Advanced"));
  entries.push(kv("char_budget", config.advanced.char_budget, String(config.advanced.char_budget)));
  entries.push(kv("search_char_budget", config.advanced.search_char_budget, String(config.advanced.search_char_budget)));
  entries.push(kv("refactor_max_chars", config.advanced.refactor_max_chars, String(config.advanced.refactor_max_chars)));
  entries.push(kv("refactor_max_context", config.advanced.refactor_max_context, String(config.advanced.refactor_max_context)));
  entries.push(kv("refactor_version_ttl_hours", config.advanced.refactor_version_ttl_hours, String(config.advanced.refactor_version_ttl_hours)));
  entries.push(kv("session_ttl_ms", config.advanced.session_ttl_ms, String(config.advanced.session_ttl_ms)));
  entries.push(kv("default_excludes", config.advanced.default_excludes, config.advanced.default_excludes));
  entries.push(kv("sensitive_patterns", config.advanced.sensitive_patterns, config.advanced.sensitive_patterns));

  return entries as RawConfig;
}

// ---------------------------------------------------------------------------
// rawToConfig — parser's RawConfig array -> typed config
// ---------------------------------------------------------------------------

export function rawToConfig(raw: RawConfig): ZenithConfig {
  // Start from a deep copy of defaults so every field is guaranteed present.
  const config: ZenithConfig = structuredClone(DEFAULT_CONFIG);

  // Track which subsection we're inside so we route keys correctly.
  let currentSection: string | null = null;

  for (const entry of raw as RawEntry[]) {
    // Only ### subsection headers set the routing context.
    // ## section headers are preserved in RawConfig for round-tripping but
    // do NOT affect key routing.  configToRaw only emits ### headers, so
    // a ## header in a hand-edited config is either a user note or a typo.
    // Letting it reset currentSection would cause it to shadow subsequent
    // ### headers and misroute keys.
    if (entry.type === "subsection") {
      currentSection = entry.name.toLowerCase();
      continue;
    }
    if (entry.type === "section") {
      continue;
    }

    if (entry.type !== "kv") continue;

    const key = entry.key;
    const raw_val = entry.rawValue?.trim() ?? String(entry.value ?? "");

    // Top-level (before any subsection header)
    if (currentSection === null) {
      if (key.toLowerCase() === "port") {
        const n = parseInt(raw_val, 10);
        if (!isNaN(n)) config.port = n;
      }
      continue;
    }

    // ## Tools — every key is a dynamic tool name
    if (currentSection === "tools") {
      config.tools[key] = strToStatus(raw_val);
      continue;
    }

    // ## Auto Write
    if (currentSection === "auto write") {
      switch (key) {
        case "status":
          config.auto_write.status = strToStatus(raw_val);
          break;
        case "backup_dir":
          config.auto_write.backup_dir = raw_val;
          break;
        case "backup_mode":
          if (raw_val === "file" || raw_val === "sqlite" || raw_val === "none") {
            config.auto_write.backup_mode = raw_val;
          }
          break;
        case "custom_mcp_paths":
          config.auto_write.custom_mcp_paths = raw_val
            ? raw_val.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
          break;
        // unknown keys are silently ignored (preserved in RawConfig for round-trip)
      }
      continue;
    }

    // ## Zenith-Rag
    if (currentSection === "zenith-rag") {
      switch (key) {
        case "status":
          config.rag.status = strToStatus(raw_val);
          break;
        case "postgres_url":
          config.rag.postgres_url = raw_val;
          break;
        case "username":
          config.rag.username = raw_val;
          break;
        case "password":
          config.rag.password = raw_val;
          break;
      }
      continue;
    }

    // ## Advanced
    if (currentSection === "advanced") {
      switch (key) {
        case "char_budget": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.char_budget = n;
          break;
        }
        case "search_char_budget": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.search_char_budget = n;
          break;
        }
        case "refactor_max_chars": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_max_chars = n;
          break;
        }
        case "refactor_max_context": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_max_context = n;
          break;
        }
        case "refactor_version_ttl_hours": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.refactor_version_ttl_hours = n;
          break;
        }
        case "session_ttl_ms": {
          const n = parseInt(raw_val, 10);
          if (!isNaN(n)) config.advanced.session_ttl_ms = n;
          break;
        }
        case "default_excludes":
          config.advanced.default_excludes = raw_val;
          break;
        case "sensitive_patterns":
          config.advanced.sensitive_patterns = raw_val;
          break;
      }
      continue;
    }

    // Any other section — ignore keys (they stay in RawConfig for round-trip).
  }

  return config;
}
