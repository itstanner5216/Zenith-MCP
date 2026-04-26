import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".zenith-mcp");
const CONFIG_FILE = join(CONFIG_DIR, "adapter-config.json");

export interface AdapterSettings {
  enabledAdapters: string[];
  backupDir: string | null;
}

const DEFAULTS: AdapterSettings = { enabledAdapters: [], backupDir: null };

function defaultSettings(): AdapterSettings {
  return { enabledAdapters: [], backupDir: null };
}

export function loadSettings(): AdapterSettings {
  // Env var overrides take full priority
  const envAdapters = process.env.ZENITH_MCP_ADAPTERS_ENABLED;
  const envBackup = process.env.ZENITH_MCP_ADAPTER_BACKUP_DIR;
  if (envAdapters !== undefined || envBackup !== undefined) {
    return {
      enabledAdapters: envAdapters ? envAdapters.split(",").map(s => s.trim()).filter(Boolean) : [],
      backupDir: envBackup ?? null,
    };
  }
  if (!existsSync(CONFIG_FILE)) return defaultSettings();
  try {
    return { ...defaultSettings(), ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AdapterSettings): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export function getBackupDir(): string | null {
  return loadSettings().backupDir;
}

export function isAdapterEnabled(toolName: string): boolean {
  const { enabledAdapters } = loadSettings();
  return enabledAdapters.length === 0 ? false : enabledAdapters.includes(toolName);
}
