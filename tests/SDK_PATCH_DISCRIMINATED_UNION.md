# SDK Patch: Discriminated Union Schema Exposure

> **File modified:** `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`
> **Date:** 2026-04-23
> **Reason:** Allow `z.discriminatedUnion()` (and other non-object Zod schemas) to be correctly converted to JSON Schema (`anyOf`) when clients request the tool list. Without this patch, non-object schemas silently become `{ type: 'object', properties: {} }`.

---

## Before (Lines 75–82)

```javascript
                    inputSchema: (() => {
                        const obj = normalizeObjectSchema(tool.inputSchema);
                        return obj
                            ? toJsonSchemaCompat(obj, {
                                strictUnions: true,
                                pipeStrategy: 'input'
                            })
                            : EMPTY_OBJECT_JSON_SCHEMA;
                    })(),
```

## After (Lines 75–88)

```javascript
                    inputSchema: (() => {
                        const obj = normalizeObjectSchema(tool.inputSchema);
                        return obj
                            ? toJsonSchemaCompat(obj, {
                                strictUnions: true,
                                pipeStrategy: 'input'
                            })
                            : (tool.inputSchema
                                ? toJsonSchemaCompat(tool.inputSchema, {
                                    strictUnions: true,
                                    pipeStrategy: 'input'
                                  })
                                : EMPTY_OBJECT_JSON_SCHEMA);
                    })(),
```

---

## Diff View

```diff
                     inputSchema: (() => {
                         const obj = normalizeObjectSchema(tool.inputSchema);
                         return obj
                             ? toJsonSchemaCompat(obj, {
                                 strictUnions: true,
                                 pipeStrategy: 'input'
                             })
-                            : EMPTY_OBJECT_JSON_SCHEMA;
+                            : (tool.inputSchema
+                                ? toJsonSchemaCompat(tool.inputSchema, {
+                                    strictUnions: true,
+                                    pipeStrategy: 'input'
+                                  })
+                                : EMPTY_OBJECT_JSON_SCHEMA);
                     })(),
```

---

## How to Revert

1. Open `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`
2. Go to line 75
3. Replace the **After** block with the **Before** block above
4. Restart the MCP server

---

## What This Enables

```javascript
server.registerTool("myTool", {
    inputSchema: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('search'), query: z.string() }),
        z.object({ mode: z.literal('replace'), oldText: z.string(), newText: z.string() }),
        z.object({ mode: z.literal('delete'), path: z.string() }),
    ]),
    // ...
});
```

The client now receives:

```json
{
  "anyOf": [
    { "type": "object", "properties": { "mode": { "const": "search" }, "query": { "type": "string" } }, "required": ["mode", "query"] },
    { "type": "object", "properties": { "mode": { "const": "replace" }, "oldText": { "type": "string" }, "newText": { "type": "string" } }, "required": ["mode", "oldText", "newText"] },
    { "type": "object", "properties": { "mode": { "const": "delete" }, "path": { "type": "string" } }, "required": ["mode", "path"] }
  ]
}
```

Instead of `{}`.
