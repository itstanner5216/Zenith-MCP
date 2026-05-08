// Parser — plain-text config parsing and serialization
export { parseConfig, serializeConfig } from "./parser.js";
export type {
  RawConfig,
  ConfigEntry,
  SectionEntry,
  SubsectionEntry,
  CommentEntry,
  BlankEntry,
  KVEntry,
} from "./parser.js";

// Schema — typed config shape, defaults, and conversion helpers
export { DEFAULT_CONFIG, CONFIG_PATH, expandTilde, configToRaw, rawToConfig } from "./schema.js";
export type { ZenithConfig } from "./schema.js";

// Backup — file and SQLite backup/restore
export { backupFile, restoreBackup, cleanupExpiredBackups } from "./backup.js";

// Loader — high-level config I/O and tool merging
export {
  configExists,
  loadConfig,
  saveConfig,
  mergeToolsIntoConfig,
  syncToolsWithConfig,
  patchToolsInConfig,
} from "./loader.js";

// Auto-write — register Zenith in platform MCP configs
export { autoWriteToMcpConfigs, formatAutoWriteSummary } from "./auto-write.js";
export type { AutoWriteResult } from "./auto-write.js";

// Wizard — interactive first-run setup
export { runFirstRunWizard } from "./wizard.js";
