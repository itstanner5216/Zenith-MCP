-- polaris-v4-schema.sql — POLARIS Task 0.2 seeded schema-v4 database.
--
-- PROVENANCE / DRIFT CONTRACT
-- ---------------------------
-- The DDL below is a character-for-character REPLAY of every statement the
-- full `initSymbolSchema` ladder (src/core/db-adapter.ts) executes on a fresh
-- database, through v4. Column order and sqlite_master stored text therefore
-- match a real init exactly (base CREATEs, then the same ALTERs, same order,
-- same statement text). polaris-schema-migration.test.js asserts this
-- fixture's physical schema is deep-equal to a database initialized by the
-- REAL `initSymbolSchema`; ladder drift in db-adapter.ts fails that gate
-- loudly. Do not reformat the DDL — byte fidelity IS the fixture.
--
-- The ladder's data backfills (UPDATE imports SET start_line…, UPDATE edges
-- SET reference_kind…, UPDATE files SET hash = NULL) are intentionally not
-- replayed: they are no-ops on the empty tables at DDL time, and the seed
-- rows below are inserted as a live v4 database would hold them (already
-- reindexed after migration: real hashes, spans, kinds, end_lines populated).
--
-- Seed rows are meaningful and FK-consistent, with NONCONTIGUOUS IDs.
-- v4-specific facts covered: edges.reference_kind ('call' and 'unknown'),
-- one resolved and two unresolved callees, anchors.end_line (a multi-line
-- branch anchor), imports start_line/end_line (one multiline cluster), and
-- import_bindings rows (named / namespace / type-only variants).

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

-- --- v1 → v2 ladder step (verbatim) ----------------------------------------
            CREATE TABLE IF NOT EXISTS import_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT REFERENCES files(path) ON DELETE CASCADE,
                source TEXT NOT NULL,
                local_name TEXT NOT NULL,
                imported_name TEXT,
                import_kind TEXT NOT NULL,
                is_type_only INTEGER NOT NULL,
                line INTEGER NOT NULL,
                column INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_import_bindings_file ON import_bindings(file_path);
            CREATE INDEX IF NOT EXISTS idx_import_bindings_local ON import_bindings(file_path, local_name);

-- --- v2 → v3 ladder step (verbatim ALTERs) ---------------------------------
ALTER TABLE imports ADD COLUMN start_line INTEGER;
ALTER TABLE imports ADD COLUMN end_line INTEGER;

-- --- v3 → v4 ladder step (verbatim ALTERs) ---------------------------------
ALTER TABLE edges ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE anchors ADD COLUMN end_line INTEGER;
INSERT INTO schema_version (id, version) VALUES (1, 4) ON CONFLICT(id) DO UPDATE SET version = excluded.version;

-- --- seed rows (noncontiguous IDs, FK-valid, v4-complete facts) ------------
INSERT INTO files (path, hash, last_indexed) VALUES
    ('src/alpha.ts', '0b9c2625dc21ef05f6ad4ddf47c5f203', 1710000000000),
    ('src/beta.ts',  '5d41402abc4b2a76b9719d911017c592', 1710000001000);

INSERT INTO symbols (id, name, kind, type, file_path, line, end_line, column, capture_tag, body_hash, parent_symbol_id, visibility) VALUES
    (3,  'greet',     'def', 'function', 'src/alpha.ts', 5, 9,  9,  'definition.function', 'bh-greet-v4',     NULL, 'public'),
    (7,  'Greeter',   'def', 'class',    'src/alpha.ts', 12, 20, 6, 'definition.class',    'bh-greeter-v4',   NULL, 'public'),
    (12, 'greetLoud', 'def', 'method',   'src/alpha.ts', 14, 17, 4, 'definition.method',   'bh-greetloud-v4', 7,    NULL),
    (15, 'betaFn',    'ref', 'call',     'src/alpha.ts', 8, 8,  11, 'reference.call',      NULL,              NULL, NULL),
    (22, 'betaFn',    'def', 'function', 'src/beta.ts',  3, 6,  16, 'definition.function', 'bh-betafn-v4',    NULL, 'public'),
    (30, 'greet',     'ref', 'call',     'src/beta.ts',  5, 5,  2,  'reference.call',      NULL,              NULL, NULL);

INSERT INTO edges (id, container_def_id, referenced_name, callee_symbol_id, reference_kind) VALUES
    (2,  3,  'betaFn',    22,   'call'),
    (9,  12, 'greet',     NULL, 'call'),
    (14, 22, 'missingFn', NULL, 'unknown');

INSERT INTO anchors (id, symbol_id, kind, line, text, end_line) VALUES
    (5,  3,  'return', 8,  '    return betaFn(x);', 8),
    (11, 12, 'branch', 15, '        if (loud) {',   17);

INSERT INTO imports (id, file_path, module, imported_names_json, line, start_line, end_line) VALUES
    (4, 'src/alpha.ts', './beta',    '["betaFn","BetaOptions"]', 2, 2, 4),
    (8, 'src/beta.ts',  'node:util', '["format"]',               1, 1, 1);

INSERT INTO import_bindings (id, file_path, source, local_name, imported_name, import_kind, is_type_only, line, column) VALUES
    (4,  'src/alpha.ts', './beta',    'betaFn',      'betaFn',      'named',     0, 2, 9),
    (9,  'src/alpha.ts', './beta',    'BetaOptions', 'BetaOptions', 'named',     1, 3, 4),
    (16, 'src/beta.ts',  'node:util', 'util',        NULL,          'namespace', 0, 1, 12);

INSERT INTO symbol_structures (symbol_id, params_json, return_text, decorators_json, modifiers_json, generics_text, parent_kind, parent_name) VALUES
    (3,  '["x"]',           'string', '[]', '["export"]', NULL, NULL,    NULL),
    (12, '["name","loud"]', NULL,     '[]', '[]',         NULL, 'class', 'Greeter');

INSERT INTO local_scopes (id, symbol_id, scope_kind, start_line, end_line, parameters_json, locals_json) VALUES
    (6,  3,  'function', 5, 9,   '[{"name":"x","line":5,"column":24}]', '[]'),
    (13, 12, 'method',   14, 17, '[]', '[{"name":"msg","line":15,"column":8}]');

INSERT INTO injections (id, file_path, host_lang, injected_lang, start_line, end_line, start_byte, end_byte) VALUES
    (6, 'src/beta.ts', 'typescript', 'sql', 10, 12, 200, 260);

INSERT INTO versions (id, symbol_name, file_path, original_text, session_id, created_at, line, text_hash) VALUES
    (11, 'greet', 'src/alpha.ts', 'function greet(x: string): string { return x; }', 'polaris-seed-session', 1710000002000, 5, 'th-greet-v4');

INSERT INTO patterns (id, name, edit_body, symbol_kind, created_at) VALUES
    (2, 'polaris-pattern', 'return null;', 'function', 1710000003000);

INSERT INTO project_roots (root_path, name, created_at) VALUES
    ('/tmp/polaris-seed-root', 'polaris-seed', 1710000004000);
