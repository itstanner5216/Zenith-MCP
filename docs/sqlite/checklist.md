# Zenith-MCP SQLite Architecture After node:sqlite Migration

This document describes the current SQLite architecture in Zenith-MCP after migrating from `better-sqlite3` to Node's built-in `node:sqlite` module.

---

## High-Level Architecture Summary

Zenith-MCP uses Node's built-in `node:sqlite` (DatabaseSync) for persistence in three distinct contexts:

1. **Project-Scoped Database (`symbols.db`):** Stored inside each project/repository's `.mcp/` directory. It manages parsed files, symbol definitions/references (`symbols` table), dependency/call graphs (`edges` table), and historical refactoring versions (`versions` table).

2. **Global Database (`global-stash.db`):** Stored in `~/.zenith-mcp/global-stash.db`. It persists:
   - Manually-initialized project roots (`project_roots` table)
   - Configuration file backups (`config_backups` table)
   - Global stash of failed file edits/writes (`stash` table) when outside of a resolved project root

3. **In-Memory Database (`:memory:`):** Used during testing to test database methods deterministically.

---

## Centralized SQLite Access

All SQLite operations go through `src/core/db-adapter.ts`, which is the **ONLY** file that directly touches the SQLite driver.

### Key Architectural Changes from better-sqlite3

- **Driver:** Uses Node's built-in `node:sqlite` (DatabaseSync) instead of the native `better-sqlite3` package
- **Type Safety:** `DbConnection._handle` is typed as `DatabaseSync` instead of `any`
- **Statement Caching:** Added per-connection statement cache to avoid repeated prepare calls in hot paths
- **Node Version:** Requires Node.js 22+ (where `node:sqlite` is available)
- **No Native Bindings:** Eliminates all native build/rebuild issues

### Statement Caching

The adapter now includes a per-connection statement cache (`_stmtCache: Map<string, StatementSync>`) to optimize hot-path queries:

```typescript
export type DbConnection = {
    _handle: DatabaseSync;
    _stmtCache: Map<string, StatementSync>;
};

function prepareOrCache(conn: DbConnection, sql: string): StatementSync {
    const cache = conn._stmtCache;
    let stmt = cache.get(sql);
    if (!stmt) {
        stmt = conn._handle.prepare(sql);
        cache.set(sql, stmt);
    }
    return stmt;
}
```

This significantly reduces overhead for frequently-called functions like:
- `insertSymbol()` (called in tight loops during indexing)
- `upsertFile()` (called for every indexed file)
- `getFileHash()` (called for change detection)
- Symbol graph queries (`getCallers()`, `getCallees()`, etc.)

---

## Current SQLite Usage

All source and test files now use the centralized adapter:

### Core Modules

- **`src/core/db-adapter.ts`** — The single SQLite touchpoint; all other modules call functions from this adapter
- **`src/core/symbol-index.ts`** — Project symbol indexing (uses adapter for all DB operations)
- **`src/core/project-context.ts`** — Project root resolution and global DB management (uses adapter)
- **`src/core/stash.ts`** — Edit/write stash API (uses adapter)
- **`src/config/backup.ts`** — Config file backups (uses adapter)

### Tools

- **`src/tools/search_files.ts`** — File/content/symbol search (uses adapter for structural queries)
- **`src/tools/refactor_batch.ts`** — Cross-file refactoring (uses adapter for symbol graph operations)

### Tests

All test files use the adapter's `openMemoryDb()` for isolated testing:

- `tests/symbol-index-core.test.js`
- `tests/robustness-behavioral.test.js`
- `tests/refactor-batch.test.js`
- `tests/project-context.test.js`
- `tests/stash-core.test.js`
- `tests/stash-restore-tool.test.js`
- `tests/stash_restore_task_1_4.test.js`

---

## Migration Impact

### Removed Dependencies

- `better-sqlite3` package
- `@types/better-sqlite3` package
- `pnpm-workspace.yaml` `allowBuilds.better-sqlite3` entry
- `packages/zenith-mcp/package.json` `repair:sqlite` script
- `src/scripts/repair-zenith-sqlite.sh` script

### Added Requirements

- Node.js 22+ (enforced via `package.json` `engines` field)

### Database Compatibility

Existing `.db` files created by `better-sqlite3` are fully compatible with `node:sqlite`. No migration is required for user databases.

---

## Testing Strategy

Run the full test suite to verify the migration:

```bash
npm run build
npm test
```

All 988+ tests should pass, confirming that:
- Statement caching works correctly
- Schema initialization works
- CRUD operations work
- Transaction support works
- Version snapshots work
- Stash operations work
- Symbol indexing works
- Graph queries work

---

## Future Considerations

If a driver swap is ever needed again, only `src/core/db-adapter.ts` needs to be modified. All other code depends on the adapter's interface, not the underlying driver.
