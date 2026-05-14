// SA4 core exports
export {
  type RetrievalConfig,
  type RetrievalContext,
  type RootEvidence,
  type ScoredTool,
  type SessionRoutingState,
  type ToolCatalogSnapshot,
  type ToolDoc,
  type ToolMapping,
  type WorkspaceEvidence,
  type RankingEvent,
  type PromptMapping,
  type ResourceMapping,
  createRetrievalContext,
  defaultRetrievalConfig,
} from "./models.js";
export { buildSnapshot } from "./catalog.js";
export { TieredAssembler } from "./assembler.js";
export { PassthroughRetriever, ToolRetriever } from "./base.js";
export { isCanarySession, getSessionGroup } from "./rollout.js";
export { SessionStateManager } from "./session.js";
// SA4 ranking
export * from "./ranking/index.js";
// SA3 pipeline + integration
export { RetrievalPipeline, extractConversationTerms } from "./pipeline.js";
export { ROUTING_TOOL_NAME, ROUTING_TOOL_KEY, buildRoutingToolSchema, handleRoutingCall } from "./routing-tool.js";
export { ZenithToolRegistry, makeToolKey, hashToolList } from "./zenith-tool-registry.js";
export { createRetrievalPipelineForZenith, createRetrievalAwareToolRegistrar, installRetrievalRequestHandlers, setSessionRootsFromMcpRoots } from "./zenith-integration.js";
export { STATIC_CATEGORIES, TIER6_NAMESPACE_PRIORITY } from "./static-categories.js";
export { extractKeywordsFromMessage, matchTriggers } from "./keyword-matcher.js";
