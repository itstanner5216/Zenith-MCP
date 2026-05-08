---

## Findings

### [P1] JavaScript Regex \w is not Unicode-aware in Python port
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/toon/bmx-plus.ts` |
| **Lines** | (Tokenization logic) |
| **Priority** | 1 |
| **Confidence** | 1.0 |

During the Python to TypeScript port, the tokenization regex `/\b\w+\b/g` was carried over. However, unlike Python's `re` module where `\w` is Unicode-aware by default, JavaScript's `\w` only matches ASCII characters `[a-zA-Z0-9_]`. This causes the TypeScript implementation of BMX+ to drop or incorrectly split non-ASCII characters during text chunking, directly degrading NDCG@10 scores compared to the original Python implementation. The regex must be updated to a Unicode-aware pattern like `/[\p{L}\p{N}_]+/gu`.

---

### [P1] Ignoring isolated allowedDirectories in validation check
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/core/lib.ts` |
| **Lines** | 350–359 |
| **Priority** | 1 |
| **Confidence** | 0.95 |

The `searchFilesWithValidation` function takes `allowedDirectories` as an explicit parameter for context isolation, but completely ignores it in its try-catch block, instead calling the globally bound `validatePath(fullPath)` API. This breaks session isolation logic because it relies on the global configuration rather than the directories explicitly provided to the search function. 

---

### [P3] Unused trimmedLen parameter in coordinate mapping
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/core/edit-engine.ts` |
| **Lines** | 133–141 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The `mapTrimmedIndex` function accepts a `trimmedLen` parameter but never uses it. The function accurately calculates the starting coordinate (`origIdx`), but relying on the caller to compute the length mapping is unnecessary if `trimmedLen` was originally intended to verify or map the span's end index. The parameter should be removed.

---

### [P3] Unused imports and unused iteration variables
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/retrieval/telemetry/tokens.ts` |
| **Lines** | 1–1 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The file imports `RootEvidence` and `WorkspaceEvidence` but never uses them. Additionally, on line 106, the loop declares `[familyKey, familyTokens]` but only reads `familyTokens`, leaving `familyKey` unused. These should be cleaned up.

---

### [P3] Dead code functions in symbol-index
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/core/symbol-index.ts` |
| **Lines** | 174–182 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The internal functions `pruneOldVersions` and `defaultVersionTtlMs` are declared but never called anywhere in the file. Since these are private to the module and unexported, they are completely dead code and should be removed to avoid confusion.

---

### [P3] Unused imported functions in project context
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/core/project-context.ts` |
| **Lines** | 5–5 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The file imports `findRepoRoot` from `./symbol-index.js` but never actually uses it anywhere within `project-context.ts`.

---

### [P3] Unused Tool interface import
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/retrieval/base.ts` |
| **Lines** | 4–4 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The abstract base class imports `Tool` from `@modelcontextprotocol/sdk/types.js` but the type is never utilized in the class signature or body.

---

### [P3] Unused args parameter in router evaluation
| Field | Value |
|:---|:---|
| **File** | `/home/tanner/Projects/Zenith-MCP/src/retrieval/routing-tool.ts` |
| **Lines** | 75–75 |
| **Priority** | 3 |
| **Confidence** | 1.0 |

The `handleRoutingCall` function takes an `args` parameter in its signature but intentionally disregards it because the router simply returns a proxy string without invoking the target tool. The parameter should be removed or prefixed with an underscore (`_args`) to signal intentional non-use.

---

## Overall Assessment

| Field | Value |
|:---|:---|
| **Verdict** | `patch is incorrect` |
| **Confidence** | 1.0 |

While the TypeScript conversion looks structurally sound, there is a critical isolation bypass in the core filesystem search utilities. These issues along with several unused definitions must be addressed before this refactor can be deemed production-ready.
