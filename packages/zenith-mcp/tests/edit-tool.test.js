import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// edit tool — adversarial suite.
//
// The claims under test, from the tool's contract:
//   - all line numbers in one call are ORIGINAL-file-relative, exactly
//   - content matching is whitespace/indent forgiving but never mis-targets
//   - matching is pure string ops — no character class breaks it
//   - the return strings are verbatim and "detected" is only emitted after a
//     parse actually ran
//   - permissions survive edits; no temp litter on any path; CRLF/lone-CR/BOM
//     survive edits
//   - every write is preceded by per-edit patch snapshots (exact oldText,
//     exact applied newText, original start line), capped at the 10 most
//     recent per session/file
//   - syntax breakage never gates a write; the only hard failures are
//     missing/unwritable files and genuinely unlocatable targets
// ---------------------------------------------------------------------------

const CLEAN = 'Edit applied successfully, no parsing errors detected.';
const BARE = 'Edit applied successfully.';
const STATE2_RE = /^Edit applied successfully\. A parsing error was detected at line \d+, .+\.$/;

function mkTmpGitRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

function captureHandler() {
    const calls = [];
    const server = {
        registerTool: (name, schema, handler) => {
            calls.push({ name, schema, handler });
        },
    };
    return { server, calls };
}

function mkCtx(repoDir) {
    return {
        validatePath: async (p) => path.resolve(p),
        getAllowedDirectories: () => [repoDir],
        sessionId: 'test-session',
    };
}

function tmpLitter(dir) {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

const toolMod = await import('../dist/tools/edit.js');
const symbolIndex = await import('../dist/core/symbol-index.js');
const dbAdapter = await import('../dist/core/db-adapter.js');

function mkHandler(repoDir) {
    const { server, calls } = captureHandler();
    toolMod.register(server, mkCtx(repoDir));
    return calls[0].handler;
}

let repoDir;
let handler;

beforeEach(() => {
    repoDir = mkTmpGitRepo();
    handler = mkHandler(repoDir);
});

afterEach(() => {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkFile(name, content) {
    const p = path.join(repoDir, name);
    fs.writeFileSync(p, content);
    return p;
}

async function run(filePath, edits) {
    const result = await handler({ path: filePath, edits });
    return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Registration & schema
// ---------------------------------------------------------------------------

describe('registration', () => {
    it('registers as "edit" with a one-line description and strict schemas', () => {
        const { server, calls } = captureHandler();
        toolMod.register(server, mkCtx('/tmp'));
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('edit');
        expect(calls[0].schema.description).toBe('Edit file lines or content.');
        const json = calls[0].schema.inputSchema.toJSONSchema();
        expect(json.additionalProperties).toBe(false);
        expect(Object.keys(json.properties).sort()).toEqual(['edits', 'path']);
        const item = json.properties.edits.items;
        expect(item.additionalProperties).toBe(false);
        expect(Object.keys(item.properties).sort()).toEqual(
            ['endLine', 'newContent', 'oldContent', 'path', 'startLine']);
        // the search field is oldContent — deliberately not oldText/oldString
        expect(item.properties.oldText).toBeUndefined();
        expect(item.properties.oldString).toBeUndefined();
        expect(item.required).toEqual(['newContent']);
        expect(json.properties.edits.minItems).toBe(1);
        // there is intentionally no dryRun / preview / mode parameter
        expect(json.properties.dryRun).toBeUndefined();
        expect(json.properties.mode).toBeUndefined();
        expect(calls[0].schema.annotations).toEqual({
            readOnlyHint: false, idempotentHint: false, destructiveHint: true,
        });
    });
});

// ---------------------------------------------------------------------------
// Line-mapping proofs: everything is original-file-relative
// ---------------------------------------------------------------------------

describe('line mapping — original-file-relative, proven on final bytes', () => {
    const TEN = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10';

    it('growing edit does not shift a later edit below it', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 2, endLine: 3, newContent: 'R1\nR2\nR3\nR4\nR5' },
            { startLine: 8, endLine: 9, newContent: 'X' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('l1\nR1\nR2\nR3\nR4\nR5\nl4\nl5\nl6\nl7\nX\nl10');
    });

    it('shrinking edit does not shift a later edit below it', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 2, endLine: 5, newContent: 'S' },
            { startLine: 8, endLine: 8, newContent: 'Y' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('l1\nS\nl6\nl7\nY\nl9\nl10');
    });

    it('edits given in reverse file order land identically', async () => {
        const p = mkFile('a.txt', TEN);
        const q = mkFile('b.txt', TEN);
        await run(p, [
            { startLine: 2, endLine: 3, newContent: 'R1\nR2\nR3' },
            { startLine: 8, endLine: 9, newContent: 'X' },
        ]);
        await run(q, [
            { startLine: 8, endLine: 9, newContent: 'X' },
            { startLine: 2, endLine: 3, newContent: 'R1\nR2\nR3' },
        ]);
        expect(fs.readFileSync(q, 'utf-8')).toBe(fs.readFileSync(p, 'utf-8'));
    });

    it('adjacent ranges apply exactly with no gap or overlap', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 3, endLine: 4, newContent: 'A' },
            { startLine: 5, endLine: 6, newContent: 'B' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('l1\nl2\nA\nB\nl7\nl8\nl9\nl10');
    });

    it('three mixed grow/shrink edits resolve exactly', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 1, endLine: 1, newContent: 'H1\nH2' },
            { startLine: 4, endLine: 6, newContent: 'M' },
            { startLine: 9, endLine: 10, newContent: 'T1\nT2\nT3' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('H1\nH2\nl2\nl3\nM\nl7\nl8\nT1\nT2\nT3');
    });

    it('overlapping ranges fail only the later edit, naming the earlier one', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 2, endLine: 5, newContent: 'P' },
            { startLine: 4, endLine: 6, newContent: 'Q' },
        ]);
        expect(text).toBe(`#2: Overlaps edit #1.\n${BARE}`);
        expect(fs.readFileSync(p, 'utf-8')).toBe('l1\nP\nl6\nl7\nl8\nl9\nl10');
    });

    it('a content edit below a growing line edit matches original coordinates', async () => {
        const p = mkFile('a.txt', TEN);
        const text = await run(p, [
            { startLine: 2, endLine: 2, newContent: 'g1\ng2\ng3\ng4' },
            { oldContent: 'l9', newContent: 'NINE' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('l1\ng1\ng2\ng3\ng4\nl3\nl4\nl5\nl6\nl7\nl8\nNINE\nl10');
    });

    it('two edits with identical oldContent progress through the file in order', async () => {
        const p = mkFile('a.txt', 'x\nsame\ny\nsame\nz');
        const text = await run(p, [
            { oldContent: 'same', newContent: 'FIRST' },
            { oldContent: 'same', newContent: 'SECOND' },
        ]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('x\nFIRST\ny\nSECOND\nz');
    });
});

// ---------------------------------------------------------------------------
// Range semantics & forgiveness
// ---------------------------------------------------------------------------

describe('line-range semantics', () => {
    it('clamps an endLine that overshoots the file', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\nd\ne');
        const text = await run(p, [{ startLine: 4, endLine: 999, newContent: 'TAIL' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\nc\nTAIL');
    });

    it('clamps startLine 0 to line 1', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        await run(p, [{ startLine: 0, endLine: 2, newContent: 'X' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('X\nc');
    });

    it('accepts a swapped range', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\nd\ne');
        await run(p, [{ startLine: 4, endLine: 2, newContent: 'X' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nX\ne');
    });

    it('treats one trailing newline in newContent as convention, not a blank line', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const q = mkFile('b.txt', 'a\nb\nc');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'B\n' }]);
        await run(q, [{ startLine: 2, endLine: 2, newContent: 'B' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe(fs.readFileSync(q, 'utf-8'));
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nB\nc');
    });

    it('empty newContent deletes the lines outright', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\nd');
        await run(p, [{ startLine: 2, endLine: 3, newContent: '' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nd');
    });

    it('deletes the last line without leaving a blank', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        await run(p, [{ startLine: 3, endLine: 3, newContent: '' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb');
    });

    it('deletes every line down to an empty file', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        await run(p, [{ startLine: 1, endLine: 3, newContent: '' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('');
    });

    it('a lone "\\n" newContent blanks the lines instead of deleting them', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        await run(p, [{ startLine: 2, endLine: 2, newContent: '\n' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\n\nc');
    });

    it('edits an empty file', async () => {
        const p = mkFile('a.txt', '');
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'hello' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('hello');
    });

    it('preserves a trailing newline through a mid-file edit', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\n');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'B' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nB\nc\n');
    });
});

// ---------------------------------------------------------------------------
// Content matching — forgiveness that never mis-targets
// ---------------------------------------------------------------------------

describe('content matching forgiveness', () => {
    it('matches when the file has trailing whitespace oldContent lacks', async () => {
        const p = mkFile('a.txt', 'one\n    keep me;   \nthree');
        const text = await run(p, [{ oldContent: '    keep me;', newContent: '    kept;' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('one\n    kept;\nthree');
    });

    it('matches when oldContent has trailing whitespace the file lacks', async () => {
        const p = mkFile('a.txt', 'one\n    keep me;\nthree');
        await run(p, [{ oldContent: '    keep me;   ', newContent: '    kept;' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('one\n    kept;\nthree');
    });

    it('matches a block pasted one indent level off and re-indents newContent to the target', async () => {
        const p = mkFile('a.txt', 'top\n        if (x) {\n            work();\n        }\nbottom');
        const text = await run(p, [{
            oldContent: '    if (x) {\n        work();\n    }',
            newContent: '    if (y) {\n        moreWork();\n    }',
        }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n        if (y) {\n            moreWork();\n        }\nbottom');
    });

    it('re-indents with the target\'s tabs, never blindly emitting spaces', async () => {
        const p = mkFile('a.txt', 'top\n\t\tdo_thing()\nbottom');
        await run(p, [{ oldContent: 'do_thing()', newContent: 'do_other()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n\t\tdo_other()\nbottom');
    });

    it('re-indents a flush-left multi-line paste into a tab-indented target, preserving relative depth', async () => {
        const p = mkFile('a.txt', 'top\n\tstart\n\t\tinner\n\tend\nbottom');
        await run(p, [{
            oldContent: 'start\n\tinner\nend',
            newContent: 'begin\n\tdeep\nfinish',
        }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n\tbegin\n\t\tdeep\n\tfinish\nbottom');
    });

    it('never matches the wrong of two near-identical blocks: equidistant shifts report not-found', async () => {
        const original = '  block()\n  done()\nmid\n      block()\n      done()';
        const p = mkFile('a.txt', original);
        // oldContent sits exactly between the two blocks' indents (delta -2 vs +2)
        const text = await run(p, [{ oldContent: '    block()\n    done()', newContent: '    other()' }]);
        expect(text).toBe('oldContent not found.');
        expect(fs.readFileSync(p, 'utf-8')).toBe(original);
    });

    it('an exact-indent match wins over a near-identical block at another depth', async () => {
        const p = mkFile('a.txt', '  block()\nmid\n      block()');
        await run(p, [{ oldContent: '      block()', newContent: '      hit()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('  block()\nmid\n      hit()');
    });

    it('the nearest shift wins when two shifted candidates differ in distance', async () => {
        const p = mkFile('a.txt', '    block()\nmid\n            block()');
        await run(p, [{ oldContent: 'block()', newContent: 'hit()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('    hit()\nmid\n            block()');
    });

    it('a shifted match preserves the block\'s internal relative indentation requirement', async () => {
        // the candidate block's second line does NOT carry the same relative
        // indent as oldContent's — the tolerant tier must refuse it
        const original = '    a()\n  b()';
        const p = mkFile('a.txt', original);
        const text = await run(p, [{ oldContent: 'a()\n    b()', newContent: 'x()' }]);
        expect(text).toBe('oldContent not found.');
        expect(fs.readFileSync(p, 'utf-8')).toBe(original);
    });

    it('mid-line exact matches replace inline without indent games', async () => {
        const p = mkFile('a.txt', 'const x = compute(1, 2) + 5;');
        await run(p, [{ oldContent: 'compute(1, 2)', newContent: 'compute(3, 4)' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('const x = compute(3, 4) + 5;');
    });

    it('line-range replacement text pasted flush-left is re-indented to the target lines', async () => {
        const p = mkFile('a.txt', 'top\n        old();\nbottom');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'new1();\nnew2();' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n        new1();\n        new2();\nbottom');
    });

    it('line-range replacement keeps intentional deeper structure while fitting the base', async () => {
        const p = mkFile('a.txt', 'top\n    body();\nbottom');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'if (x) {\n    body();\n}' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n    if (x) {\n        body();\n    }\nbottom');
    });

    it('does not alter newContent it cannot shift uniformly', async () => {
        const p = mkFile('a.txt', 'top\n    old();\nbottom');
        // second line is shallower than the first — no uniform base to shift
        await run(p, [{ startLine: 2, endLine: 2, newContent: '    deep();\nshallow();' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n    deep();\nshallow();\nbottom');
    });
});

// ---------------------------------------------------------------------------
// Character safety — content is never a pattern
// ---------------------------------------------------------------------------

describe('whitespace-intent edits — fit forgiveness must never neutralize a deliberate indent fix', () => {
    it('tab→spaces indent fix via line-range applies, not silently no-ops', async () => {
        const p = mkFile('a.txt', '\tfoo()\n');
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: '    foo()' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('    foo()\n');
    });

    it('deepening an indent via line-range applies (the Python indent-fix case)', async () => {
        const p = mkFile('a.txt', 'if (x)\n    foo()\n');
        await run(p, [{ startLine: 2, endLine: 2, newContent: '        foo()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('if (x)\n        foo()\n');
    });

    it('a multi-line pure re-indent via line-range applies', async () => {
        const p = mkFile('a.txt', 'def f():\n  a()\n  b()\n');
        await run(p, [{ startLine: 2, endLine: 3, newContent: '    a()\n    b()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('def f():\n    a()\n    b()\n');
    });

    it('an indent fix via content mode applies', async () => {
        const p = mkFile('a.txt', '\tfoo()\nbar\n');
        await run(p, [{ oldContent: '\tfoo()', newContent: '    foo()' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('    foo()\nbar\n');
    });

    it('flush-left newContent still gets fit forgiveness (wrong-depth paste, not a dedent)', async () => {
        const p = mkFile('a.txt', 'top\n        old();\nbottom\n');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'new1();\nnew2();' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n        new1();\n        new2();\nbottom\n');
    });
});

describe('trailing-newline convention — content mode mirrors the line-range rule', () => {
    it('oldContent with one trailing newline never joins the next line', async () => {
        const p = mkFile('a.txt', 'a\nfoo();\nbar\n');
        await run(p, [{ oldContent: 'foo();\n', newContent: 'kept();' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nkept();\nbar\n');
    });

    it('newContent with one trailing newline never inserts a stray blank line', async () => {
        const p = mkFile('a.txt', 'a\nfoo();\nbar\n');
        await run(p, [{ oldContent: 'foo();', newContent: 'kept();\n' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nkept();\nbar\n');
    });

    it('CRLF file: trailing-CRLF newContent stays convention, endings preserved', async () => {
        const p = mkFile('a.txt', 'a\r\nfoo();\r\nbar\r\n');
        await run(p, [{ oldContent: 'foo();', newContent: 'kept();\r\n' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\r\nkept();\r\nbar\r\n');
    });

    it('whole-file oldContent including trailing newline preserves the final newline', async () => {
        const p = mkFile('a.txt', 'only line\n');
        await run(p, [{ oldContent: 'only line\n', newContent: 'replaced' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('replaced\n');
    });

    it('a lone "\\n" oldContent still means a blank line, not a stripped copy', async () => {
        const p = mkFile('a.txt', 'a\n\nb\n');
        await run(p, [{ oldContent: '\n', newContent: 'mid' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nmid\nb\n');
    });
});

describe('tab↔space style boundary (tier 4) — unique matches only', () => {
    it('space-indented multi-line oldContent matches a tab-indented block and lands in tabs', async () => {
        const p = mkFile('a.txt', 'top\n\tif (x) {\n\t\twork();\n\t}\nbottom\n');
        const text = await run(p, [{
            oldContent: '    if (x) {\n        work();\n    }',
            newContent: '    if (y) {\n        moreWork();\n    }',
        }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n\tif (y) {\n\t\tmoreWork();\n\t}\nbottom\n');
    });

    it('tab-indented oldContent matches a space-indented block and lands in spaces', async () => {
        const p = mkFile('a.txt', 'top\n    if (x) {\n        work();\n    }\nbottom\n');
        await run(p, [{
            oldContent: '\tif (x) {\n\t\twork();\n\t}',
            newContent: '\tif (y) {\n\t\tmoreWork();\n\t}',
        }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('top\n    if (y) {\n        moreWork();\n    }\nbottom\n');
    });

    it('two style-agnostic candidates are ambiguous — not-found, file untouched', async () => {
        // Two identical tab-indented multi-level blocks; a space-indented
        // oldContent could map onto either — tier 4 must refuse both.
        const original = '\tif (x) {\n\t\twork();\n\t}\nmid\n\tif (x) {\n\t\twork();\n\t}\n';
        const p = mkFile('a.txt', original);
        const text = await run(p, [{
            oldContent: '    if (x) {\n        work();\n    }',
            newContent: '    if (y) {\n        moreWork();\n    }',
        }]);
        expect(text).toBe('oldContent not found.');
        expect(fs.readFileSync(p, 'utf-8')).toBe(original);
    });

    it('a block whose relative depth disagrees is refused across the style boundary', async () => {
        const original = '\ta()\n\tb()\n'; // same depth in file
        const p = mkFile('a.txt', original);
        // oldContent claims b() is deeper than a() — structure mismatch → refuse
        const text = await run(p, [{ oldContent: '    a()\n        b()', newContent: 'x()' }]);
        expect(text).toBe('oldContent not found.');
        expect(fs.readFileSync(p, 'utf-8')).toBe(original);
    });

    it('newContent lines deeper than any oldContent level keep their extra depth after the mapped base', async () => {
        const p = mkFile('a.txt', '\tstart\n\tend\n');
        await run(p, [{
            oldContent: '    start\n    end',
            newContent: '    start\n        inner\n    end',
        }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('\tstart\n\t    inner\n\tend\n');
    });
});

describe('character safety', () => {
    const CASES = [
        ['regex metacharacters', 'if (/^a.*b+c?$/.test(s)) { return [1]; } | ^ \\', 'REPLACED'],
        ['backslashes', 'const p = "C:\\\\Users\\\\name\\\\file";', 'const p = "/tmp";'],
        ['quote soup', `const s = 'single' + "double" + \`back\${tick}\`;`, `const s = 'ok';`],
        ['template syntax', 'const t = `${a}${b || `${c}`}`;', 'const t = `${z}`;'],
        ['unicode', 'const msg = "héllo 🚀 世界 — ñ";', 'const msg = "ok";'],
        ['payload-header lookalike', 'identifier 123', 'other 456'],
    ];

    for (const [label, oldContent, newContent] of CASES) {
        it(`replaces ${label} literally`, async () => {
            const p = mkFile('a.txt', `before\n${oldContent}\nafter`);
            const text = await run(p, [{ oldContent, newContent }]);
            expect(text).toBe(BARE);
            expect(fs.readFileSync(p, 'utf-8')).toBe(`before\n${newContent}\nafter`);
        });
    }

    it('does not interpret $&, $1, $<name> in newContent as replacement patterns', async () => {
        const p = mkFile('a.txt', 'target line');
        await run(p, [{ oldContent: 'target line', newContent: 'kept $& and $1 and $<name> and $$' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('kept $& and $1 and $<name> and $$');
    });

    it('matches oldContent that itself contains $& style tokens', async () => {
        const p = mkFile('a.txt', 'echo "$@" $1 $& done');
        await run(p, [{ oldContent: 'echo "$@" $1 $& done', newContent: 'quiet' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('quiet');
    });
});

// ---------------------------------------------------------------------------
// Return contract — the 7:1 lesson, held mechanically
// ---------------------------------------------------------------------------

describe('return contract', () => {
    it('clean parse on a supported language returns exactly the detected-clean line', async () => {
        const p = mkFile('a.js', 'function foo() {\n    return 1;\n}\n');
        const text = await run(p, [{ startLine: 2, endLine: 2, newContent: '    return 2;' }]);
        expect(text).toBe(CLEAN);
    });

    it('a syntax-breaking edit reports one terse line: first error line + kind', async () => {
        const p = mkFile('a.js', 'function foo() {\n    return 1;\n}\n');
        const text = await run(p, [{ startLine: 3, endLine: 3, newContent: '' }]);
        expect(text).toMatch(STATE2_RE);
        expect(text.includes('\n')).toBe(false);
        expect(text).not.toMatch(/review|advice|check|fix|consider|file/i);
    });

    it('a file with no grammar returns exactly the bare line — no detection claim', async () => {
        const p = mkFile('notes.txt', 'hello\nworld\n');
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'HELLO' }]);
        expect(text).toBe(BARE);
        expect(text).not.toContain('detected');
    });

    it('suppressed dialects (.jsonc) make no parse claim', async () => {
        const p = mkFile('conf.jsonc', '{\n    // comment\n    "a": 1\n}\n');
        const text = await run(p, [{ oldContent: '"a": 1', newContent: '"a": 2' }]);
        expect(text).toBe(BARE);
        expect(text).not.toContain('detected');
    });

    it('success output never summarizes what changed', async () => {
        const p = mkFile('a.js', 'function foo() {\n    return 1;\n}\nfunction bar() {\n    return 2;\n}\n');
        const text = await run(p, [
            { startLine: 2, endLine: 2, newContent: '    return 10;' },
            { oldContent: '    return 2;', newContent: '    return 20;' },
        ]);
        expect(text).toBe(CLEAN);
        expect(text).not.toMatch(/\d+ edit|function|foo|bar|a\.js/);
    });
});

// ---------------------------------------------------------------------------
// Filesystem correctness
// ---------------------------------------------------------------------------

describe('filesystem', () => {
    it('preserves mode 0o600 through an edit', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        fs.chmodSync(p, 0o600);
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]);
        expect(fs.statSync(p).mode & 0o7777).toBe(0o600);
        expect(fs.readFileSync(p, 'utf-8')).toBe('A\nb\n');
    });

    it('preserves mode 0o755 through an edit', async () => {
        const p = mkFile('run.sh', '#!/bin/sh\necho hi\n');
        fs.chmodSync(p, 0o755);
        await run(p, [{ oldContent: 'echo hi', newContent: 'echo bye' }]);
        expect(fs.statSync(p).mode & 0o7777).toBe(0o755);
    });

    it('leaves zero temp files after a successful edit', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]);
        expect(tmpLitter(repoDir)).toEqual([]);
    });

    it('an unwritable file hard-fails short, unchanged, with zero temp files', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        fs.chmodSync(p, 0o444);
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]);
        expect(text).toBe('File not writable.');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\n');
        expect(tmpLitter(repoDir)).toEqual([]);
        fs.chmodSync(p, 0o644);
    });

    it('preserves CRLF line endings without corrupting content', async () => {
        const p = mkFile('a.txt', 'one\r\ntwo\r\nthree\r\n');
        const text = await run(p, [{ startLine: 2, endLine: 2, newContent: 'TWO' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('one\r\nTWO\r\nthree\r\n');
    });

    it('handles lone-\\r files as real line boundaries', async () => {
        const p = mkFile('a.txt', 'one\rtwo\rthree');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'TWO' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('one\rTWO\rthree');
    });

    it('normalizes a stray LF in a CRLF-majority file to the dominant ending', async () => {
        const p = mkFile('a.txt', 'one\r\ntwo\nthree\r\nfour\r\n');
        await run(p, [{ startLine: 4, endLine: 4, newContent: 'FOUR' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('one\r\ntwo\r\nthree\r\nFOUR\r\n');
    });

    it('matches CRLF content with an LF-normalized oldContent', async () => {
        const p = mkFile('a.txt', 'alpha\r\nbeta\r\ngamma\r\n');
        await run(p, [{ oldContent: 'beta\ngamma', newContent: 'BETA\nGAMMA' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('alpha\r\nBETA\r\nGAMMA\r\n');
    });

    it('preserves a UTF-8 BOM', async () => {
        const p = mkFile('a.txt', '\uFEFFone\ntwo\n');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'TWO' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('\uFEFFone\nTWO\n');
    });
});

// ---------------------------------------------------------------------------
// PR-review fixes — verified findings, each locked by a regression proof
// ---------------------------------------------------------------------------

describe('zero-length claims occupy their point (review #27)', () => {
    it('a blank-line content edit cannot slip inside an existing range claim', async () => {
        // Range claims [line3..line4] including the blank line; the blank-line
        // needle must NOT match at the same start and resurrect deleted text.
        const p = mkFile('a.txt', 'a\nb\n\nc\nd\n');
        const text = await run(p, [
            { startLine: 3, endLine: 4, newContent: 'X' },
            { oldContent: '\n', newContent: 'INSERTED' },
        ]);
        expect(text).toBe('#2: oldContent not found.\nEdit applied successfully.');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\nX\nd\n');
    });

    it('two blank-line edits progress to distinct blank lines', async () => {
        const p = mkFile('a.txt', 'a\n\nb\n\nc\n');
        await run(p, [
            { oldContent: '\n', newContent: 'one' },
            { oldContent: '\n', newContent: 'two' },
        ]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\none\nb\ntwo\nc\n');
    });

    it('a second blank-line edit with no blank left fails alone', async () => {
        const p = mkFile('a.txt', 'a\n\nb\n');
        const text = await run(p, [
            { oldContent: '\n', newContent: 'one' },
            { oldContent: '\n', newContent: 'two' },
        ]);
        expect(text).toBe('#2: oldContent not found.\nEdit applied successfully.');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\none\nb\n');
    });
});

describe('synthetic trailing line is not editable (review #17/#18)', () => {
    it('an overshooting endLine cannot consume the trailing newline', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        await run(p, [{ startLine: 1, endLine: 99, newContent: 'X' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('X\n');
    });

    it('startLine on the synthetic line is out of bounds', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        const text = await run(p, [{ startLine: 3, endLine: 3, newContent: 'X' }]);
        expect(text).toBe('Line range 3-3 out of bounds (2 lines).');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\n');
    });

    it('the out-of-bounds message reports the real line count', async () => {
        const p = mkFile('a.txt', 'a\nb\n'); // 2 real lines, split gives 3
        const text = await run(p, [{ startLine: 50, endLine: 60, newContent: 'X' }]);
        expect(text).toBe('Line range 50-60 out of bounds (2 lines).');
    });

    it('the last line of a file without a trailing newline stays editable', async () => {
        const p = mkFile('a.txt', 'a\nb');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'B' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nB');
    });
});

describe('binary / non-UTF-8 refusal (review #9)', () => {
    it('refuses a file with NUL bytes, leaving it untouched', async () => {
        const p = path.join(repoDir, 'bin.dat');
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff, 0xfe]);
        fs.writeFileSync(p, bytes);
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'x' }]);
        expect(text).toBe('Not a UTF-8 text file.');
        expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    });

    it('refuses invalid UTF-8 without NUL bytes, leaving it untouched', async () => {
        const p = path.join(repoDir, 'bad.txt');
        const bytes = Buffer.from([0x61, 0x0a, 0xc3, 0x28, 0x0a]); // 0xC3 0x28 is malformed
        fs.writeFileSync(p, bytes);
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'x' }]);
        expect(text).toBe('Not a UTF-8 text file.');
        expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    });

    it('a file legitimately containing U+FFFD is still editable', async () => {
        const p = mkFile('a.txt', 'a\n\uFFFD\nb\n');
        await run(p, [{ startLine: 3, endLine: 3, newContent: 'B' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\n\uFFFD\nB\n');
    });
});

describe('setgid/setuid bits survive the write (review #20/#29)', () => {
    it('preserves mode 2755 through chown→chmod→rename', async () => {
        const p = mkFile('s.sh', 'echo hi\n');
        fs.chmodSync(p, 0o2755);
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'echo yo' }]);
        expect((fs.statSync(p).mode & 0o7777).toString(8)).toBe('2755');
        expect(fs.readFileSync(p, 'utf-8')).toBe('echo yo\n');
    });
});

// ---------------------------------------------------------------------------
// Injected write failure — cleanup still happens
// ---------------------------------------------------------------------------

describe('injected failure between temp-write and rename', () => {
    afterEach(() => {
        vi.doUnmock('fs/promises');
        vi.resetModules();
    });

    it('cleans up the temp file and reports a short write failure', async () => {
        vi.resetModules();
        const actual = await vi.importActual('fs/promises');
        const failRename = async () => {
            const err = new Error('injected failure');
            err.code = 'EIO';
            throw err;
        };
        vi.doMock('fs/promises', () => ({
            ...actual,
            default: { ...actual.default, rename: failRename },
            rename: failRename,
        }));
        const mockedMod = await import('../dist/tools/edit.js');
        const { server, calls } = captureHandler();
        mockedMod.register(server, mkCtx(repoDir));
        const p = mkFile('a.txt', 'a\nb\n');
        const result = await calls[0].handler({
            path: p,
            edits: [{ startLine: 1, endLine: 1, newContent: 'A' }],
        });
        expect(result.content[0].text).toBe('Write failed (EIO).');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\n');
        expect(tmpLitter(repoDir)).toEqual([]);
        // Review #8/#19/#31: snapshots are recorded only after a confirmed
        // rename — a failed write must leave zero phantom undo history.
        const repoRoot = symbolIndex.findRepoRoot(p);
        const db = symbolIndex.getDb(repoRoot);
        const rel = path.relative(repoRoot, p);
        expect(symbolIndex.getVersionHistory(db, `file://${rel}`, 'test-session', rel)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Snapshots — the literal patch each edit applied, keyed, capped, retrievable
// ---------------------------------------------------------------------------

describe('snapshots', () => {
    function historyFor(p) {
        const repoRoot = symbolIndex.findRepoRoot(p);
        const db = symbolIndex.getDb(repoRoot);
        const rel = path.relative(repoRoot, p);
        return {
            db,
            rows: symbolIndex.getVersionHistory(db, `file://${rel}`, 'test-session', rel),
        };
    }

    it('same-millisecond batch snapshots order deterministically, newest first (review #28)', async () => {
        // A batched call lands multiple snapshots in the same created_at
        // millisecond; id DESC must tie-break so "newest" is stable for undo.
        const p = mkFile('a.txt', 'a\nb\nc\nd\ne\n');
        await run(p, [
            { startLine: 1, endLine: 1, newContent: 'A' },
            { startLine: 3, endLine: 3, newContent: 'C' },
            { startLine: 5, endLine: 5, newContent: 'E' },
        ]);
        const { rows } = historyFor(p);
        expect(rows.length).toBe(3);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1].created_at).toBeGreaterThanOrEqual(rows[i].created_at);
            if (rows[i - 1].created_at === rows[i].created_at) {
                expect(rows[i - 1].id).toBeGreaterThan(rows[i].id);
            }
        }
    });

    it('the refactor TTL prune never deletes edit-patch rows (review #10)', async () => {
        const p = mkFile('a.txt', 'a\nb\n');
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]);
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(1);
        // Prune everything older than the far future: symbol versions would
        // all die, file:// edit patches must survive (their retention is the
        // per-file cap, not the refactor TTL).
        dbAdapter.pruneOldVersions(db, Date.now() + 86_400_000);
        const { rows: after } = historyFor(p);
        expect(after.length).toBe(1);
    });

    it('stores oldText, applied newText, and the original start line for a line edit', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\n');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'B' }]);
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(1);
        expect(symbolIndex.getVersionPatch(db, rows[0].id))
            .toEqual({ original_text: 'b', new_text: 'B', line: 2 });
    });

    it('stores the matched span (with consumed trailing whitespace) for a content edit', async () => {
        const p = mkFile('a.txt', 'one\n    keep me;   \nthree');
        await run(p, [{ oldContent: '    keep me;', newContent: '    kept;' }]);
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(1);
        expect(symbolIndex.getVersionPatch(db, rows[0].id))
            .toEqual({ original_text: '    keep me;   ', new_text: '    kept;', line: 2 });
    });

    it('stores the replacement as applied — after re-indent fitting', async () => {
        const p = mkFile('a.txt', 'top\n        old();\nbottom');
        await run(p, [{ startLine: 2, endLine: 2, newContent: 'new1();\nnew2();' }]);
        const { db, rows } = historyFor(p);
        expect(symbolIndex.getVersionPatch(db, rows[0].id)).toEqual({
            original_text: '        old();',
            new_text: '        new1();\n        new2();',
            line: 2,
        });
    });

    it('stores a deletion patch with its consumed newline', async () => {
        const p = mkFile('a.txt', 'a\nb\nc\nd');
        await run(p, [{ startLine: 2, endLine: 3, newContent: '' }]);
        const { db, rows } = historyFor(p);
        expect(symbolIndex.getVersionPatch(db, rows[0].id))
            .toEqual({ original_text: 'b\nc\n', new_text: '', line: 2 });
    });

    it('stores patches in the LF-normalized frame for CRLF files', async () => {
        const p = mkFile('a.txt', 'a\r\nb\r\nc\r\n');
        await run(p, [{ startLine: 1, endLine: 2, newContent: 'X\nY' }]);
        const { db, rows } = historyFor(p);
        expect(symbolIndex.getVersionPatch(db, rows[0].id))
            .toEqual({ original_text: 'a\nb', new_text: 'X\nY', line: 1 });
    });

    it('stores one patch per edit, each with its original-relative line', async () => {
        const p = mkFile('a.txt', 'l1\nl2\nl3\nl4\nl5\nl6');
        await run(p, [
            { startLine: 1, endLine: 1, newContent: 'H1\nH2\nH3' },
            { startLine: 5, endLine: 5, newContent: 'F' },
        ]);
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(2);
        const patches = rows.slice().sort((a, b) => a.id - b.id)
            .map((r) => symbolIndex.getVersionPatch(db, r.id));
        expect(patches).toEqual([
            { original_text: 'l1', new_text: 'H1\nH2\nH3', line: 1 },
            { original_text: 'l5', new_text: 'F', line: 5 },
        ]);
    });

    it('keeps only the 10 most recent patches per session/file, dropping the oldest', async () => {
        const p = mkFile('a.txt', 'state 0\nrest\n');
        for (let k = 1; k <= 12; k++) {
            const text = await run(p, [{ startLine: 1, endLine: 1, newContent: `state ${k}` }]);
            expect(text).toBe(BARE);
        }
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(10);
        const patches = rows.slice().sort((a, b) => a.id - b.id)
            .map((r) => symbolIndex.getVersionPatch(db, r.id));
        expect(patches).toEqual(
            Array.from({ length: 10 }, (_, i) => ({
                original_text: `state ${i + 2}`,
                new_text: `state ${i + 3}`,
                line: 1,
            })));
    });

    it('re-applying an identical patch refreshes its recency instead of duplicating', async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const p = mkFile('a.txt', 'A\n');
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'B' }]); // patch A->B
        await sleep(5);
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]); // patch B->A
        await sleep(5);
        await run(p, [{ startLine: 1, endLine: 1, newContent: 'B' }]); // patch A->B again
        const { db, rows } = historyFor(p);
        expect(rows.length).toBe(2);
        expect(symbolIndex.getVersionPatch(db, rows[0].id))
            .toEqual({ original_text: 'A', new_text: 'B', line: 1 });
        expect(symbolIndex.getVersionPatch(db, rows[1].id))
            .toEqual({ original_text: 'B', new_text: 'A', line: 1 });
    });

    it('a snapshot-persistence failure does not fail the edit', async () => {
        // a FILE named .mcp blocks getDb's mkdir — the snapshot layer throws
        fs.writeFileSync(path.join(repoDir, '.mcp'), 'not a directory');
        const p = mkFile('a.txt', 'a\nb\n');
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'A' }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('A\nb\n');
    });

    it('snapshots patches per file in a multi-file call', async () => {
        const a = mkFile('a.txt', 'aaa\n');
        const b = mkFile('b.txt', 'bbb\n');
        await run(a, [
            { startLine: 1, endLine: 1, newContent: 'A' },
            { path: b, startLine: 1, endLine: 1, newContent: 'B' },
        ]);
        expect(historyFor(a).rows.length).toBe(1);
        expect(historyFor(b).rows.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Don't-fail philosophy
// ---------------------------------------------------------------------------

describe("don't-fail", () => {
    it('a syntax-breaking edit still writes to disk — writes are never gated on parse', async () => {
        const p = mkFile('a.js', 'function foo() {\n    return 1;\n}\n');
        const text = await run(p, [{ startLine: 1, endLine: 1, newContent: 'function foo( {' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('function foo( {\n    return 1;\n}\n');
        expect(text).toMatch(STATE2_RE);
    });

    it('missing file: shortest true message', async () => {
        const text = await run(path.join(repoDir, 'nope.txt'),
            [{ startLine: 1, endLine: 1, newContent: 'x' }]);
        expect(text).toBe('File not found.');
    });

    it('line range fully out of bounds: short message naming the real length', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const text = await run(p, [{ startLine: 100, endLine: 110, newContent: 'x' }]);
        expect(text).toBe('Line range 100-110 out of bounds (3 lines).');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\nc');
    });

    it('unmatchable oldContent: short message', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const text = await run(p, [{ oldContent: 'not here at all', newContent: 'x' }]);
        expect(text).toBe('oldContent not found.');
    });

    it('underspecified edit: the shortest true instruction', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        expect(await run(p, [{ newContent: 'x' }]))
            .toBe('Specify a line range or oldContent.');
        expect(await run(p, [{ startLine: 2, newContent: 'x' }]))
            .toBe('Specify a line range or oldContent.');
        expect(await run(p, [{ oldContent: '', newContent: 'x' }]))
            .toBe('Specify a line range or oldContent.');
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb\nc');
    });

    it('a failing edit does not block the other edits in the call', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const text = await run(p, [
            { startLine: 1, endLine: 1, newContent: 'A' },
            { oldContent: 'zzz', newContent: 'x' },
            { startLine: 3, endLine: 3, newContent: 'C' },
        ]);
        expect(text).toBe(`#2: oldContent not found.\n${BARE}`);
        expect(fs.readFileSync(p, 'utf-8')).toBe('A\nb\nC');
    });
});

// ---------------------------------------------------------------------------
// Line-range + oldContent interplay
// ---------------------------------------------------------------------------

describe('line range + oldContent', () => {
    it('a valid line range wins; mismatching oldContent never fails it', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const text = await run(p, [{
            startLine: 2, endLine: 2,
            oldContent: 'this text matches nothing in the file',
            newContent: 'B',
        }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nB\nc');
    });

    it('line range wins even when oldContent matches elsewhere', async () => {
        const p = mkFile('a.txt', 'target\nb\ntarget');
        await run(p, [{ startLine: 1, endLine: 1, oldContent: 'target', newContent: 'HIT' }]);
        expect(fs.readFileSync(p, 'utf-8')).toBe('HIT\nb\ntarget');
    });

    it('an out-of-bounds range falls back to a matchable oldContent before failing', async () => {
        const p = mkFile('a.txt', 'a\nfind me\nc');
        const text = await run(p, [{
            startLine: 50, endLine: 60,
            oldContent: 'find me',
            newContent: 'found',
        }]);
        expect(text).toBe(BARE);
        expect(fs.readFileSync(p, 'utf-8')).toBe('a\nfound\nc');
    });

    it('an out-of-bounds range with unmatchable oldContent reports both facts in one line', async () => {
        const p = mkFile('a.txt', 'a\nb\nc');
        const text = await run(p, [{
            startLine: 50, endLine: 60,
            oldContent: 'zzz',
            newContent: 'x',
        }]);
        expect(text).toBe('Line range 50-60 out of bounds (3 lines); oldContent not found.');
    });
});

// ---------------------------------------------------------------------------
// Multi-file calls
// ---------------------------------------------------------------------------

describe('multi-file', () => {
    it('edits three files in one call and returns the single clean line', async () => {
        const a = mkFile('a.js', 'const a = 1;\n');
        const b = mkFile('b.js', 'const b = 1;\n');
        const c = mkFile('c.js', 'const c = 1;\n');
        const text = await run(a, [
            { startLine: 1, endLine: 1, newContent: 'const a = 2;' },
            { path: b, startLine: 1, endLine: 1, newContent: 'const b = 2;' },
            { path: c, oldContent: 'const c = 1;', newContent: 'const c = 2;' },
        ]);
        expect(text).toBe(CLEAN);
        expect(fs.readFileSync(a, 'utf-8')).toBe('const a = 2;\n');
        expect(fs.readFileSync(b, 'utf-8')).toBe('const b = 2;\n');
        expect(fs.readFileSync(c, 'utf-8')).toBe('const c = 2;\n');
    });

    it('a failure in one file leaves the others fully applied and intact', async () => {
        const a = mkFile('a.txt', 'aaa\n');
        const b = path.join(repoDir, 'missing.txt');
        const c = mkFile('c.txt', 'ccc\n');
        const text = await run(a, [
            { startLine: 1, endLine: 1, newContent: 'AAA' },
            { path: b, startLine: 1, endLine: 1, newContent: 'x' },
            { path: c, startLine: 1, endLine: 1, newContent: 'CCC' },
        ]);
        expect(text).toBe(`missing.txt: File not found.\n${BARE}`);
        expect(fs.readFileSync(a, 'utf-8')).toBe('AAA\n');
        expect(fs.readFileSync(c, 'utf-8')).toBe('CCC\n');
    });

    it('per-file atomicity: a file whose only edit fails is not written at all', async () => {
        const a = mkFile('a.txt', 'aaa\n');
        const b = mkFile('b.txt', 'bbb\n');
        const before = fs.statSync(b).mtimeMs;
        const text = await run(a, [
            { startLine: 1, endLine: 1, newContent: 'AAA' },
            { path: b, oldContent: 'zzz', newContent: 'x' },
        ]);
        expect(text).toBe(`b.txt: #2: oldContent not found.\n${BARE}`);
        expect(fs.readFileSync(b, 'utf-8')).toBe('bbb\n');
        expect(fs.statSync(b).mtimeMs).toBe(before);
    });

    it('parses only edited files: a broken unedited neighbor cannot pollute the claim', async () => {
        mkFile('broken.js', 'function nope( {{{\n');
        const a = mkFile('a.js', 'const a = 1;\n');
        const text = await run(a, [{ startLine: 1, endLine: 1, newContent: 'const a = 2;' }]);
        expect(text).toBe(CLEAN);
    });

    it('one unparseable file in a batch downgrades the claim to the bare line', async () => {
        const a = mkFile('a.js', 'const a = 1;\n');
        const b = mkFile('b.txt', 'text\n');
        const text = await run(a, [
            { startLine: 1, endLine: 1, newContent: 'const a = 2;' },
            { path: b, startLine: 1, endLine: 1, newContent: 'TEXT' },
        ]);
        expect(text).toBe(BARE);
        expect(text).not.toContain('detected');
    });

    it('a parse error in any edited file surfaces as the single terse error line', async () => {
        const a = mkFile('a.js', 'const a = 1;\n');
        const b = mkFile('b.js', 'function ok() {\n    return 1;\n}\n');
        const text = await run(a, [
            { startLine: 1, endLine: 1, newContent: 'const a = 2;' },
            { path: b, startLine: 3, endLine: 3, newContent: '' },
        ]);
        expect(text).toMatch(STATE2_RE);
        expect(text.includes('\n')).toBe(false);
    });
});
