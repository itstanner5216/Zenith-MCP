/**
 * Zenith-specific wiring helpers for the retrieval pipeline.
 * No Python equivalent — provides hook-points for future wiring.
 *
 * HAZARD 1: None of these create or extend an McpServer.
 * HAZARD 2: Session IDs always passed in by caller.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Root, Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import type { RetrievalConfig } from "./models.js";
import type { RetrievalLogger } from "./observability/logger.js";
import { NullRetrievalLogger } from "./observability/logger.js";
import type { TelemetryScanner } from "./telemetry/scanner.js";
import { PassthroughRetriever } from "./base.js";
import { SessionStateManager } from "./session.js";
import { ZenithToolRegistry } from "./zenith-tool-registry.js";
import { RetrievalPipeline } from "./pipeline.js";
import { ROUTING_TOOL_NAME } from "./routing-tool.js";
import { makeToolKey } from "./zenith-tool-registry.js";

// ── FilesystemContextLike ─────────────────────────────────────────────────────

export interface FilesystemContextLike {
  getAllowedDirectories(): string[];
  setAllowedDirectories(directories: string[]): void;
  validatePath(path: string): Promise<string>;
}

type RegisteredToolLike = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Tool["annotations"];
  execution?: Tool["execution"];
  _meta?: Tool["_meta"];
  handler?: unknown;
  enabled?: boolean;
};

const EMPTY_OBJECT_JSON_SCHEMA = { type: "object" as const, properties: {} };

function toJsonObjectSchema(schema: unknown, pipeStrategy: "input" | "output"): Tool["inputSchema"] {
  if (!schema) return EMPTY_OBJECT_JSON_SCHEMA;
  const obj = normalizeObjectSchema(schema as Parameters<typeof normalizeObjectSchema>[0]);
  return (
    obj
      ? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy })
      : toJsonSchemaCompat(schema as Parameters<typeof toJsonSchemaCompat>[0], {
          strictUnions: true,
          pipeStrategy,
        })
  ) as Tool["inputSchema"];
}

function toListedTool(name: string, tool: RegisteredToolLike): Tool {
  const listed: Tool = {
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonObjectSchema(tool.inputSchema, "input"),
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  };

  if (tool.outputSchema) {
    listed.outputSchema = toJsonObjectSchema(tool.outputSchema, "output");
  }

  return listed;
}

function sessionIdFromExtra(extra: unknown): string {
  const maybe = extra as { sessionId?: unknown; requestId?: unknown } | undefined;
  return typeof maybe?.sessionId === "string"
    ? maybe.sessionId
    : typeof maybe?.requestId === "string"
      ? maybe.requestId
      : "default";
}

/**
 * Validates args against the tool's stored Zod schema before dispatch.
 * Returns a validation error message if invalid, or null if valid/no schema.
 */
function validateToolArgs(
  mapping: { inputZodSchema?: unknown },
  args: Record<string, unknown>,
): string | null {
  const schema = mapping.inputZodSchema;
  if (!schema || typeof schema !== "object") return null;

  // Zod v4+ uses safeParse; Zod v3 also uses safeParse
  const zodLike = schema as { safeParse?: (data: unknown) => { success: boolean; error?: { message?: string; issues?: unknown[] } } };
  if (typeof zodLike.safeParse !== "function") return null;

  const result = zodLike.safeParse(args);
  if (result.success) return null;

  const errMsg = result.error?.message ?? "Invalid arguments";
  return errMsg;
}

// ── Tool registration hook ───────────────────────────────────────────────────

type RegisterToolArgs = [
  name: string,
  config: Parameters<McpServer["registerTool"]>[1],
  cb: Parameters<McpServer["registerTool"]>[2],
];

export function createRetrievalAwareToolRegistrar(
  server: McpServer,
  registry: ZenithToolRegistry,
  onRegistryChanged?: () => void,
): { registerTool: McpServer["registerTool"] } {
  return {
    registerTool(
      name: string,
      config: Parameters<McpServer["registerTool"]>[1],
      cb: Parameters<McpServer["registerTool"]>[2],
    ): RegisteredTool {
      const args: RegisterToolArgs = [name, config, cb];
      const handler = cb;

      // Real MCP registration first
      const result = server.registerTool(...args);

      // Mirror into local registry for pipeline tracking
      let currentName = name;
      const sync = () => {
        const tool = toListedTool(currentName, result as RegisteredToolLike);
        registry.register(
          tool,
          (result as RegisteredToolLike).handler ?? handler,
          (result as RegisteredToolLike).inputSchema ?? config.inputSchema,
        );
        onRegistryChanged?.();
      };

      sync();

      const registered = result as ReturnType<McpServer["registerTool"]> & {
        update(updates: {
          name?: string | null;
          title?: string;
          description?: string;
          paramsSchema?: unknown;
          outputSchema?: unknown;
          annotations?: Tool["annotations"];
          _meta?: Tool["_meta"];
          callback?: unknown;
          enabled?: boolean;
        }): void;
      };
      const originalUpdate = registered.update.bind(registered);
      const originalEnable = registered.enable.bind(registered);
      const originalDisable = registered.disable.bind(registered);
      const originalRemove = registered.remove.bind(registered);

      registered.update = (updates: Parameters<typeof registered.update>[0]) => {
        const previousName = currentName;
        originalUpdate(updates);
        if (updates.name === null) {
          registry.unregister(previousName);
          onRegistryChanged?.();
          return;
        }
        if (typeof updates.name === "string" && updates.name !== previousName) {
          registry.unregister(previousName);
          currentName = updates.name;
        }
        sync();
      };
      registered.enable = () => {
        originalEnable();
        sync();
      };
      registered.disable = () => {
        originalDisable();
        sync();
      };
      registered.remove = () => {
        originalRemove();
        registry.unregister(currentName);
        onRegistryChanged?.();
      };

      return result;
    },
  };
}

// ── Pipeline factory ─────────────────────────────────────────────────────────

export function createRetrievalPipelineForZenith(options: {
  registry: ZenithToolRegistry;
  config: RetrievalConfig;
  logger?: RetrievalLogger;
  telemetryScanner?: TelemetryScanner;
}): RetrievalPipeline {
  const { registry, config, telemetryScanner } = options;
  const logger = options.logger ?? new NullRetrievalLogger();
  const retriever = new PassthroughRetriever();
  const sessionManager = new SessionStateManager(config);

  return new RetrievalPipeline({
    retriever,
    sessionManager,
    logger,
    config,
    toolRegistry: registry.asLiveRecord(),
    telemetryScanner,
  });
}

export function installRetrievalRequestHandlers(
  server: McpServer,
  pipeline: RetrievalPipeline,
  registry: ZenithToolRegistry,
): void {
  // No private SDK field access needed — the registry is the source of truth.
  // Every tool registered via createRetrievalAwareToolRegistrar is mirrored
  // into the registry, so listing/dispatching through the registry produces
  // the same set of tools as the SDK's internal handler would have.

  const errorResult = (message: string): CallToolResult => ({
    content: [{ type: "text", text: message }],
    isError: true,
  });

  type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

  server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    // `getToolsForList` returns Tool[] sourced directly from registry mappings
    // (see RetrievalPipeline.getToolsForList — every code path returns Tools
    // pulled from registry.mappings). The objects in `selected` are already
    // the canonical registry Tools, including the synthetic routing tool when
    // retrieval is enabled. No further lookup is needed.
    const selected = await pipeline.getToolsForList(sessionIdFromExtra(extra));
    return { tools: selected };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const sid = sessionIdFromExtra(extra);
    const toolName = request.params.name;

    if (toolName === ROUTING_TOOL_NAME) {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const target = typeof args.name === "string" ? args.name : "";
      const mapping = registry.get(target);

      if (!mapping) {
        return errorResult(`Tool ${target} not found`);
      }

      if (args.describe === true) {
        pipeline.recordRouterDescribe(sid, target);
        return { content: [{ type: "text", text: JSON.stringify(mapping.tool, null, 2) }] };
      }

      const routedArgs = (args.arguments ?? {}) as Record<string, unknown>;
      const handler = mapping.handler as ToolHandler | undefined;
      if (!handler) {
        return errorResult(`Tool ${target} has no handler`);
      }

      // Validate args against tool's Zod schema before dispatch
      const validationErr = validateToolArgs(mapping, routedArgs);
      if (validationErr) {
        return errorResult(`Tool ${target} input validation failed: ${validationErr}`);
      }

      let result: CallToolResult;
      try {
        result = await handler(routedArgs, extra);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = errorResult(`Tool ${target} threw: ${message}`);
      }
      if (!result.isError) {
        await pipeline.onToolCalled(sid, target, routedArgs, true);
      }
      return result;
    }

    const key = makeToolKey("zenith", toolName);
    const mapping = registry.get(key);
    if (!mapping) {
      return errorResult(`Tool ${toolName} not found in registry`);
    }
    const handler = mapping.handler as ToolHandler | undefined;
    if (!handler) {
      return errorResult(`Tool ${toolName} has no registered handler`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Validate args against tool's Zod schema before dispatch
    const validationErr = validateToolArgs(mapping, args);
    if (validationErr) {
      return errorResult(`Tool ${toolName} input validation failed: ${validationErr}`);
    }

    let result: CallToolResult;
    try {
      result = await handler(args, extra);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = errorResult(`Tool ${toolName} threw: ${message}`);
    }
    if (!result.isError) {
      await pipeline.onToolCalled(sid, key, args, false);
    }
    return result;
  });
}

// ── Roots bridge ─────────────────────────────────────────────────────────────

export async function setSessionRootsFromMcpRoots(
  pipeline: RetrievalPipeline,
  sessionId: string,
  roots: Root[],
): Promise<void> {
  const uris = roots.map((r) => r.uri);
  await pipeline.setSessionRoots(sessionId, uris);
}
