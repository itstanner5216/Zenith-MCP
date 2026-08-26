// Schema — typed config shape, defaults, and conversion helpers
export { expandTilde } from "./schema.js";
export type { ZenithConfig } from "./schema.js";

// Loader — high-level config I/O and tool merging
export {
  configExists,
  loadConfig,
  syncToolsWithConfig,
  patchToolsInConfig,
} from "./loader.js";

// Wizard — interactive first-run setup
export { runFirstRunWizard } from "./wizard.js";
