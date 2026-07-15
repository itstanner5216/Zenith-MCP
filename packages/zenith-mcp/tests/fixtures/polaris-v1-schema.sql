-- polaris-v1-schema.sql — POLARIS Task 0.2 seeded schema-v1 database.
--
-- PROVENANCE / DRIFT CONTRACT
-- ---------------------------
-- The DDL below is a character-for-character REPLAY of the statements
-- `initSymbolSchema` (src/core/db-adapter.ts) executes on a fresh database,
-- halted exactly after the v0→v1 ladder step (schema_version = 1). It is NOT
-- a hand-flattened "final shape": column order and sqlite_master stored text
-- are produced by running the same base CREATEs followed by the same ALTERs,
-- in the same order, with the same statement text. polaris-schema-migration
-- .test.js asserts this fixture's physical schema is deep-equal to a database
-- built by the REAL ladder (buildLadderDbAtVersion(…, 1)); if the ladder in
-- db-adapter.ts drifts, that assertion fails loudly. Do not "clean up" the
-- DDL text here — byte fidelity IS the fixture.
--
-- Seed rows are meaningful and FK-consistent (applySqlFixture runs with
-- foreign_keys=ON): two files, parented symbols, a resolved and two
-- unresolved edges, anchors (v1: no end_line), statement imports (v1: no
-- start/end spans), structures, local scopes, an injection, a version
-- snapshot, a pattern, and a project root. IDs are deliberately
-- NONCONTIGUOUS (3, 7, 12, 15, 22, 30, …) so migration oracles cannot pass
-- by accident on rowid coincidence.

-- --- base schema (initSymbolSchema first exec block, verbatim) -------------
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            hash TEXT,
            last_indexed INTEGER
        );
        CREATE TABLE IF NOT EXISTS symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            kind TEXT,
            type TEXT,
            file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
            line INTEGER,
            end_line INTEGER,
            column INTEGER
        );
        CREATE TABLE IF NOT EXISTS edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            container_def_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
            referenced_name TEXT
        );
        CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol_name TEXT,
            file_path TEXT,
            original_text TEXT,
            session_id TEXT,
            created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            edit_body TEXT,
            symbol_kind TEXT,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
        CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
        CREATE INDEX IF NOT EXISTS idx_symbols_kind_name ON symbols(kind, name);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(referenced_name);
        CREATE INDEX IF NOT EXISTS idx_edges_container ON edges(container_def_id);
        CREATE INDEX IF NOT EXISTS idx_versions_session ON versions(session_id);

-- --- ad-hoc versions migrations (verbatim) ---------------------------------
ALTER TABLE versions ADD COLUMN line INTEGER;
ALTER TABLE versions ADD COLUMN text_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_dedup ON versions(symbol_name, file_path, text_hash, session_id);

-- --- schema_version single-row table (normalizeSchemaVersionTable, verbatim)
CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);

-- --- v0 → v1 ladder step (verbatim ALTERs, then child tables) --------------
ALTER TABLE symbols ADD COLUMN capture_tag TEXT;
ALTER TABLE symbols ADD COLUMN body_hash TEXT;
ALTER TABLE symbols ADD COLUMN parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE;
ALTER TABLE symbols ADD COLUMN visibility TEXT;
ALTER TABLE edges ADD COLUMN callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL;
            CREATE TABLE IF NOT EXISTS symbol_structures (
                symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
                params_json TEXT, return_text TEXT, decorators_json TEXT,
                modifiers_json TEXT, generics_text TEXT, parent_kind TEXT, parent_name TEXT
            );
            CREATE TABLE IF NOT EXISTS anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                kind TEXT, line INTEGER, text TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_anchors_symbol ON anchors(symbol_id);
            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                module TEXT, imported_names_json TEXT, line INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);
            CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(module);
            CREATE TABLE IF NOT EXISTS local_scopes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
                scope_kind TEXT, start_line INTEGER, end_line INTEGER,
                parameters_json TEXT, locals_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_local_scopes_symbol ON local_scopes(symbol_id);
            CREATE TABLE IF NOT EXISTS injections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                host_lang TEXT, injected_lang TEXT,
                start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_injections_file ON injections(file_path);
            CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_symbol_id);
            -- v3 remediation: project_roots is also a v1 addition (project-DB registry,
            -- not the dormant initGlobalSchema variant). Idempotent CREATE; safe if a
            -- prior partial run already added it.
            CREATE TABLE IF NOT EXISTS project_roots (
                root_path TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER
            );
INSERT INTO schema_version (id, version) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET version = excluded.version;

-- --- seed rows (noncontiguous IDs, FK-valid) -------------------------------
INSERT INTO files (path, hash, last_indexed) VALUES
    ('src/alpha.ts', '9f86d081884c7d659a2feaa0c55ad015', 1700000000000),
    ('src/beta.ts',  'a3f5c1e2d4b6a8c0e2f4a6b8c0d2e4f6', 1700000001000);

INSERT INTO symbols (id, name, kind, type, file_path, line, end_line, column, capture_tag, body_hash, parent_symbol_id, visibility) VALUES
    (3,  'greet',     'def', 'function', 'src/alpha.ts', 5, 9,  9,  'definition.function', 'bh-greet-v1',     NULL, 'public'),
    (7,  'Greeter',   'def', 'class',    'src/alpha.ts', 12, 20, 6, 'definition.class',    'bh-greeter-v1',   NULL, 'public'),
    (12, 'greetLoud', 'def', 'method',   'src/alpha.ts', 14, 17, 4, 'definition.method',   'bh-greetloud-v1', 7,    NULL),
    (15, 'betaFn',    'ref', 'call',     'src/alpha.ts', 8, 8,  11, 'reference.call',      NULL,              NULL, NULL),
    (22, 'betaFn',    'def', 'function', 'src/beta.ts',  3, 6,  16, 'definition.function', 'bh-betafn-v1',    NULL, 'public'),
    (30, 'greet',     'ref', 'call',     'src/beta.ts',  5, 5,  2,  'reference.call',      NULL,              NULL, NULL);

INSERT INTO edges (id, container_def_id, referenced_name, callee_symbol_id) VALUES
    (2,  3,  'betaFn',    22),
    (9,  12, 'greet',     NULL),
    (14, 22, 'missingFn', NULL);

INSERT INTO anchors (id, symbol_id, kind, line, text) VALUES
    (5,  3,  'return', 8,  '    return betaFn(x);'),
    (11, 12, 'branch', 15, '        if (loud) {');

INSERT INTO imports (id, file_path, module, imported_names_json, line) VALUES
    (4, 'src/alpha.ts', './beta',    '["betaFn"]', 2),
    (8, 'src/beta.ts',  'node:util', '["format"]', 1);

INSERT INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES
    (3,  '["x"]',            'string', '[]', '["export"]', NULL, NULL,    NULL),
    (12, '["name","loud"]',  NULL,     '[]', '[]',         NULL, 'class', 'Greeter');

INSERT INTO local_scopes (id, symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES
    (6,  3,  'function', 5, 9,   '[{"name":"x","line":5,"column":24}]', '[]'),
    (13, 12, 'method',   14, 17, '[]', '[{"name":"msg","line":15,"column":8}]');

INSERT INTO injections (id, file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES
    (6, 'src/beta.ts', 'typescript', 'sql', 10, 12, 200, 260);

INSERT INTO versions (id, symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES
    (11, 'greet', 'src/alpha.ts', 'function greet(x) { return x; }', 'polaris-seed-session', 1700000002000, 5, 'th-greet-v1');

INSERT INTO patterns (id, name, edit_body, symbol_kind, created_at) VALUES
    (2, 'polaris-pattern', 'return null;', 'function', 1700000003000);

INSERT INTO project_roots (root_path, name, created_at) VALUES
    ('/tmp/polaris-seed-root', 'polaris-seed', 1700000004000);
