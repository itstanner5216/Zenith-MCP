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
        registry.register(tool, (result as RegisteredToolLike).handler ?? handler);
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
  const protocol = server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
  const defaultList = protocol._requestHandlers.get("tools/list");
  const defaultCall = protocol._requestHandlers.get("tools/call");

  if (!defaultList || !defaultCall) {
    throw new Error("MCP tool handlers are not initialized");
  }

  const errorResult = (message: string): CallToolResult => ({
    content: [{ type: "text", text: message }],
    isError: true,
  });

  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const full = (await defaultList(request, extra)) as { tools: Tool[] };
    const selected = await pipeline.getToolsForList(sessionIdFromExtra(extra));
    const fullByName = new Map(full.tools.map((tool) => [tool.name, tool]));
    const tools: Tool[] = [];

    for (const tool of selected) {
      if (tool.name === ROUTING_TOOL_NAME) {
        tools.push(tool);
        continue;
      }

      const sdkTool = fullByName.get(tool.name);
      if (sdkTool) tools.push(sdkTool);
    }

    return { ...full, tools };
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
        const full = (await defaultList({ method: "tools/list" }, extra)) as { tools: Tool[] };
        const tool = full.tools.find((candidate) => candidate.name === mapping.tool.name) ?? mapping.tool;
        pipeline.recordRouterDescribe(sid, target);
        return { content: [{ type: "text", text: JSON.stringify(tool, null, 2) }] };
      }

      const routedArgs = (args.arguments ?? {}) as Record<string, unknown>;
      const proxiedRequest = {
        ...request,
        params: {
          ...request.params,
          name: mapping.tool.name,
          arguments: routedArgs,
        },
      };
      const result = (await defaultCall(proxiedRequest, extra)) as CallToolResult;
      if (!result.isError) {
        await pipeline.onToolCalled(sid, target, routedArgs, true);
      }
      return result;
    }

    const result = (await defaultCall(request, extra)) as CallToolResult;
    if (!result.isError) {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      await pipeline.onToolCalled(sid, makeToolKey("zenith", toolName), args, false);
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
