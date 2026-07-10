// ---------------------------------------------------------------------------
// _tiling-measure.mjs — Wave 2 / Task T7 PAYOFF MEASUREMENT.
//
// NOT a vitest test: the leading `_` and the `.mjs` extension (no `.test.`/
// `.spec.`) keep it OUT of vitest's default `**/*.{test,spec}.*` glob, so the
// suite never collects it. Run it directly:
//
//   cd <repo> && source /tmp/nodeenv.sh \
//     && node packages/zenith-mcp/tests/_tiling-measure.mjs
//
// WHAT THIS PROVES (per the execution plan, Wave 2 T7):
//   • PIPELINE BY REUSE (H1): it does NOT reimplement the indexing pipeline. It
//     mirrors compression.ts's `compressForTool` (:33-103) line-for-line —
//     reads the raw file, builds the `N. `-prefixed source exactly as
//     read_file.ts does, strips the prefix for indexing exactly as
//     compression.ts:61-64, calls ensureFreshFromContent + getFileFacts from
//     the BUILT dist, and assembles the SAME facts object compressForTool
//     builds — so the facts crossing the seam are byte-identical to production.
//   • AUTHORITATIVE VERDICT (C1): the ONLY "this file compresses" signal is a
//     STRING (not null) returned by the REAL `compressFile`. `compressSource`
//     is called ONLY for diagnostics (blocks / sagerank.coreIndices /
//     removal.dropped / rendered size); a `dropped>0`-but-`null` mismatch is
//     RECORDED, never reported as success.
//   • FULL FIDELITY (L2): for every STRING, the re-exported `verifyOutput`
//     (H1–H7) is run AND an independent hand-rolled H2 spot-check (character
//     identity of kept lines vs the raw source) that does not touch TOON code.
//     Any violation prints file/line/expected/got FIRST and exits non-zero.
//   • CENTRALITY GATE (M2): for the most heavily-called def WITH a subdivided
//     body in each compressed file, it reports whether the def's SIGNATURE
//     sub-block index ∈ sagerank.coreIndices and how much of the body became
//     eligible / dropped. Signature demoted out of core (or a near-total body
//     drop) ⇒ a prominent ESCALATE + non-zero exit.
//   • STEP K TABLE for every target.
//
// REPO ROOT NOTE: compression.ts derives repoRoot via `findRepoRoot`, which
// walks up for a `.git` dir. This checkout is NOT a git repo (no `.git`
// anywhere up the tree), so `findRepoRoot` returns null and production would
// hand TOON empty facts — no facts would ever flow. To measure the real seam
// we therefore pin the known monorepo root explicitly (REPO_ROOT below) and
// derive every `facts.path` repo-relative off it (Rule 15), which is exactly
// what compression.ts does once it HAS a root. Everything downstream of the
// root — strip regex, ensureFreshFromContent, getFileFacts, the facts object,
// compressFile — is mirrored verbatim. We touch no production source.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// TOON dist (the C2 re-export makes verifyOutput importable here).
import {
    compressFile,
    compressSource,
    tileByDefs,
    verifyOutput,
} from '../../zenith-toon/dist/index.js';

// MCP dist — the EXACT modules + names compression.ts imports, resolved to
// ../dist/core/*.js (compression.ts: getDb/ensureFreshFromContent/findRepoRoot
// from ./symbol-index.js; getFileFacts from ./db-adapter.js; getLangForFile
// from ./tree-sitter.js).
import { getDb, ensureFreshFromContent, findRepoRoot } from '../dist/core/symbol-index.js';
import { getFileFacts } from '../dist/core/db-adapter.js';
import { getLangForFile } from '../dist/core/tree-sitter.js';

// ── Repo root ────────────────────────────────────────────────────────────────
// This file lives at <root>/packages/zenith-mcp/tests/_tiling-measure.mjs, so
// the monorepo root is four levels up. We still CALL findRepoRoot (mirroring
// compression.ts) and report what it returns, but fall back to the resolved
// path root when it is null so real facts can flow.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// ── Targets (Step D/K) ───────────────────────────────────────────────────────
// Group 1: previously-null dense engine files (the payoff candidates).
// Group 2: normal/no-regress MCP core files.
// Group 3: extra files chosen to (a) prove the success path end-to-end — at
//   least one compresses to a STRING in-band — and (b) exercise the centrality
//   gate on a genuinely heavily-called, subdivided def (roots-utils.parseRootUri
//   has callCount 10 and a 15-block body; server.ts carries 21 imports).
const DENSE_TARGETS = [
    'packages/zenith-toon/src/removal.ts',
    'packages/zenith-toon/src/sagerank.ts',
    'packages/zenith-toon/src/bmx-plus.ts',
];
const NORMAL_TARGETS = [
    'packages/zenith-mcp/src/core/lib.ts',
    'packages/zenith-mcp/src/core/project-context.ts',
];
const EXTRA_TARGETS = [
    'packages/zenith-mcp/src/core/roots-utils.ts',     // centrality subject + imports
    'packages/zenith-mcp/src/core/server.ts',          // 21 imports
    'packages/zenith-mcp/src/retrieval/telemetry/scanner.ts', // large subdivided body
    'packages/zenith-mcp/src/core/project-registry.ts', // many edges
];
const TARGETS = [...DENSE_TARGETS, ...NORMAL_TARGETS, ...EXTRA_TARGETS];

// The retention band TOON enforces (AGENTS.md Priority 0: 68–72%). Used only to
// label bandSatisfied; the authority on the band is verifyOutput (H6).
const BAND_LO = 0.68;
const BAND_HI = 0.72;

// maxChars must FORCE compression (smaller than the source). compressForTool is
// only reached by read_file when `content.length <= maxChars * 4`, and the
// engine's own 70% floor governs the actual cut, so the exact multiplier is not
// load-bearing; 0.85 is comfortably above the band ceiling yet < source length,
// so it never short-circuits compressForTool's own `<= maxChars` early return.
const MAXCHARS_FRACTION = 0.85;

// ── Helpers (measurement-harness only; production source is untouched) ─────────

// Build the `N. `-prefixed source EXACTLY as read_file.ts does (:108-110):
// split on '\n', drop a single trailing empty element, prefix each line with
// `${i+1}. `. We read raw files off disk (no read_file tool), so we reproduce
// its prefixing byte-for-byte — the number a line carries must be the one
// read_file would have placed.
function buildPrefixedSource(rawContent) {
    const srcLines = rawContent.split('\n');
    if (srcLines.length > 0 && srcLines[srcLines.length - 1] === '') srcLines.pop();
    return { prefixed: srcLines.map((line, i) => `${i + 1}. ${line}`).join('\n'), srcLines };
}

// Strip the `N. ` prefix for indexing EXACTLY as compression.ts:61-64 — the
// SAME regex TOON uses — so the indexer parses real code at true line numbers.
function stripPrefixForIndexing(prefixed) {
    return prefixed
        .split('\n')
        .map(l => l.replace(/^\s*\d+[.:]\s?/, ''))
        .join('\n');
}

// Assemble the SAME facts object compressForTool builds (compression.ts
// :70-106): defs.line forwarded as-is (TOON maps line→startLine internally),
// the honest type-guard drop of null-typed defs, edges/anchors/imports/
// injections/scopes mapped field-for-field, camelCase→camelCase for scopes.
function buildFacts(dbFacts, relPath, langName) {
    return {
        path: relPath,
        langName,
        defs: dbFacts.defs
            .filter(d => d.type !== null)
            .map(d => ({
                name: d.name, kind: 'def', type: d.type,
                line: d.line, endLine: d.endLine,
                visibility: d.visibility, captureTag: d.captureTag,
            })),
        edges: dbFacts.edges.map(e => ({
            callerLine: e.callerLine, calleeLine: e.calleeLine, callCount: e.callCount,
        })),
        anchors: dbFacts.anchors.map(a => ({
            symbolName: a.symbol_name, kind: a.kind, line: a.line, text: a.text,
        })),
        imports: dbFacts.imports.map(i => ({
            module: i.module,
            importedNames: i.importedNames,
            line: i.line,
            startLine: i.startLine,
            endLine: i.endLine,
        })),
        importBindings: dbFacts.importBindings.map(i => ({
            source: i.source,
            localName: i.localName,
            importedName: i.importedName,
            importKind: i.importKind,
            isTypeOnly: i.isTypeOnly,
            line: i.line,
            column: i.column,
        })),
        injections: dbFacts.injections.map(j => ({
            injectedLang: j.injected_lang, startLine: j.start_line, endLine: j.end_line,
        })),
        scopes: dbFacts.scopes.map(s => ({
            scopeKind: s.scopeKind, startLine: s.startLine, endLine: s.endLine,
        })),
    };
}

// Reconstruct the Source EXACTLY as compressFile does internally (index.js
// :432-457): defs→{startLine,endLine}, the refine object (scopes/injections as
// hard spans, anchors/imports as soft hints), defs.line→startLine in
// Source.facts. This is DIAGNOSTIC ONLY — its compressSource result is read for
// the table, never for the verdict.
function buildBlocksAndSource(prefixed, facts, maxChars) {
    const blocks = tileByDefs(
        prefixed,
        facts.defs.map(d => ({ startLine: d.line, endLine: d.endLine })),
        {
            scopes: facts.scopes,
            injections: facts.injections,
            anchors: facts.anchors,
            imports: facts.imports,
        },
    );
    const source = {
        blocks,
        query: null,
        charBudget: maxChars,
        modulePath: facts.path,
        facts: {
            path: facts.path,
            langName: facts.langName,
            defs: facts.defs.map(d => ({
                name: d.name, kind: d.kind, type: d.type,
                startLine: d.line, endLine: d.endLine,
                visibility: d.visibility, captureTag: d.captureTag,
            })),
            edges: facts.edges,
            anchors: facts.anchors,
            imports: facts.imports,
            importBindings: facts.importBindings,
            injections: facts.injections,
            scopes: facts.scopes,
        },
    };
    return { blocks, source };
}

// Classify each block (the probe's OWN logic, per the plan). A block is:
//   • a DEF block if its startLine is some def's identity line;
//   • a SCOPE sub-block if it sits strictly inside a def body and coincides with
//     a scope span boundary (a subdivision the def base partition did not make);
//   • an INJECTION block if it coincides with an injection span;
//   • an IMPORT block if it covers (only) top-level import lines;
//   • an ANCHOR split if it is a sub-block of a leftover (non-def, non-import)
//     block that begins on an anchor line.
// These are descriptive counts for the table, not engine inputs.
function classifyBlocks(blocks, facts) {
    const defStart = new Set(facts.defs.map(d => d.line));
    const defRanges = facts.defs.map(d => ({ start: d.line, end: d.endLine }));
    const importLines = new Set();
    for (const im of facts.imports) {
        for (let line = im.startLine; line <= im.endLine; line++) importLines.add(line);
    }
    const anchorLines = new Set(facts.anchors.map(a => a.line));
    const scopeStart = new Set(facts.scopes.map(s => s.startLine));
    const injectionStart = new Set(facts.injections.map(j => j.startLine));

    const insideAnyDefBody = (startLine) =>
        defRanges.some(r => startLine > r.start && startLine <= r.end);
    const isAllImports = (b) => {
        if (importLines.size === 0) return false;
        let sawImport = false;
        for (let ln = b.startLine; ln <= b.endLine; ln++) {
            if (importLines.has(ln)) { sawImport = true; continue; }
            // allow blank/continuation lines around imports, but reject def starts
            if (defStart.has(ln)) return false;
        }
        return sawImport && !defStart.has(b.startLine);
    };

    let defBlocks = 0, scopeBlocks = 0, injectionBlocks = 0, importBlocks = 0, anchorSplits = 0;
    for (const b of blocks) {
        if (defStart.has(b.startLine)) { defBlocks++; continue; }
        if (injectionStart.has(b.startLine)) { injectionBlocks++; continue; }
        if (insideAnyDefBody(b.startLine) && scopeStart.has(b.startLine)) { scopeBlocks++; continue; }
        if (isAllImports(b)) { importBlocks++; continue; }
        if (anchorLines.has(b.startLine)) { anchorSplits++; continue; }
        // unclassified leftover/gap block — counted only in the total
    }
    return { defBlocks, scopeBlocks, injectionBlocks, importBlocks, anchorSplits };
}

// Independent H2 spot-check: for several KEPT (non-marker) output lines, parse
// the leading line number and assert the line's characters are identical to
// `rawPrefixedLines[n-1]`. Pure string compare — does NOT call any TOON code,
// so it is a true third opinion alongside verifyOutput's own H2. Returns a
// violation descriptor (or null if clean).
function independentH2SpotCheck(output, rawPrefixedLines) {
    const outLines = output.split('\n');
    const markerRe = /^\[TRUNCATED: lines \d+-\d+\]$/;
    const numRe = /^(\d+)\. /;
    const kept = [];
    for (const ol of outLines) {
        if (markerRe.test(ol)) continue;
        const m = numRe.exec(ol);
        if (m === null) {
            return { kind: 'unparseable-kept-line', line: '-', expected: 'a `N. ` prefixed line or a marker', got: ol };
        }
        kept.push(ol);
    }
    if (kept.length === 0) return null;
    // Sample up to 8 kept lines spread across the output (first, last, evenly spaced).
    const sampleCount = Math.min(8, kept.length);
    const picks = [];
    for (let s = 0; s < sampleCount; s++) {
        const idx = sampleCount === 1 ? 0 : Math.round((s * (kept.length - 1)) / (sampleCount - 1));
        picks.push(kept[idx]);
    }
    for (const ol of picks) {
        const m = numRe.exec(ol);
        // m is guaranteed non-null here (every `kept` line matched numRe above),
        // but narrow explicitly rather than asserting (Rule 6 / no `!`).
        if (m === null) {
            return { kind: 'unparseable-kept-line', line: '-', expected: 'a `N. ` prefixed line', got: ol };
        }
        const n = Number(m[1]);
        const original = rawPrefixedLines[n - 1];
        if (original === undefined) {
            return { kind: 'kept-line-number-out-of-range', line: n, expected: `line ${n} to exist in source`, got: 'no such source line' };
        }
        if (original !== ol) {
            return { kind: 'kept-line-content-mismatch', line: n, expected: original, got: ol };
        }
    }
    return null;
}

// Centrality acceptance gate (M2). Choose the heaviest-called def THAT HAS a
// subdivided body (the only case the design's centrality-relocation claim is
// about — a 1-line accessor has no body to demote). Report:
//   • sigInCore — is the def's signature sub-block index ∈ sagerank.coreIndices?
//   • bodyDropped / bodyEligible / bodyLines.
// ESCALATE when a heavily-called def's signature is NOT in the SageRank core
// (its central logic was demoted out of protection by subdivision), OR when a
// near-total fraction of an ELIGIBLE body is dropped (subdivision shredded the
// body rather than relocating centrality onto the signature). Body removal in
// itself is the INTENDED win, so the body threshold is deliberately high.
const BODY_DROP_ESCALATE_FRACTION = 0.9;
const HEAVY_CALL_MIN = 2; // "heavily-called": aggregate callCount ≥ this

function evaluateCentrality(blocks, facts, sageCoreIndices, removalMeta) {
    const coreSet = new Set(sageCoreIndices.filter(i => typeof i === 'number'));
    const dropped = removalMeta.dropped;       // ReadonlySet<number> (absolute lines)
    const eligible = removalMeta.eligible;     // ReadonlyMap<number, boolean>

    // Aggregate callCount per callee def line.
    const callByLine = new Map();
    for (const e of facts.edges) {
        callByLine.set(e.calleeLine, (callByLine.get(e.calleeLine) ?? 0) + e.callCount);
    }

    // Candidate defs: called, with ≥1 body sub-block, ordered by call weight.
    const candidates = [];
    for (const [calleeLine, count] of callByLine) {
        const def = facts.defs.find(d => d.line === calleeLine);
        if (def === undefined) continue;
        const bodyBlocks = blocks.filter(b => b.startLine > def.line && b.endLine <= def.endLine);
        if (bodyBlocks.length === 0) continue;
        candidates.push({ def, count, bodyBlocks });
    }
    candidates.sort((a, b) => b.count - a.count);

    if (candidates.length === 0) {
        return { status: 'ok', note: 'no heavily-called def with a subdivided body', detail: null };
    }

    const top = candidates[0];
    const sigIdx = blocks.findIndex(b => b.startLine === top.def.line);
    const sigInCore = sigIdx >= 0 && coreSet.has(sigIdx);

    let bodyLines = 0, bodyDropped = 0, bodyEligible = 0;
    for (const b of top.bodyBlocks) {
        for (let ln = b.startLine; ln <= b.endLine; ln++) {
            bodyLines++;
            if (dropped.has(ln)) bodyDropped++;
            if (eligible.get(ln) === true) bodyEligible++;
        }
    }
    const eligibleBodyDropFrac = bodyEligible > 0 ? bodyDropped / bodyEligible : 0;

    const detail = {
        name: top.def.name, line: top.def.line, callCount: top.count,
        sigBlockIdx: sigIdx, sigInCore,
        bodyBlocks: top.bodyBlocks.length, bodyLines, bodyDropped, bodyEligible,
        eligibleBodyDropFrac: Number(eligibleBodyDropFrac.toFixed(2)),
    };

    const heavilyCalled = top.count >= HEAVY_CALL_MIN;
    if (heavilyCalled && !sigInCore) {
        return {
            status: 'ESCALATE',
            note: `heavily-called def '${top.def.name}' (callCount=${top.count}) signature block #${sigIdx} is NOT in sagerank.coreIndices — subdivision demoted central logic`,
            detail,
        };
    }
    if (heavilyCalled && bodyEligible > 0 && eligibleBodyDropFrac >= BODY_DROP_ESCALATE_FRACTION) {
        return {
            status: 'ESCALATE',
            note: `heavily-called def '${top.def.name}' (callCount=${top.count}) had ${bodyDropped}/${bodyEligible} eligible body lines dropped (${(eligibleBodyDropFrac * 100).toFixed(0)}%) — body shredded`,
            detail,
        };
    }
    return { status: 'ok', note: null, detail };
}

// ── Measurement of one target ────────────────────────────────────────────────
async function measureFile(db, relPath) {
    const validPath = path.join(REPO_ROOT, relPath);
    const row = {
        relPath,
        exists: true,
        n: 0, srcLen: 0,
        blocks: 0, defBlocks: 0, scopeBlocks: 0, injectionBlocks: 0, importBlocks: 0, anchorSplits: 0,
        defsCount: 0, edgesCount: 0, scopesCount: 0, importsCount: 0, injectionsCount: 0,
        sageCore: 'n/a', eligible: 'n/a', dropped: 'n/a', renderedSize: 'n/a',
        ratio: 'n/a', contentRatio: 'n/a', compressFile: 'n/a', bandSatisfied: 'n/a',
        h17: 'n/a', centrality: 'n/a',
        notes: [],
        violation: null,       // fidelity violation (forces non-zero exit)
        escalate: null,        // centrality escalation (forces non-zero exit)
    };

    if (!existsSync(validPath) || !statSync(validPath).isFile()) {
        row.exists = false;
        row.notes.push('FILE NOT FOUND');
        return row;
    }

    const raw = readFileSync(validPath, 'utf-8');
    const { prefixed, srcLines } = buildPrefixedSource(raw);
    row.n = srcLines.length;
    row.srcLen = prefixed.length;

    const langName = getLangForFile(validPath);
    const relForSeam = path.relative(REPO_ROOT, validPath); // Rule 15: repo-relative
    const indexedSource = stripPrefixForIndexing(prefixed);

    // Mirror compressForTool's DB hop: ensure facts describe THESE exact bytes,
    // then read them back. Any DB failure degrades to empty facts (Rule 12).
    let dbFacts = { defs: [], edges: [], anchors: [], imports: [], importBindings: [], injections: [], scopes: [] };
    try {
        await ensureFreshFromContent(db, REPO_ROOT, validPath, indexedSource);
        dbFacts = getFileFacts(db, relForSeam);
    } catch (err) {
        row.notes.push(`facts hop failed: ${String(err && err.message ? err.message : err).slice(0, 80)}`);
    }

    const facts = buildFacts(dbFacts, relForSeam, langName);
    row.defsCount = facts.defs.length;
    row.edgesCount = facts.edges.length;
    row.scopesCount = facts.scopes.length;
    row.importsCount = facts.imports.length;
    row.injectionsCount = facts.injections.length;

    const maxChars = Math.floor(prefixed.length * MAXCHARS_FRACTION);

    // Block list + classification (diagnostic; tileByDefs is deterministic and
    // does not throw on well-formed input).
    let blocks = [];
    try {
        const built = buildBlocksAndSource(prefixed, facts, maxChars);
        blocks = built.blocks;
        row.blocks = blocks.length;
        const cls = classifyBlocks(blocks, facts);
        row.defBlocks = cls.defBlocks;
        row.scopeBlocks = cls.scopeBlocks;
        row.injectionBlocks = cls.injectionBlocks;
        row.importBlocks = cls.importBlocks;
        row.anchorSplits = cls.anchorSplits;
    } catch (err) {
        row.notes.push(`tileByDefs threw: ${String(err && err.message ? err.message : err).slice(0, 80)}`);
    }

    // ── AUTHORITATIVE VERDICT (C1): the real gate. STRING ⇒ compresses. ──────────
    let cfResult = null;
    try {
        cfResult = compressFile({ source: prefixed, maxChars, facts });
    } catch (err) {
        // compressFile is contracted to NEVER throw (its own try/catch degrades
        // to null). A throw here is itself a finding.
        row.notes.push(`compressFile THREW (should be impossible — it self-degrades): ${String(err && err.message ? err.message : err).slice(0, 80)}`);
        cfResult = null;
    }
    const isString = typeof cfResult === 'string';
    row.compressFile = isString ? `STRING(${cfResult.length})` : 'null';
    if (isString) {
        row.ratio = `${((cfResult.length / prefixed.length) * 100).toFixed(1)}%`;
    }

    // ── DIAGNOSTICS (compressSource): blocks/core/dropped/rendered. May THROW
    //    (e.g. the removal DP's 60M-cell resource guard on large files) — catch
    //    it and record, exactly as compressFile's own boundary would. ───────────
    let sageCoreIndices = null;
    let removalMeta = null;
    try {
        const { source } = buildBlocksAndSource(prefixed, facts, maxChars);
        const payload = compressSource(source);
        const sage = payload.metadata.sagerank;
        const removal = payload.metadata.removal;
        if (sage && typeof sage === 'object' && Array.isArray(sage.coreIndices)) {
            sageCoreIndices = sage.coreIndices;
            row.sageCore = String(sageCoreIndices.length);
        }
        if (removal && typeof removal === 'object' && 'dropped' in removal) {
            removalMeta = removal;
            const eligTrue = [...removal.eligible.values()].filter(Boolean).length;
            row.eligible = `${eligTrue}/${removal.eligible.size}`;
            row.dropped = String(removal.dropped.size);
            row.renderedSize = String(removal.renderedSize);
            // The gate bands `renderedSize` against [68%,72%] of fullSize, where
            // fullSize is the sum of PREFIX-STRIPPED content chars (removal.js
            // strips the display `N. ` before counting: content.length). Band the
            // cross-reference against the SAME fullSize — NOT prefixed.length —
            // else the prefixes inflate the denominator and the label lies.
            const fullSize = prefixed
                .split('\n')
                .reduce((sum, l) => sum + l.replace(/^\s*\d+[.:]\s?/, '').length, 0);
            const lo = Math.ceil(BAND_LO * fullSize);
            const hi = Math.floor(BAND_HI * fullSize);
            const inBand = removal.renderedSize >= lo && removal.renderedSize <= hi;
            // Report the gate's own authoritative bandSatisfied, plus our
            // independent rendered-vs-content-band check (in/out) for the table.
            row.bandSatisfied = removal.bandSatisfied ? `T(${inBand ? 'in' : 'out'})` : `F(${inBand ? 'in' : 'out'})`;
            row.contentRatio = `${((removal.renderedSize / fullSize) * 100).toFixed(1)}%`;
        }
    } catch (err) {
        row.notes.push(`compressSource diag threw: ${String(err && err.message ? err.message : err).slice(0, 90)}`);
    }

    // ── CROSS-CHECK (C1): dropped>0 in diagnostics but compressFile null. ────────
    if (!isString && removalMeta !== null && removalMeta.dropped.size > 0) {
        row.notes.push(`CROSS-CHECK: compressSource dropped=${removalMeta.dropped.size} but compressFile returned null (gate rejected: output not smaller or verifyOutput would throw)`);
    }

    // ── FULL FIDELITY (L2): only meaningful when there is a returned STRING. ─────
    if (isString) {
        // (a) The re-exported engine verifier — re-derives H1–H7 and THROWS on
        //     any violation. We re-verify the EXACT string compressFile returned,
        //     against the EXACT prefixed source it compressed, with the gate's own
        //     determination (removalMeta) and the same maxChars.
        let verifyThrew = null;
        if (removalMeta !== null) {
            try {
                verifyOutput(prefixed, cfResult, removalMeta, maxChars);
            } catch (err) {
                verifyThrew = err;
            }
        } else {
            row.notes.push('verifyOutput skipped: removal metadata unavailable from diagnostics despite a STRING result (unexpected)');
        }

        // (b) Independent H2 spot-check — pure string compare, no TOON code.
        const spot = independentH2SpotCheck(cfResult, srcLines.map((line, i) => `${i + 1}. ${line}`));

        if (verifyThrew !== null) {
            row.h17 = 'FAIL';
            row.violation = {
                relPath,
                source: 'verifyOutput',
                message: String(verifyThrew && verifyThrew.message ? verifyThrew.message : verifyThrew),
            };
        } else if (spot !== null) {
            row.h17 = 'FAIL';
            row.violation = {
                relPath,
                source: 'independent-H2-spot-check',
                kind: spot.kind,
                line: spot.line,
                expected: spot.expected,
                got: spot.got,
            };
        } else {
            row.h17 = 'pass';
        }

        // Surface the honest CONTENT ratio (rendered / prefix-stripped fullSize),
        // which is what the gate actually bands — the `ratio` column is the raw
        // output/source ratio (prefixes included) and reads a touch higher.
        if (row.contentRatio !== 'n/a') {
            row.notes.push(`band: gate.bandSatisfied=${removalMeta !== null ? removalMeta.bandSatisfied : '?'}; rendered/contentFullSize=${row.contentRatio} (in 68-72% band); raw out/src=${row.ratio}`);
        }

        // ── CENTRALITY GATE (M2) ────────────────────────────────────────────────
        if (sageCoreIndices !== null && removalMeta !== null && blocks.length > 0) {
            const c = evaluateCentrality(blocks, facts, sageCoreIndices, removalMeta);
            row.centrality = c.status === 'ok' ? 'ok' : 'ESCALATE';
            if (c.detail !== null) {
                row.notes.push(`centrality: ${c.detail.name}(L${c.detail.line} calls=${c.detail.callCount}) sigBlk#${c.detail.sigBlockIdx} inCore=${c.detail.sigInCore} body=${c.detail.bodyDropped}/${c.detail.bodyEligible}elig drop(${c.detail.eligibleBodyDropFrac})`);
            } else if (c.note) {
                row.notes.push(`centrality: ${c.note}`);
            }
            if (c.status === 'ESCALATE') {
                row.escalate = { relPath, note: c.note, detail: c.detail };
            }
        } else {
            row.centrality = 'n/a';
        }
    } else {
        // Not a STRING: nothing to fidelity-check; centrality gate cannot run
        // (no removal determination). Record WHY it is null so we can tell a
        // genuinely-incompressible file from one rejected by the DP bound.
        row.h17 = 'n/a';
        row.centrality = 'n/a';
    }

    return row;
}

// ── Render the Step K table ────────────────────────────────────────────────────
function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function printStepKTable(rows) {
    const headers = [
        ['file', 52],
        ['B', 4], ['DB', 4], ['SB', 4], ['IB', 4], ['IMB', 4], ['AS', 4],
        ['core', 5], ['elig', 10], ['drop', 6], ['rend', 7], ['ratio', 7],
        ['compressFile', 13], ['band', 7], ['H1-7', 5], ['centrality', 10],
    ];
    const headerLine = headers.map(([h, w]) => pad(h, w)).join(' | ');
    console.log(headerLine);
    console.log('-'.repeat(headerLine.length));
    for (const r of rows) {
        const cells = [
            [r.relPath, 52],
            [r.blocks, 4], [r.defBlocks, 4], [r.scopeBlocks, 4], [r.injectionBlocks, 4], [r.importBlocks, 4], [r.anchorSplits, 4],
            [r.sageCore, 5], [r.eligible, 10], [r.dropped, 6], [r.renderedSize, 7], [r.ratio, 7],
            [r.compressFile, 13], [r.bandSatisfied, 7], [r.h17, 5], [r.centrality, 10],
        ];
        console.log(cells.map(([c, w]) => pad(c, w)).join(' | '));
    }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(96));
    console.log('Wave 2 / T7 — Scope-Aware Tiling Payoff Measurement');
    console.log('='.repeat(96));
    console.log(`REPO_ROOT (resolved): ${REPO_ROOT}`);
    const sampleTarget = path.join(REPO_ROOT, TARGETS[0]);
    console.log(`findRepoRoot('${TARGETS[0]}') => ${String(findRepoRoot(sampleTarget))}`);
    console.log('(findRepoRoot is null here because this checkout has no .git; the harness pins');
    console.log(' the monorepo root explicitly so real facts flow — see header note.)');
    console.log(`maxChars = floor(srcLen * ${MAXCHARS_FRACTION}); band = ${BAND_LO * 100}-${BAND_HI * 100}%`);
    console.log('');

    const db = getDb(REPO_ROOT);

    const rows = [];
    for (const relPath of TARGETS) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: shared DB, deterministic order
        const row = await measureFile(db, relPath);
        rows.push(row);
    }

    // ── FIDELITY VIOLATIONS FIRST (above everything), then exit non-zero. ────────
    const violations = rows.filter(r => r.violation !== null).map(r => r.violation);
    if (violations.length > 0) {
        console.log('');
        console.log('#'.repeat(96));
        console.log('### FIDELITY VIOLATION(S) DETECTED — Priority 0 line-number fidelity broken. ###');
        console.log('#'.repeat(96));
        for (const v of violations) {
            console.log(`FILE:     ${v.relPath}`);
            console.log(`SOURCE:   ${v.source}${v.kind ? ` (${v.kind})` : ''}`);
            if (v.line !== undefined) console.log(`LINE:     ${v.line}`);
            if (v.expected !== undefined) console.log(`EXPECTED: ${JSON.stringify(v.expected)}`);
            if (v.got !== undefined) console.log(`GOT:      ${JSON.stringify(v.got)}`);
            if (v.message !== undefined) console.log(`MESSAGE:  ${v.message}`);
            console.log('-'.repeat(72));
        }
        console.log('');
        console.log('Step K table (for context, AFTER the violation report):');
        printStepKTable(rows);
        process.exit(1);
    }

    // ── CENTRALITY ESCALATIONS — prominent, then exit non-zero. ─────────────────
    const escalations = rows.filter(r => r.escalate !== null).map(r => r.escalate);
    if (escalations.length > 0) {
        console.log('');
        console.log('!'.repeat(96));
        console.log('!!! CENTRALITY ESCALATE — subdivision demoted central logic. STOP for a SageRank-side decision. !!!');
        console.log('!'.repeat(96));
        for (const e of escalations) {
            console.log(`FILE: ${e.relPath}`);
            console.log(`WHY:  ${e.note}`);
            if (e.detail !== null) console.log(`DETAIL: ${JSON.stringify(e.detail)}`);
            console.log('-'.repeat(72));
        }
        console.log('');
    }

    // ── Step K table. ───────────────────────────────────────────────────────────
    console.log('');
    console.log('STEP K — PER-FILE MEASUREMENT TABLE');
    console.log('(B=blocks DB=defBlocks SB=scopeBlocks IB=injectionBlocks IMB=importBlocks AS=anchorSplits');
    console.log(' core=sagerank.coreIndices size  elig=eligible(true)/total  drop=dropped  rend=renderedSize');
    console.log(' ratio=out/src  band=gate.bandSatisfied(rendered in/out 68-72%)  H1-7=verifyOutput+H2 spot)');
    console.log('');
    printStepKTable(rows);

    // ── Per-file notes (cross-checks, null reasons, centrality detail). ──────────
    console.log('');
    console.log('NOTES (cross-checks, null reasons, centrality detail):');
    for (const r of rows) {
        if (r.notes.length === 0) continue;
        console.log(`  ${r.relPath}:`);
        for (const note of r.notes) console.log(`     - ${note}`);
    }

    // ── Summary against the expected outcome. ────────────────────────────────────
    const stringRows = rows.filter(r => r.compressFile.startsWith('STRING'));
    const denseStringRows = stringRows.filter(r => DENSE_TARGETS.includes(r.relPath));
    const normalRows = rows.filter(r => NORMAL_TARGETS.includes(r.relPath));
    const normalStringRows = normalRows.filter(r => r.compressFile.startsWith('STRING'));
    console.log('');
    console.log('SUMMARY (vs expected outcome):');
    console.log(`  files measured:              ${rows.length}`);
    console.log(`  compressFile => STRING:      ${stringRows.length}  [${stringRows.map(r => path.basename(r.relPath)).join(', ')}]`);
    console.log(`  dense engine targets STRING: ${denseStringRows.length}/${DENSE_TARGETS.length}  [${denseStringRows.map(r => path.basename(r.relPath)).join(', ') || 'none'}]`);
    console.log(`  normal targets STRING:       ${normalStringRows.length}/${NORMAL_TARGETS.length}  (no-regress check)`);
    console.log(`  fidelity violations:         ${violations.length}`);
    console.log(`  centrality escalations:      ${escalations.length}`);

    if (escalations.length > 0) {
        console.log('');
        console.log('EXIT: non-zero (centrality escalation).');
        process.exit(1);
    }
    console.log('');
    console.log('EXIT: 0 (no fidelity violation, no centrality escalation).');
    console.log('Note: a STRING anywhere proves the success path (compressFile + verifyOutput +');
    console.log('independent H2 + centrality gate) end-to-end; null rows print blocks/eligible/');
    console.log('dropped (or the reason, e.g. the removal DP resource guard) so incompressible-vs-');
    console.log('needs-tuning is visible — feeding L1 (LARGE_BLOCK_LINES) and the DP bound.');
    process.exit(0);
}

main().catch((err) => {
    console.error('FATAL (measurement harness itself failed — not a compression result):');
    console.error(err);
    process.exit(2);
});
