#!/usr/bin/env node
/**
 * POLARIS merge-gate lane verifier.
 *
 * Usage: node .polaris-gate/verify-lane.mjs <lane-branch> [--keep]
 *
 * Mechanics (all read-only against the lane; nothing merges to main here):
 *   1. Scratch worktree at a temp branch from current integration HEAD.
 *   2. Merge the lane branch into the scratch (conflict = verdict, stop).
 *   3. Full rebuild; rebuild failure = verdict, stop.
 *   4. Base + audit suites via vitest JSON reporter.
 *   5. Failure-signature set algebra against the pinned baseline:
 *        newlyGreen        — baseline failures now passing (judge vs assignment)
 *        unchangedFailing  — foreign failures, signature byte-identical (required)
 *        mutatedFailing    — same test, DIFFERENT failure signature (STOP: cross-lane interference)
 *        newlyFailing      — anything red that was green at baseline (STOP: regression)
 *   6. Diff-surface report (files touched vs fork commit) for assignment conformance.
 *
 * Output: .polaris-gate/reports/<branch>-<timestamp>.json plus a console summary.
 * The gate verdict is evidence for the integration lead's accept/reject — the
 * script decides nothing about merging; suggestion is not law here either.
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BASELINE_PATH = join(ROOT, '.polaris-gate', 'audit-baseline-46b341f.json');
const REPORTS_DIR = join(ROOT, '.polaris-gate', 'reports');
const PKG = 'packages/zenith-mcp';

const lane = process.argv[2];
const keep = process.argv.includes('--keep');
if (!lane) {
    console.error('usage: node .polaris-gate/verify-lane.mjs <lane-branch> [--keep]');
    process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

/**
 * Failure signatures can embed run-variant data (mkdtemp roots, g/<sha256(root)>
 * store hashes, timestamps). Normalize both sides before comparison so
 * "mutated" means the failure MODE changed, not that a temp path rolled.
 */
function normalizeSig(sig) {
    return (sig || '')
        .replace(/[0-9a-f]{16,}/gi, '<HEX>')
        .replace(/\/tmp\/[A-Za-z0-9._\/-]+/g, '<TMP>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.\-Z]+/g, '<TS>');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeLane = lane.replace(/[^a-zA-Z0-9_-]/g, '_');
const scratch = `/tmp/polaris-gate-${safeLane}`;
const scratchBranch = `gate/${safeLane}-${stamp}`;
mkdirSync(REPORTS_DIR, { recursive: true });

const report = {
    lane, scratchBranch,
    integrationHead: execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(),
    laneHead: null, startedAt: new Date().toISOString(),
    verdicts: {}, delta: null, diffSurface: null, baseSuite: null,
};

function fail(stage, detail) {
    report.verdicts[stage] = { ok: false, detail };
    finish(1);
}
function finish(code) {
    report.finishedAt = new Date().toISOString();
    const out = join(REPORTS_DIR, `${safeLane}-${stamp}.json`);
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${out}`);
    if (!keep && existsSync(scratch)) {
        try {
            execSync(`git worktree remove --force ${scratch}`, { cwd: ROOT });
            execSync(`git branch -D ${scratchBranch}`, { cwd: ROOT });
        } catch { /* leave for manual cleanup */ }
    }
    process.exit(code);
}

// -- 1/2: scratch worktree + merge ------------------------------------------
try {
    report.laneHead = execSync(`git rev-parse --short ${lane}`, { cwd: ROOT }).toString().trim();
} catch {
    fail('resolve', `lane branch not found: ${lane}`);
}
if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
try { execSync(`git worktree prune`, { cwd: ROOT }); } catch { /* fine */ }
execSync(`git worktree add -b ${scratchBranch} ${scratch} HEAD`, { cwd: ROOT, stdio: 'pipe' });
// Scratch worktrees carry tracked files only; share the installed store the
// same way the lane worktrees do (symlinked node_modules).
for (const rel of ['node_modules', 'packages/zenith-mcp/node_modules', 'packages/zenith-toon/node_modules']) {
    const src = join(ROOT, rel);
    const dst = join(scratch, rel);
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, 'dir');
}
const merge = spawnSync('git', ['merge', '--no-edit', lane], { cwd: scratch, encoding: 'utf8' });
if (merge.status !== 0) {
    fail('merge', `lane does not merge cleanly onto ${report.integrationHead}:\n${merge.stdout}${merge.stderr}`);
}
report.verdicts.merge = { ok: true };

// -- diff surface -------------------------------------------------------------
report.diffSurface = execSync(`git diff --stat HEAD ${lane} -- . ':!*/node_modules/*'`, { cwd: ROOT })
    .toString().trim().split('\n');

// -- 3: rebuild ----------------------------------------------------------------
// NEVER invoke pnpm in the scratch: its deps-status check attempts a modules-dir
// purge, and node_modules here is a SYMLINK into the integration tree (a purge
// would destroy the real install). Execute the package's own rebuild script
// definition directly through the symlinked .bin instead.
const pkgJson = JSON.parse(readFileSync(join(scratch, PKG, 'package.json'), 'utf8'));
const rebuildScript = pkgJson.scripts?.rebuild;
if (!rebuildScript) fail('rebuild', 'no scripts.rebuild in package.json');
const binPath = `${join(scratch, PKG, 'node_modules/.bin')}:${join(scratch, 'node_modules/.bin')}:${process.env.PATH}`;
const build = spawnSync('bash', ['-c', rebuildScript], {
    cwd: join(scratch, PKG), encoding: 'utf8', env: { ...process.env, PATH: binPath },
});
if (build.status !== 0) {
    fail('rebuild', `${(build.stdout || '').slice(-3000)}\n${(build.stderr || '').slice(-2000)}`);
}
report.verdicts.rebuild = { ok: true };

// -- 4: suites -------------------------------------------------------------------
function runVitest(label, extraArgs) {
    const outFile = join(scratch, `.vitest-${label}.json`);
    spawnSync(join(scratch, PKG, 'node_modules/.bin/vitest'),
        ['run', '--reporter=json', `--outputFile=${outFile}`, ...extraArgs],
        { cwd: join(scratch, PKG), encoding: 'utf8' });
    if (!existsSync(outFile)) return null;
    return JSON.parse(readFileSync(outFile, 'utf8'));
}
const full = runVitest('full', []);
if (!full) fail('suite', 'vitest produced no JSON output');

// -- 5: signature algebra ---------------------------------------------------------
const nowFailing = new Map();
const nowPassing = new Set();
for (const tf of full.testResults) {
    const file = tf.name.split('/tests/')[1] ?? tf.name;
    for (const t of tf.assertionResults) {
        const key = `${file}::${t.fullName}`;
        if (t.status === 'passed') nowPassing.add(key);
        else if (t.status === 'failed') nowFailing.set(key, normalizeSig((t.failureMessages?.[0] || '').split('\n')[0]));
    }
}
const baseFailing = new Map(baseline.failing.map((f) => [`${f.file}::${f.test}`, normalizeSig(f.sig)]));
const baseAuditPassing = new Set(baseline.passing.map((f) => `${f.file}::${f.test}`));

const delta = { newlyGreen: [], unchangedFailing: [], mutatedFailing: [], newlyFailing: [] };
for (const [key, sig] of baseFailing) {
    if (nowPassing.has(key)) delta.newlyGreen.push(key);
    else if (nowFailing.has(key)) {
        if (nowFailing.get(key) === sig) delta.unchangedFailing.push(key);
        else delta.mutatedFailing.push({ key, was: sig, now: nowFailing.get(key) });
    } else delta.newlyFailing.push({ key, note: 'baseline failure disappeared without passing (renamed/deleted test?)' });
}
for (const [key, sig] of nowFailing) {
    if (!baseFailing.has(key)) delta.newlyFailing.push({ key, sig });
}
report.delta = delta;
report.baseSuite = {
    totalPassed: nowPassing.size,
    totalFailed: nowFailing.size,
    auditOraclesStillGreen: [...baseAuditPassing].every((k) => !nowFailing.has(k)),
};
report.verdicts.signatures = {
    ok: delta.mutatedFailing.length === 0 && delta.newlyFailing.length === 0,
    newlyGreen: delta.newlyGreen.length,
    unchangedFailing: delta.unchangedFailing.length,
    mutated: delta.mutatedFailing.length,
    newlyFailing: delta.newlyFailing.length,
};

console.log(`\n=== GATE: ${lane} (${report.laneHead}) onto ${report.integrationHead} ===`);
console.log(`merge: clean | rebuild: ok | suite: ${nowPassing.size} passed / ${nowFailing.size} failed`);
console.log(`newly green : ${delta.newlyGreen.length}`); delta.newlyGreen.forEach((k) => console.log(`   + ${k}`));
console.log(`foreign unchanged: ${delta.unchangedFailing.length}`);
if (delta.mutatedFailing.length) { console.log('MUTATED FOREIGN FAILURES (STOP):'); delta.mutatedFailing.forEach((m) => console.log(`   ! ${m.key}`)); }
if (delta.newlyFailing.length) { console.log('NEW FAILURES (STOP):'); delta.newlyFailing.forEach((m) => console.log(`   ! ${m.key}`)); }
console.log(`diff surface: ${report.diffSurface.length - 1} entries (see report)`);
finish(report.verdicts.signatures.ok ? 0 : 1);
