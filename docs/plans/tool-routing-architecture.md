# Tool Routing Architecture — Design Notes

> Status: **Early-stage exploration.** Not yet implemented. Subject to change.

---

## The Problem

Current tool routing approaches create friction for AI agents in two fundamental ways:

### 1. Schema Bloat

When all available tools are dumped into the system prompt, context gets noisy fast. An agent parsing 200+ tool schemas for a conversation that only needs 5 is wasteful. Noise drowns signal. By turn 20, the agent has forgotten what's actually useful in context and must either:

- Ask the user ("how do I use X?")
- Guess and possibly fail
- Re-request tool information (round-trip overhead)

### 2. Cache Invalidation

LLM providers cache prompts by exact token sequence. Any modification to the system prompt — swapping one tool, adjusting a schema, adding context — invalidates the entire cache.

This makes naive dynamic tool routing catastrophically expensive:
```
User calls tool A → cache hit
User calls tool B (different schema) → cache miss
User calls tool A again → cache hit again? No, prompt changed again → cache miss again
```

At scale, this destroys cost efficiency.

---

## Options Considered

### Option 1: MCP Gateway (Current Standard)

All tools behind a single gateway tool (`mcp`). Discovery requires separate calls:

```
Turn 1: mcp({}) → show status
Turn 2: mcp({ connect: "server" }) → list tools
Turn 3: mcp({ tool: "name", args: "..." }) → use it
```

**Problems:**
- 3 calls just to see and use a tool
- Discovery overhead on every new conversation
- Gateway doesn't add value for an agent — just friction

**Benefits:**
- Simple to implement
- Clear separation of concerns

---

### Option 2: Full Schema Exposure

All tools always visible with full schemas in system prompt.

**Problems:**
- Context bloat with many tools (200+ schemas = thousands of tokens)
- Decision paralysis — too many options creates disambiguation overhead
- Same schema for every turn regardless of relevance

**Benefits:**
- No discovery calls needed
- Simple mental model

---

### Option 3: Static Core + Dynamic Injection (Chosen)

**Core principle:** Keep a small set of tools permanently visible, dynamically inject other tools based on context.

#### Design

1. **Permanent core tools** — `read`, `write`, `directory`, `edit`, `create`, `search` — always visible. Small surface area, known patterns.

2. **Dynamic injection via hooks** — At the start of each turn, a hook fires with context from the previous turn. It selects the 3 most likely needed tools and injects their schemas into the agent's context.

3. **Gating mechanism** — No tool is injected more than once every 5-6 turns. If a tool was recently injected, it's assumed to still be accessible in context. This prevents redundant injections.

4. **All tools always callable** — Even if a tool isn't in the current injection set, it can still be called. `search_files` provides a path to discover tools not recently used.

5. **Hook format** — Injected tools appear as a structured message (formatted like a user message), not as system prompt modifications. This keeps the base system prompt static, preserving cache.

#### Schema Format

Injected tools use raw schema arrays identical to how the provider natively represents tools:

```json
[{"name": "tool_name", "parameters": {"type": "object", "properties": {...}}}]
```

**Why raw schema over natural language?**

- Zero interpretation layer — schema is directly actionable
- Consistent with native tool format — agent can't tell the difference without looking at context history
- Fewer tokens than verbose descriptions
- Less room for ambiguity

The goal is tools that **feel native** even though they were dynamically routed.

---

## Implementation Challenges

### Provider Format Detection

Different LLM providers expect different tool formats:

| Provider | Format |
|----------|--------|
| Anthropic | XML `<tool_use>` blocks |
| OpenAI | JSON `{"name": "...", "parameters": {...}}` |
| Others | Varies |

The system must detect the provider and adapt injected schemas to match the expected format.

**Solution:** One adapter per provider. Built once, rarely maintained. Provider formats don't change often. This is finite, stable work.

### Hook Trigger Logic

The hook needs to:
1. Parse previous turn context
2. Predict which 3 tools are most likely needed next
3. Check gating (was tool recently injected?)
4. Inject schemas without modifying system prompt

**Gating logic:**
```
if (tool.lastInjectedTurn >= currentTurn - 5):
    skip injection
else:
    inject
```

This assumes recent tools are still in working context. Reasonable for most cases.

### Cache Preservation

By keeping the base system prompt **static** across all turns, the cache stays hot. Only the injected tool schemas (as turn content) vary, and the variance is minimal and predictable.

```
System prompt: same every turn ✓
Dynamic content: hook injection tokens (consistent structure) ✓
```

---

## Open Questions

- [ ] What's the optimal gating threshold? (5-6 turns is a starting guess)
- [ ] How does the hook prioritize tools? (frequency-based? semantic similarity? hybrid?)
- [ ] Should core tools ever be swapped? Or are they truly permanent?
- [ ] How to handle the first turn of a conversation (no "previous turn" context)?

---

## Summary

The goal is an agent-facing tool system that:
- Keeps context lean (no bloat)
- Preserves cache (no schema manipulation)
- Feels native (injected tools look identical to permanent tools)
- Scales economically (low overhead per turn)

Option 3 achieves these by combining a stable core, smart dynamic injection, and respecting how agents actually process context.

---

*Last updated: 2026-05-09*