// tests/helpers/polaris-db.js
//
// POLARIS Task 0.2 — physical/canonical DB snapshot helpers and
// trigger-controlled fault injection for migration/transaction oracles.
//
// These helpers are TEST-ONLY machinery. They import exclusively from the
// compiled adapter (dist/core/db-adapter.js) plus node builtins; they never
// touch production source and never open a live database (see
// rehearseRealDbMigration's guards).
//
// Design notes
// ------------
// physicalSnapshot(conn)
//   Captures the *physical* database state deterministically:
//     - schema: tables (stored CREATE sql, columns via PRAGMA table_info,
//       foreign keys via PRAGMA foreign_key_list, indexes via PRAGMA
//       index_list/index_info incl. auto-indexes), views, triggers
//     - sequence: full sqlite_sequence contents
//     - rows: every user-table row
//   Determinism: tables/views/triggers/indexes sorted by name, FKs by (id,
//   seq), index columns by seqno, columns by cid (physical column order IS
//   the fact being captured), rows sorted by their stable serialization.
//   Values are normalized (BLOB -> hex descriptor, bigint -> number/string)
//   so two runs over identical databases produce deeply-equal objects.
//
// canonicalIntelligenceSnapshot(conn)
//   Captures *logical intelligence facts only*: file paths, symbol
//   name/kind/type/position/visibility/captureTag/bodyHash + parent identity
//   by (name,file,line); edge (caller identity, referenced name, reference
//   kind, callee identity) pairs; import/binding/anchor/structure/scope/
//   injection/pattern/version content. NO row ids, NO timestamps, NO file
//   hashes (migrations intentionally invalidate them). Duplicate logical
//   facts are preserved via a `count` field instead of row identity, so the
//   snapshot is stable across physically different but logically identical
//   databases (different rowids, different sqlite_sequence, VACUUM, etc.).
//   Column/table presence is probed via PRAGMA so the same function works on
//   v1 through v4 databases; version-gap columns collapse to exactly the
//   backfill value the ladder writes (reference_kind -> 'unknown',
//   anchors.end_line -> line, imports.start/end_line -> line), which is what
//   makes pre-migration vs post-migration canonical equality a valid oracle.
//
// Fault injection (armFault / disarmFault / disarmAllFaults)
//   Arms a TEMP trigger `AFTER <op> ON <table> [WHEN ...] BEGIN SELECT
//   RAISE(ABORT, msg); END`. AFTER-timing means the write boundary has been
//   crossed before the abort fires, deterministically faulting a transaction
//   mid-flight. RAISE(ABORT) rolls back the current statement and surfaces a
//   JS exception; runTransaction's catch then rolls back the whole
//   transaction (or savepoint). Disarm by DROP TRIGGER, or implicitly by
//   closing the connection (temp triggers are per-connection).
//
// buildLadderDbAtVersion(dbPath, stopVersion)
//   Produces a database at an intermediate ladder version by running the
//   REAL initSymbolSchema and halting it with a temp trigger on the
//   schema_version write of (stopVersion + 1). Because each ladder step is
//   its own transaction, the halted step rolls back completely and the
//   database is left EXACTLY as the real ladder leaves it at stopVersion.
//   One deviation, stated openly: the schema_version table must be
//   pre-created (with the identical single-row DDL normalizeSchemaVersionTable
//   uses) so the halt triggers have a target before init runs. This changes
//   only the table's position in sqlite_master creation order — never its
//   DDL text, columns, or contents — and physicalSnapshot sorts by name, so
//   comparisons are unaffected.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    openDb,
    closeDb,
    initSymbolSchema,
    getSchemaVersion,
    execRaw,
    queryRaw,
} from '../../dist/core/db-adapter.js';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HELPERS_DIR, '..', 'fixtures');

export const FAULT_MESSAGE = 'POLARIS_FAULT';
export const LADDER_HALT_MESSAGE = 'POLARIS_LADDER_HALT';
export const REAL_DB_ENV_VAR = 'POLARIS_REAL_DB_COPY';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

/** Normalize a SQLite-returned value into a JSON-stable representation. */
export function normalizeValue(value) {
    if (typeof value === 'bigint') {
        if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)) {
            return Number(value);
        }
        return `bigint:${value.toString()}`;
    }
    if (value instanceof Uint8Array) {
        return `blob:${Buffer.from(value).toString('hex')}`;
    }
    return value;
}

/** JSON stringify with recursively sorted object keys — a total, stable order. */
export function stableStringify(value) {
    const walk = (v) => {
        const n = normalizeValue(v);
        if (Array.isArray(n)) return n.map(walk);
        if (n !== null && typeof n === 'object') {
            const out = {};
            for (const key of Object.keys(n).sort()) out[key] = walk(n[key]);
            return out;
        }
        return n;
    };
    return JSON.stringify(walk(value));
}

function normalizeRow(row) {
    const out = {};
    for (const key of Object.keys(row).sort()) out[key] = normalizeValue(row[key]);
    return out;
}

function sortRows(rows) {
    return rows.map(normalizeRow).sort((a, b) => {
        const sa = stableStringify(a);
        const sb = stableStringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
}

/** Collapse duplicate logical facts into {…fact, count} — no row identity. */
function groupCount(rows) {
    const byKey = new Map();
    for (const row of rows) {
        const fact = normalizeRow(row);
        const key = stableStringify(fact);
        const existing = byKey.get(key);
        if (existing) existing.count += 1;
        else byKey.set(key, { ...fact, count: 1 });
    }
    return [...byKey.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, fact]) => fact);
}

export function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function makeTempDir(prefix = 'polaris-db-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Introspection primitives
// ---------------------------------------------------------------------------

function quoteIdent(name) {
    return `"${String(name).replaceAll('"', '""')}"`;
}

export function tableExists(conn, table) {
    const rows = queryRaw(conn, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);
    return rows.length === 1;
}

export function columnNames(conn, table) {
    return queryRaw(conn, `PRAGMA table_info(${quoteIdent(table)})`).map((r) => r.name);
}

function hasColumn(conn, table, column) {
    return columnNames(conn, table).includes(column);
}

// ---------------------------------------------------------------------------
// physicalSnapshot
// ---------------------------------------------------------------------------

export function physicalSnapshot(conn) {
    const master = queryRaw(
        conn,
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"
    );

    const tables = master
        .filter((r) => r.type === 'table' && !r.name.startsWith('sqlite_'))
        .map((t) => {
            const columns = queryRaw(conn, `PRAGMA table_info(${quoteIdent(t.name)})`)
                .map(normalizeRow)
                .sort((a, b) => a.cid - b.cid);
            const foreignKeys = queryRaw(conn, `PRAGMA foreign_key_list(${quoteIdent(t.name)})`)
                .map(normalizeRow)
                .sort((a, b) => (a.id - b.id) || (a.seq - b.seq));
            const indexes = queryRaw(conn, `PRAGMA index_list(${quoteIdent(t.name)})`)
                .map((idx) => {
                    const idxColumns = queryRaw(conn, `PRAGMA index_info(${quoteIdent(idx.name)})`)
                        .map(normalizeRow)
                        .sort((a, b) => a.seqno - b.seqno);
                    const sqlRow = master.find((m) => m.type === 'index' && m.name === idx.name);
                    return {
                        name: idx.name,
                        unique: normalizeValue(idx.unique),
                        origin: idx.origin,
                        partial: normalizeValue(idx.partial),
                        sql: sqlRow ? sqlRow.sql : null,
                        columns: idxColumns,
                    };
                })
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            return { name: t.name, sql: t.sql, columns, foreignKeys, indexes };
        });

    const views = master
        .filter((r) => r.type === 'view')
        .map((r) => ({ name: r.name, sql: r.sql }));
    const triggers = master
        .filter((r) => r.type === 'trigger')
        .map((r) => ({ name: r.name, table: r.tbl_name, sql: r.sql }));

    const sequence = tableExists(conn, 'sqlite_sequence')
        ? sortRows(queryRaw(conn, 'SELECT name, seq FROM sqlite_sequence'))
        : [];

    const rows = {};
    for (const t of tables) {
        rows[t.name] = sortRows(queryRaw(conn, `SELECT * FROM ${quoteIdent(t.name)}`));
    }

    return { schema: { tables, views, triggers }, sequence, rows };
}

// ---------------------------------------------------------------------------
// canonicalIntelligenceSnapshot
// ---------------------------------------------------------------------------

export function canonicalIntelligenceSnapshot(conn) {
    const snapshot = {
        files: [],
        symbols: [],
        edges: [],
        anchors: [],
        imports: [],
        importBindings: [],
        structures: [],
        scopes: [],
        injections: [],
        patterns: [],
        versions: [],
        projectRoots: [],
    };

    if (tableExists(conn, 'files')) {
        // hash and last_indexed are intentionally excluded: hash is
        // invalidated by the v2/v4 migrations by design, last_indexed is a
        // timestamp. Neither is an intelligence fact.
        snapshot.files = queryRaw(conn, 'SELECT path FROM files ORDER BY path').map((r) => r.path);
    }

    if (tableExists(conn, 'symbols')) {
        const cap = hasColumn(conn, 'symbols', 'capture_tag') ? 's.capture_tag' : 'NULL';
        const bh = hasColumn(conn, 'symbols', 'body_hash') ? 's.body_hash' : 'NULL';
        const vis = hasColumn(conn, 'symbols', 'visibility') ? 's.visibility' : 'NULL';
        const hasParent = hasColumn(conn, 'symbols', 'parent_symbol_id');
        const parentSelect = hasParent
            ? 'p.name AS parentName, p.file_path AS parentFile, p.line AS parentLine'
            : 'NULL AS parentName, NULL AS parentFile, NULL AS parentLine';
        const parentJoin = hasParent ? 'LEFT JOIN symbols p ON p.id = s.parent_symbol_id' : '';
        snapshot.symbols = groupCount(queryRaw(conn, `
            SELECT s.name AS name, s.kind AS kind, s.type AS type, s.file_path AS filePath,
                   s.line AS line, s.end_line AS endLine, s."column" AS columnNumber,
                   ${cap} AS captureTag, ${bh} AS bodyHash, ${vis} AS visibility,
                   ${parentSelect}
            FROM symbols s ${parentJoin}`));
    }

    if (tableExists(conn, 'edges') && tableExists(conn, 'symbols')) {
        const rk = hasColumn(conn, 'edges', 'reference_kind')
            ? "COALESCE(e.reference_kind, 'unknown')"
            : "'unknown'";
        const hasCallee = hasColumn(conn, 'edges', 'callee_symbol_id');
        const calleeSelect = hasCallee
            ? 'callee.name AS calleeName, callee.file_path AS calleeFile, callee.line AS calleeLine'
            : 'NULL AS calleeName, NULL AS calleeFile, NULL AS calleeLine';
        const calleeJoin = hasCallee ? 'LEFT JOIN symbols callee ON callee.id = e.callee_symbol_id' : '';
        snapshot.edges = groupCount(queryRaw(conn, `
            SELECT caller.name AS callerName, caller.file_path AS callerFile, caller.line AS callerLine,
                   e.referenced_name AS referencedName, ${rk} AS referenceKind,
                   ${calleeSelect}
            FROM edges e
            JOIN symbols caller ON caller.id = e.container_def_id
            ${calleeJoin}`));
    }

    if (tableExists(conn, 'anchors')) {
        const endLine = hasColumn(conn, 'anchors', 'end_line') ? 'COALESCE(a.end_line, a.line)' : 'a.line';
        snapshot.anchors = groupCount(queryRaw(conn, `
            SELECT s.name AS symbolName, s.file_path AS symbolFile, s.line AS symbolLine,
                   a.kind AS kind, a.line AS line, ${endLine} AS endLine, a.text AS text
            FROM anchors a JOIN symbols s ON s.id = a.symbol_id`));
    }

    if (tableExists(conn, 'imports')) {
        const sl = hasColumn(conn, 'imports', 'start_line') ? 'COALESCE(i.start_line, i.line)' : 'i.line';
        const el = hasColumn(conn, 'imports', 'end_line') ? 'COALESCE(i.end_line, i.line)' : 'i.line';
        snapshot.imports = groupCount(queryRaw(conn, `
            SELECT i.file_path AS filePath, i.module AS module,
                   i.imported_names_json AS importedNamesJson, i.line AS line,
                   ${sl} AS startLine, ${el} AS endLine
            FROM imports i`));
    }

    if (tableExists(conn, 'import_bindings')) {
        snapshot.importBindings = groupCount(queryRaw(conn, `
            SELECT file_path AS filePath, source AS source, local_name AS localName,
                   imported_name AS importedName, import_kind AS importKind,
                   is_type_only AS isTypeOnly, line AS line, "column" AS columnNumber
            FROM import_bindings`));
    }

    if (tableExists(conn, 'symbol_structures')) {
        snapshot.structures = groupCount(queryRaw(conn, `
            SELECT s.name AS symbolName, s.file_path AS symbolFile, s.line AS symbolLine,
                   ss.params_json AS paramsJson, ss.return_text AS returnText,
                   ss.decorators_json AS decoratorsJson, ss.modifiers_json AS modifiersJson,
                   ss.generics_text AS genericsText, ss.parent_kind AS parentKind,
                   ss.parent_name AS parentName
            FROM symbol_structures ss JOIN symbols s ON s.id = ss.symbol_id`));
    }

    if (tableExists(conn, 'local_scopes')) {
        snapshot.scopes = groupCount(queryRaw(conn, `
            SELECT p.name AS ownerName, p.file_path AS ownerFile, p.line AS ownerLine,
                   ls.scope_kind AS scopeKind, ls.start_line AS startLine, ls.end_line AS endLine,
                   ls.parameters_json AS parametersJson, ls.locals_json AS localsJson
            FROM local_scopes ls LEFT JOIN symbols p ON p.id = ls.symbol_id`));
    }

    if (tableExists(conn, 'injections')) {
        snapshot.injections = groupCount(queryRaw(conn, `
            SELECT file_path AS filePath, host_lang AS hostLang, injected_lang AS injectedLang,
                   start_line AS startLine, end_line AS endLine,
                   start_byte AS startByte, end_byte AS endByte
            FROM injections`));
    }

    if (tableExists(conn, 'patterns')) {
        // created_at excluded: timestamp.
        snapshot.patterns = groupCount(queryRaw(conn, `
            SELECT name AS name, edit_body AS editBody, symbol_kind AS symbolKind FROM patterns`));
    }

    if (tableExists(conn, 'versions')) {
        // id and created_at excluded: row identity and timestamp.
        const line = hasColumn(conn, 'versions', 'line') ? 'line' : 'NULL';
        const textHash = hasColumn(conn, 'versions', 'text_hash') ? 'text_hash' : 'NULL';
        snapshot.versions = groupCount(queryRaw(conn, `
            SELECT symbol_name AS symbolName, file_path AS filePath,
                   original_text AS originalText, session_id AS sessionId,
                   ${line} AS line, ${textHash} AS textHash
            FROM versions`));
    }

    if (tableExists(conn, 'project_roots')) {
        // created_at excluded: timestamp.
        snapshot.projectRoots = groupCount(queryRaw(conn, `
            SELECT root_path AS rootPath, name AS name FROM project_roots`));
    }

    return snapshot;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export function checkDbHealth(conn) {
    const integrity = queryRaw(conn, 'PRAGMA integrity_check').map(normalizeRow);
    const foreignKeyViolations = queryRaw(conn, 'PRAGMA foreign_key_check').map(normalizeRow);
    const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    return { integrityOk, integrity, foreignKeyViolations };
}

// ---------------------------------------------------------------------------
// Trigger-controlled fault injection
// ---------------------------------------------------------------------------

let faultCounter = 0;

/**
 * Arm a deterministic fault: a TEMP trigger that RAISE(ABORT)s when the
 * described write boundary is crossed. Returns the trigger name for disarm.
 *
 * @param conn    DbConnection (dist adapter handle)
 * @param spec    { table, op: 'INSERT'|'UPDATE'|'DELETE', when?, message?, timing? }
 *                `when` is a raw SQL expression over NEW/OLD (test-authored).
 *                `timing` defaults to AFTER so the write itself completes
 *                before the abort — a true post-write-boundary fault.
 */
export function armFault(conn, spec) {
    const { table, op, when, message = FAULT_MESSAGE, timing = 'AFTER', name } = spec;
    if (!IDENTIFIER_RE.test(String(table))) throw new Error(`armFault: bad table name ${String(table)}`);
    if (!['INSERT', 'UPDATE', 'DELETE'].includes(op)) throw new Error(`armFault: bad op ${String(op)}`);
    if (!['BEFORE', 'AFTER'].includes(timing)) throw new Error(`armFault: bad timing ${String(timing)}`);
    faultCounter += 1;
    const triggerName = name === undefined ? `polaris_fault_${faultCounter}` : name;
    if (!IDENTIFIER_RE.test(triggerName)) throw new Error(`armFault: bad trigger name ${triggerName}`);
    const safeMessage = String(message).replaceAll("'", "''");
    const whenClause = when === undefined ? '' : ` WHEN ${when}`;
    execRaw(conn, `CREATE TEMP TRIGGER ${triggerName} ${timing} ${op} ON ${quoteIdent(table)}${whenClause} BEGIN SELECT RAISE(ABORT, '${safeMessage}'); END`);
    return triggerName;
}

export function disarmFault(conn, triggerName) {
    if (!IDENTIFIER_RE.test(String(triggerName))) throw new Error(`disarmFault: bad trigger name ${String(triggerName)}`);
    execRaw(conn, `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)}`);
}

export function listArmedFaults(conn) {
    return queryRaw(
        conn,
        "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND (name LIKE 'polaris_fault_%' OR name LIKE 'polaris_ladder_halt_%')"
    ).map((r) => r.name).sort();
}

export function disarmAllFaults(conn) {
    for (const name of listArmedFaults(conn)) disarmFault(conn, name);
}

// ---------------------------------------------------------------------------
// Fixture application / seeded databases
// ---------------------------------------------------------------------------

/**
 * Apply a SQL fixture file onto a NEW file-backed database opened through the
 * real openDb (so pragmas — WAL, foreign_keys=ON — match production). The
 * fixture's inserts therefore run under live FK enforcement. Returns the open
 * connection; the caller owns close.
 */
export function applySqlFixture(dbPath, fixtureFileName) {
    const fixturePath = path.isAbsolute(fixtureFileName)
        ? fixtureFileName
        : path.join(FIXTURES_DIR, fixtureFileName);
    const sql = fs.readFileSync(fixturePath, 'utf8');
    const conn = openDb(dbPath);
    try {
        execRaw(conn, sql);
    } catch (e) {
        closeDb(conn);
        throw e;
    }
    return conn;
}

/** Seed a meaningful v1 database (noncontiguous ids) at dbPath. */
export function seedV1Db(dbPath) {
    return applySqlFixture(dbPath, 'polaris-v1-schema.sql');
}

/** Seed a meaningful v4 database (noncontiguous ids) at dbPath. */
export function seedV4Db(dbPath) {
    return applySqlFixture(dbPath, 'polaris-v4-schema.sql');
}

// ---------------------------------------------------------------------------
// Ladder-stop builder (real ladder, halted by trigger)
// ---------------------------------------------------------------------------

const LADDER_HALT_TRIGGERS = ['polaris_ladder_halt_insert', 'polaris_ladder_halt_update'];

/**
 * Build a database at an exact intermediate ladder version by running the
 * REAL initSymbolSchema and halting it at the schema_version write of
 * (stopVersion + 1). stopVersion 4 runs the full ladder. stopVersion 0 halts
 * the v0→v1 step itself, leaving only the pre-ladder base schema + ad-hoc
 * ALTERs (and the pre-created, empty schema_version table).
 * Returns the open connection (halt triggers already dropped).
 */
export function buildLadderDbAtVersion(dbPath, stopVersion) {
    if (![0, 1, 2, 3, 4].includes(stopVersion)) {
        throw new Error(`buildLadderDbAtVersion: stopVersion must be 0..4, got ${String(stopVersion)}`);
    }
    const conn = openDb(dbPath);
    try {
        if (stopVersion === 4) {
            initSymbolSchema(conn);
            return conn;
        }
        // Pre-create schema_version with the identical DDL that
        // normalizeSchemaVersionTable uses, so the halt triggers have a target.
        // See header comment for why this is equivalence-preserving.
        execRaw(conn, 'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)');
        const haltAt = stopVersion + 1; // validated integer — safe to inline
        execRaw(conn, `CREATE TEMP TRIGGER ${LADDER_HALT_TRIGGERS[0]} BEFORE INSERT ON schema_version WHEN NEW.version = ${haltAt} BEGIN SELECT RAISE(ABORT, '${LADDER_HALT_MESSAGE}'); END`);
        execRaw(conn, `CREATE TEMP TRIGGER ${LADDER_HALT_TRIGGERS[1]} BEFORE UPDATE ON schema_version WHEN NEW.version = ${haltAt} BEGIN SELECT RAISE(ABORT, '${LADDER_HALT_MESSAGE}'); END`);
        let halted = false;
        try {
            initSymbolSchema(conn);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes(LADDER_HALT_MESSAGE)) throw e;
            halted = true;
        } finally {
            for (const t of LADDER_HALT_TRIGGERS) execRaw(conn, `DROP TRIGGER IF EXISTS ${t}`);
        }
        if (!halted) {
            throw new Error(`buildLadderDbAtVersion: ladder never reached the version-${haltAt} write`);
        }
        const landed = getSchemaVersion(conn);
        if (landed !== stopVersion) {
            throw new Error(`buildLadderDbAtVersion: expected version ${stopVersion} after halt, got ${landed}`);
        }
        return conn;
    } catch (e) {
        closeDb(conn);
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Real-DB migration rehearsal (release gate) — defined, never faked
// ---------------------------------------------------------------------------

/**
 * Rehearse the migration against a USER-SUPPLIED COPY of a real database.
 *
 * Hard rules:
 *  - The path must be explicit; there is no default and no discovery.
 *  - Paths inside the live database home (~/.zenith-mcp) are refused before
 *    any filesystem access — this helper must never open a live DB.
 *  - The copy is mutated in place (that is the rehearsal); callers supply a
 *    disposable copy.
 *
 * Returns a full report; it never fabricates results — if this function was
 * not run (no copy supplied), the release gate is explicitly unexecuted.
 */
export function rehearseRealDbMigration(copyPath) {
    if (typeof copyPath !== 'string' || copyPath.trim() === '') {
        throw new Error('rehearseRealDbMigration: an explicit path to a user-supplied COPY is required');
    }
    const resolved = path.resolve(copyPath);
    const liveHome = path.join(os.homedir(), '.zenith-mcp');
    if (resolved === liveHome || resolved.startsWith(liveHome + path.sep)) {
        throw new Error(`rehearseRealDbMigration: refusing to touch the live database home (${liveHome}); supply a copy stored elsewhere`);
    }
    if (!fs.existsSync(resolved)) {
        throw new Error(`rehearseRealDbMigration: no database copy at ${resolved}`);
    }

    const beforeSha256 = sha256File(resolved);
    const conn = openDb(resolved);
    let report;
    try {
        const beforeVersion = getSchemaVersion(conn);
        const canonicalBefore = canonicalIntelligenceSnapshot(conn);
        initSymbolSchema(conn);
        const afterVersion = getSchemaVersion(conn);
        const canonicalAfter = canonicalIntelligenceSnapshot(conn);
        const health = checkDbHealth(conn);
        report = {
            executed: true,
            copyPath: resolved,
            beforeVersion,
            afterVersion,
            canonicalPreserved: stableStringify(canonicalBefore) === stableStringify(canonicalAfter),
            canonicalBefore,
            canonicalAfter,
            integrityOk: health.integrityOk,
            integrity: health.integrity,
            foreignKeyViolations: health.foreignKeyViolations,
        };
    } finally {
        closeDb(conn);
    }
    report.beforeSha256 = beforeSha256;
    report.afterSha256 = sha256File(resolved);
    return report;
}
