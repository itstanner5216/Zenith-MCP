/**
 * Synthetic MCP routing tool for demoted-tools discovery.
 * Converted from src/zenithmcp/retrieval/routing_tool.py
 *
 * HAZARD 3: handleRoutingCall returns a sentinel, never invokes handlers.
 */

import type { TextContent, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolMapping } from "./models.js";

export const ROUTING_TOOL_NAME = "request_tool";
export const ROUTING_TOOL_KEY = "__routing__request_tool";

export function buildRoutingToolSchema(demotedToolIds: string[]): Tool {
  return {
    name: ROUTING_TOOL_NAME,
    description:
      "Access tools not in your active set. " +
      "Use describe=true to get full schema, or provide arguments to call directly.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name (server__tool format)",
          enum: demotedToolIds,
        },
        describe: {
          type: "boolean",
          description: "If true, return tool schema instead of calling",
          default: false,
        },
        arguments: {
          type: "object",
          description: "Arguments to pass when describe=false",
          default: {},
        },
      },
      required: ["name"],
    },
  };
}


export function handleRoutingCall(
  name: string,
  describe: boolean,
  _args: Record<string, unknown>,
  registry: Record<string, ToolMapping>,
): TextContent[] {
  const mapping = registry[name];

  if (!mapping) {
    const available = Object.keys(registry).sort().slice(0, 10);
    return [{ type: "text", text: `Tool not found: '${name}'. Available: [${available.join(", ")}]` }];
  }

  if (describe) {
    return [{
      type: "text",
      text: JSON.stringify({
        name: mapping.tool.name,
        description: mapping.tool.description ?? "",
        inputSchema: mapping.tool.inputSchema,
      }, null, 2),
    }];
  }

  // describe=false → caller checks sentinel and dispatches via registry.get(name)?.handler
  return [{ type: "text", text: `__PROXY_CALL__:${name}` }];
}

