/**
 * Immutable versioned tool catalog snapshots.
 *
 * buildSnapshot() converts the live tool_to_server registry into a
 * ToolCatalogSnapshot with a stable schema_hash. The hash is SHA-256 of a
 * sorted canonical JSON representation — identical registries always produce
 * the same hash; any schema change produces a new hash.
 *
 * retrieval_aliases is left empty here — populated by BMXFRetriever when it
 * builds the field index. The catalog snapshot is schema-only; alias
 * generation is scorer-side logic.
 */
import { createHash } from "node:crypto";
import type { ToolCatalogSnapshot, ToolDoc } from "./models.js";
import type { ToolMapping } from "./models.js";

// Module-scoped monotonically incrementing counter
let _versionCounter = 0;

function extractParamNames(inputSchema: unknown): string[] {
  if (!isObject(inputSchema)) return [];
  const props = inputSchema["properties"];
  if (!isObject(props)) return [];
  return Object.keys(props).sort();
}

import { isObject } from "./utils.js";

export function buildSnapshot(registry: Record<string, ToolMapping>): ToolCatalogSnapshot {
  _versionCounter++;
  const versionNum = _versionCounter;

  const docs: ToolDoc[] = [];
  for (const [key, mapping] of Object.entries(registry).sort()) {
    const [ns, name] = key.includes("__") ? key.split("__", 2) as [string, string] : ["", key];
    const paramNames = extractParamNames(mapping.tool.inputSchema);
    docs.push({
      toolKey: key,
      toolName: name,
      namespace: ns,
      description: mapping.tool.description ?? "",
      parameterNames: paramNames.join(" "),
      retrievalAliases: "",
    });
  }

  // Canonical JSON: sorted by tool_key (already sorted above), minimal separators
  const canonical = JSON.stringify(
    docs.map((d) => ({ k: d.toolKey, d: d.description, p: d.parameterNames })),
    null,
    0,
  );
  const schemaHash = createHash("sha256").update(canonical).digest("hex");

  return {
    version: String(versionNum),
    schemaHash,
    builtAt: Date.now() / 1000,
    docs,
  };
}

