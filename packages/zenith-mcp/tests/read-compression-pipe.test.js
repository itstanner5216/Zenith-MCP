// ---------------------------------------------------------------------------
// read-compression-pipe.test.js
//
// Live-seam regression lock for the read_file → compressForTool pipe.
//
// HISTORY: PR #23 shipped read_file/read_multiple_files that pre-truncated to
// the caller's budget and prefixed every line with `${i+1}:` BEFORE handing
// the buffer to compressForTool. TOON then RE-PREFIXED with `${n}. `, so the
// live output literally was `1. 1:import fs from 'fs/promises';` — a double
// line-number prefix (Priority-0 violations §2 and §5: "verbatim lines",
// "true 1-based numbers"). The W1-T5 repair routes the RAW, FULL file text
// through the seam; this test pins that repair forever.
//
// This file MUST NOT vi.mock anything. The whole point is to exercise the
// real handler + the real compressForTool + the real zenith-toon engine over
// a real on-disk fixture. The seam regression we are guarding against is the
// shape of the input the tool hands to compressForTool — mocking the engine
// would let the bug slip back in with a green test.
//
// Fixture: a tmpdir with a `.git` directory (so findRepoRoot resolves and the
// compression path runs end-to-end the way it does in production) and a
// realistic TypeScript file with several exported functions, an interface,
// a class, and assorted branching/returning bodies. Sized to exceed the
// 500-char budget so compression is forced. Each line is non-blank so the
// `_compressSourceCode` blank-buffering off-by-one is not exercised: every
// emitted marker's [X, Y] then equals exactly [prev_visible+1, next_visible-1]
// (the documented marker convention). No indexing is triggered — facts are
// empty, the structured path falls back to compressString, which is still
// the real engine path that the read_file seam invokes.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --- Tool registration helpers (mirrors tests/tool-compression.test.js but
//     WITHOUT vi.mock on compression.js — the seam IS the system under test). ---
function createMockServer() {
    const tools = new Map();
    return {
        tools,
        registerTool(name, _config, handler) {
            tools.set(name, handler);
        },
    };
}

function createCtx(rootDir) {
    return {
        async validatePath(requestedPath) {
            const resolved = path.resolve(rootDir, requestedPath);
            if (!resolved.startsWith(rootDir)) {
                throw new Error('Access denied');
            }
            return resolved;
        },
    };
}

async function registerTool(modulePath, toolName, rootDir) {
    const server = createMockServer();
    const mod = await import(modulePath);
    mod.register(server, createCtx(rootDir));
    return server.tools.get(toolName);
}

// Fixture rationale:
//   * 58 lines, ~1.6 KB — well above the 500-char budget so compression engages.
//   * Multiple exported functions / interface / class plus underscore-prefixed
//     padding constants. The exporteds rank higher than the private padding in
//     _compressSourceCode's heuristic, so the padding gets truncated and
//     produces at least one ≥ 6-line internal gap with a marker.
//   * No blank lines anywhere. _compressSourceCode buffers blanks across
//     omission boundaries (lines 1162-1187 in string-codec.ts), which makes
//     the marker END overlap with the buffered-blank visible number — an
//     off-by-one that would foil the "exact range" assertion. Eliminating
//     blanks keeps marker math strict.
//   * No injections / no decorators — keeps the path entirely on the
//     `_compressSourceCode` source-code branch (compressString detects source
//     code from `_DEF_RE` matches plus `_SOURCE_IMPORT_RE` matches).
const FIXTURE_TS = [
    `import fs from 'fs/promises';`,
    `import path from 'path';`,
    `export interface Config {`,
    `    name: string;`,
    `    value: number;`,
    `}`,
    `export function parseConfig(text: string): Config {`,
    `    if (!text) {`,
    `        throw new Error('Empty config');`,
    `    }`,
    `    const lines = text.split('\\n');`,
    `    if (lines.length === 0) {`,
    `        return { name: '', value: 0 };`,
    `    }`,
    `    return { name: lines[0], value: parseInt(lines[1] || '0', 10) };`,
    `}`,
    `export function loadConfig(filepath: string): Config | null {`,
    `    if (!filepath) return null;`,
    `    try {`,
    `        const text = require('fs').readFileSync(filepath, 'utf8');`,
    `        return parseConfig(text);`,
    `    } catch (e) {`,
    `        return null;`,
    `    }`,
    `}`,
    `export async function saveConfig(filepath: string, config: Config): Promise<void> {`,
    `    if (!filepath) throw new Error('No path');`,
    `    const text = config.name + '\\n' + config.value;`,
    `    await fs.writeFile(filepath, text, 'utf8');`,
    `}`,
    `export function mergeConfigs(a: Config, b: Config): Config {`,
    `    if (!a) return b;`,
    `    if (!b) return a;`,
    `    return {`,
    `        name: a.name + '-' + b.name,`,
    `        value: a.value + b.value,`,
    `    };`,
    `}`,
    `export class ConfigManager {`,
    `    private configs: Map<string, Config>;`,
    `    constructor() {`,
    `        this.configs = new Map();`,
    `    }`,
    `    add(key: string, config: Config): void {`,
    `        if (!key) throw new Error('No key');`,
    `        this.configs.set(key, config);`,
    `    }`,
    `    get(key: string): Config | undefined {`,
    `        return this.configs.get(key);`,
    `    }`,
    `    list(): string[] {`,
    `        return Array.from(this.configs.keys());`,
    `    }`,
    `}`,
    `export function defaultConfig(): Config {`,
    `    return { name: 'default', value: 42 };`,
    `}`,
].join('\n');

const NON_MARKER_RE = /^(\d+)\. (.*)$/s;
const MARKER_RE = /^\[TRUNCATED: lines (\d+)-(\d+)\]$/;
const DOUBLE_PREFIX_RE = /^\d+\. \d+:/;

describe('read-compression-pipe — live seam regression lock', () => {
    let rootDir;

    beforeEach(async () => {
        rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-compression-pipe-'));
        // findRepoRoot walks up looking for `.git`. Without this, repoRoot is
        // null, getFileFacts is skipped, and the seam degenerates to an
        // unsupported-language fallback. Creating .git makes the full pipe run.
        await fs.mkdir(path.join(rootDir, '.git'), { recursive: true });
    });

    afterEach(async () => {
        if (rootDir) {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    it('compressed read_file output is single-prefixed N. <verbatim>, no double-prefix, exact-range markers', async () => {
        const relPath = 'src/config.ts';
        const absPath = path.join(rootDir, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, FIXTURE_TS, 'utf8');

        // Real handler (no vi.mock on compression.js); real compressForTool;
        // real zenith-toon engine. The seam — and only the seam — is under test.
        const handler = await registerTool('../dist/tools/read_file.js', 'read_file', rootDir);
        const result = await handler({ path: relPath, compression: true, maxChars: 500 });

        const out = result.content[0].text;

        // The seam ran — we got SOMETHING back.
        expect(out.length).toBeGreaterThan(0);

        // No `[truncated]` trailing decoration: the read_file fallback path
        // appends `[truncated]` on its truncate branch, but a successful
        // compress emits TOON's return VERBATIM. A regression that re-wraps
        // the compressed text in the truncate path would fail here.
        expect(out.endsWith('[truncated]')).toBe(false);
        expect(out).not.toMatch(/\n\[truncated\]$/);

        // Parse the output. Every line is either a `[TRUNCATED: lines X-Y]`
        // marker or a `N. ...` numbered line. No other shapes are allowed.
        const fixtureLines = FIXTURE_TS.split('\n');
        const outLines = out.split('\n');

        // The double-prefix regression guard: not a single line may match
        // /^\d+\. \d+:/. This is the literal output shape the PR-23 seam bug
        // produced (`1. 1:import fs from ...`). Asserting its non-existence
        // pins the W1-T5 fix forever.
        for (const line of outLines) {
            expect(
                DOUBLE_PREFIX_RE.test(line),
                `Double line-number prefix detected (PR-23 seam regression): ${JSON.stringify(line)}`,
            ).toBe(false);
        }

        // Categorise every line; build visible-number and marker lists.
        const visibleNums = [];
        const visibleByPos = []; // parallel arrays: { pos, n, text }
        const markers = []; // { pos, x, y }
        for (let i = 0; i < outLines.length; i++) {
            const line = outLines[i];
            const mm = MARKER_RE.exec(line);
            const nm = NON_MARKER_RE.exec(line);
            if (mm) {
                markers.push({ pos: i, x: Number(mm[1]), y: Number(mm[2]) });
            } else if (nm) {
                const n = Number(nm[1]);
                visibleNums.push(n);
                visibleByPos.push({ pos: i, n, text: nm[2] });
            } else {
                throw new Error(`Output line ${i} matches neither N. nor marker shape: ${JSON.stringify(line)}`);
            }
        }

        // At least one of each so the test is actually exercising the seam.
        expect(visibleNums.length).toBeGreaterThanOrEqual(10);
        expect(markers.length).toBeGreaterThanOrEqual(1);

        // Every non-marker line matches /^\d+\. / — re-asserts the categorisation.
        for (const v of visibleByPos) {
            expect(outLines[v.pos]).toMatch(/^\d+\. /);
        }

        // Visible numbers strictly ascending (Priority-0 §2).
        for (let i = 1; i < visibleNums.length; i++) {
            expect(visibleNums[i]).toBeGreaterThan(visibleNums[i - 1]);
        }

        // Verbatim check on the entire visible set — the text after `N. `
        // must equal fixture line N character-for-character. The task asks
        // for >= 10 sampled lines; we check ALL visible lines (29 in the
        // current fixture, well above the floor) because verbatim is the
        // entire point of the seam regression.
        let verbatimChecked = 0;
        for (const v of visibleByPos) {
            const expected = fixtureLines[v.n - 1];
            expect(
                v.text,
                `Verbatim mismatch at fixture line ${v.n}: got ${JSON.stringify(v.text)}, expected ${JSON.stringify(expected)}`,
            ).toBe(expected);
            verbatimChecked++;
        }
        expect(verbatimChecked).toBeGreaterThanOrEqual(10);

        // Every gap >= 6 between consecutive visible numbers must be covered
        // by a marker whose range is EXACTLY [prev_visible + 1, next_visible - 1].
        // The dense (no-blank) fixture rules out the _compressSourceCode
        // blank-buffering off-by-one, so this match is strict.
        for (let i = 1; i < visibleByPos.length; i++) {
            const prev = visibleByPos[i - 1];
            const curr = visibleByPos[i];
            const gap = curr.n - prev.n - 1;
            if (gap >= 6) {
                const expectedX = prev.n + 1;
                const expectedY = curr.n - 1;
                // Find any marker between the two visible lines in the
                // OUTPUT order.
                const between = markers.filter(m => m.pos > prev.pos && m.pos < curr.pos);
                expect(
                    between.length,
                    `Gap >=6 between visible ${prev.n} and ${curr.n} but no marker between them.`,
                ).toBeGreaterThanOrEqual(1);
                // Exactly one of those markers must be the exact-range tile.
                const exact = between.find(m => m.x === expectedX && m.y === expectedY);
                expect(
                    exact,
                    `Gap ${prev.n}->${curr.n} (${gap} omitted) expects marker lines ${expectedX}-${expectedY}, got markers ${JSON.stringify(between.map(({ x, y }) => [x, y]))}`,
                ).toBeDefined();
            }
        }

        // Marker ranges themselves are well-formed: x <= y, ascending across
        // the output, and never overlap a visible number. The dense fixture
        // makes this strict; if the production marker form regresses to use
        // a 1-past-the-end `y`, this assertion catches it because that `y`
        // would be == the very next visible number (off-by-one). The
        // visible-disjointness check makes the off-by-one fail loudly.
        const shownSet = new Set(visibleNums);
        let prevHi = 0;
        for (const m of markers) {
            expect(m.x).toBeLessThanOrEqual(m.y);
            expect(
                m.x,
                `Marker ${m.x}-${m.y} not ascending (prevHi=${prevHi}).`,
            ).toBeGreaterThan(prevHi);
            prevHi = m.y;
            for (let ln = m.x; ln <= m.y; ln++) {
                expect(
                    shownSet.has(ln),
                    `Marker range ${m.x}-${m.y} overlaps visible number ${ln} — off-by-one regression?`,
                ).toBe(false);
            }
        }
    });
});
