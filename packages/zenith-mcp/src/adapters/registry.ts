import { MCPConfigAdapter } from "./base.js";
import { adapter as antigravityAdapter } from "./platforms/antigravity.js";
import { adapter as claudeDesktopAdapter } from "./platforms/claude-desktop.js";
import { adapter as clineAdapter } from "./platforms/cline.js";
import { adapter as codexCliAdapter } from "./platforms/codex-cli.js";
import { adapter as codexDesktopAdapter } from "./platforms/codex-desktop.js";
import { adapter as continueDevAdapter } from "./platforms/continue-dev.js";
import { adapter as geminiCliAdapter } from "./platforms/gemini-cli.js";
import { adapter as githubCopilotAdapter } from "./platforms/github-copilot.js";
import { adapter as gptmeAdapter } from "./platforms/gptme.js";
import { adapter as jetbrainsAdapter } from "./platforms/jetbrains.js";
import { adapter as openclawAdapter } from "./platforms/openclaw.js";
import { adapter as opencodeAdapter } from "./platforms/opencode.js";
import { adapter as raycastAdapter } from "./platforms/raycast.js";
import { adapter as rooCodeAdapter } from "./platforms/roo-code.js";
import { adapter as warpAdapter } from "./platforms/warp.js";
import { adapter as zedAdapter } from "./platforms/zed.js";

const _adapters: Record<string, MCPConfigAdapter> = {
  antigravity: antigravityAdapter,
  claude_desktop: claudeDesktopAdapter,
  cline: clineAdapter,
  codex_cli: codexCliAdapter,
  codex_desktop: codexDesktopAdapter,
  continue_dev: continueDevAdapter,
  gemini_cli: geminiCliAdapter,
  github_copilot: githubCopilotAdapter,
  gptme: gptmeAdapter,
  jetbrains: jetbrainsAdapter,
  openclaw: openclawAdapter,
  opencode: opencodeAdapter,
  raycast: raycastAdapter,
  roo_code: rooCodeAdapter,
  warp: warpAdapter,
  zed: zedAdapter,
};

function cloneAdapter(adapter: MCPConfigAdapter, backupDir?: string): MCPConfigAdapter {
  const cloned = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter) as MCPConfigAdapter;
  if (backupDir) {
    cloned.backupDir = backupDir;
  } else {
    delete cloned.backupDir;
  }
  return cloned;
}

class AdapterRegistry {
  private _adapters: Record<string, MCPConfigAdapter>;

  constructor(backupDir?: string) {
    this._adapters = Object.fromEntries(
      Object.entries(_adapters).map(([name, adapter]) => [name, cloneAdapter(adapter, backupDir)]),
    );
  }

  all() {
    return Object.values(this._adapters).sort((a, b) => a.toolName.localeCompare(b.toolName));
  }

  get(toolName: string) {
    return this._adapters[toolName] ?? null;
  }
}

let _registry: AdapterRegistry | null = null;

function _getRegistry() {
  if (_registry === null) {
    _registry = new AdapterRegistry();
  }
  return _registry;
}

export function configureRegistry(backupDir?: string) {
  _registry = new AdapterRegistry(backupDir);
}

export function getAdapter(toolName: string) {
  return _getRegistry().get(toolName);
}

export function listAdapters() {
  return _getRegistry().all();
}

export { AdapterRegistry };
