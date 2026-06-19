#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const repoRoot = path.resolve(args.includes('--repo')
  ? args[args.indexOf('--repo') + 1]
  : process.cwd());

const keepTemp = args.includes('--keep');
const installWinner = args.includes('--install-winner');
const allVersions = args.includes('--all');
const maxArg = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 16;
const probeRoot = path.resolve(args.includes('--probe-root')
  ? args[args.indexOf('--probe-root') + 1]
  : path.join(os.tmpdir(), `zenith-vue-wasm-probe-${Date.now()}-${process.pid}`));
const explicitStart = args.indexOf('--');
const explicitCandidates = explicitStart === -1 ? [] : args.slice(explicitStart + 1).filter(Boolean);
const githubRefLimit = args.includes('--github-ref-limit') ? Number(args[args.indexOf('--github-ref-limit') + 1]) : 12;
const extraGithubRepos = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--github-repo' && args[i + 1]) extraGithubRepos.push(args[i + 1]);
}
const githubRepos = [...new Set([
  'tree-sitter-grammars/tree-sitter-vue',
  'ikatyang/tree-sitter-vue',
  ...extraGithubRepos,
])];

const mcpPkgPath = path.join(repoRoot, 'packages/zenith-mcp/package.json');
const grammarDest = path.join(repoRoot, 'packages/zenith-mcp/grammars/grammars/tree-sitter-vue.wasm');
const sampleVueFixtures = [
  {
    name: 'script-setup-ts',
    source: `<template>
  <section class="card">{{ msg }}</section>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
const msg = ref('hello zenith');
const upper = computed(() => msg.value.toUpperCase());
</script>

<style scoped>
.card { color: rebeccapurple; }
</style>
`,
  },
  {
    name: 'classic-script',
    source: `<template><button>{{ count }}</button></template>
<script>
export default {
  data() {
    return { count: 0 };
  }
};
</script>
`,
  },
  {
    name: 'template-only',
    source: `<template>
  <ul><li v-for="item in items" :key="item.id">{{ item.name }}</li></ul>
</template>
`,
  },
];

function usageAndExit() {
  console.log(`Usage:
  node packages/zenith-mcp/scripts/probe-vue-tree-sitter-wasm.mjs [--max 16] [--all] [--keep] [--install-winner]
  node packages/zenith-mcp/scripts/probe-vue-tree-sitter-wasm.mjs --probe-root .tmp/vue-wasm-probe --keep
  node packages/zenith-mcp/scripts/probe-vue-tree-sitter-wasm.mjs --github-repo DerekStride/tree-sitter-vue --github-ref-limit 30
  node packages/zenith-mcp/scripts/probe-vue-tree-sitter-wasm.mjs -- tree-sitter-vue@0.2.0 tree-sitter-vue@github:tree-sitter-grammars/tree-sitter-vue#22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff

What it does:
  1. Checks Zenith's current Vue WASM first without risking GOT poison
  2. Creates isolated temp package dirs
  3. Installs candidate tree-sitter-vue versions/specs
  4. Builds tree-sitter-vue.wasm
  5. Rejects Emscripten PIC side-module WASMs before loading
  6. Loads each WASM in a fresh node process with web-tree-sitter
  7. Parses a small Vue SFC and reports the first compatible candidate
`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) usageAndExit();

function run(command, cmdArgs, options = {}) {
  const res = spawnSync(command, cmdArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 1024 * 1024 * 20,
  });

  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout?.trim() ?? '',
    stderr: res.stderr?.trim() ?? '',
    command: [command, ...cmdArgs].join(' '),
  };
}

function shortOutput(result) {
  return [result.stderr, result.stdout]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .slice(-16)
    .join('\n');
}

function specSlug(spec) {
  return spec.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
}

function packageInstallSpec(candidate) {
  if (candidate.startsWith('tree-sitter-vue@')) return candidate;
  if (candidate.startsWith('github:') || candidate.startsWith('git+') || candidate.startsWith('https://')) {
    return `tree-sitter-vue@${candidate}`;
  }
  if (/^\d+\.\d+\.\d+/.test(candidate)) return `tree-sitter-vue@${candidate}`;
  return candidate;
}

function normalizeCandidate(rawCandidate) {
  if (rawCandidate.startsWith('cargo:')) {
    const crateSpec = rawCandidate.slice('cargo:'.length);
    return {
      mode: 'cargo',
      label: rawCandidate,
      crateSpec,
    };
  }

  if (rawCandidate === 'vue-wasm' || rawCandidate.startsWith('vue-wasm@')) {
    const depSpec = rawCandidate === 'vue-wasm' ? 'latest' : rawCandidate.replace(/^vue-wasm@/, '');
    return {
      mode: 'npm',
      label: `vue-wasm@${depSpec}`,
      packageName: 'vue-wasm',
      depSpec,
    };
  }

  const installSpec = packageInstallSpec(rawCandidate);
  return {
    mode: 'npm',
    label: installSpec,
    packageName: 'tree-sitter-vue',
    depSpec: installSpec.replace(/^tree-sitter-vue@/, ''),
  };
}

function newestSemverFirst(versions) {
  return [...versions].sort((a, b) => {
    const pa = a.split(/[.-]/).map(x => Number.parseInt(x, 10));
    const pb = b.split(/[.-]/).map(x => Number.parseInt(x, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const av = Number.isFinite(pa[i]) ? pa[i] : 0;
      const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (av !== bv) return bv - av;
    }
    return b.localeCompare(a);
  });
}

async function readRepoTreeSitterVersions() {
  const raw = await fs.readFile(mcpPkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return {
    webTreeSitter: pkg.dependencies?.['web-tree-sitter'] ?? '^0.26.9',
    treeSitterCli: pkg.devDependencies?.['tree-sitter-cli'] ?? '^0.26.9',
  };
}

function discoverNpmCandidates(max) {
  const result = run('pnpm', ['view', 'tree-sitter-vue', 'versions', '--json']);
  if (!result.ok) {
    console.warn(`[warn] Could not query npm versions for tree-sitter-vue. Falling back to hand-picked candidates.\n${shortOutput(result)}\n`);
    return ['tree-sitter-vue@latest'];
  }

  let versions;
  try {
    versions = JSON.parse(result.stdout);
  } catch {
    console.warn('[warn] pnpm view returned non-JSON output. Falling back to tree-sitter-vue@latest.');
    return ['tree-sitter-vue@latest'];
  }

  const sorted = newestSemverFirst(Array.isArray(versions) ? versions : [versions]);
  const picked = allVersions ? sorted : sorted.slice(0, max);
  return picked.map(v => `tree-sitter-vue@${v}`);
}

function discoverGithubCandidates(repo, maxRefs) {
  const base = `tree-sitter-vue@github:${repo}`;
  const result = run('git', ['ls-remote', '--heads', '--tags', '--refs', `https://github.com/${repo}.git`]);
  if (!result.ok) {
    console.warn(`[warn] Could not query GitHub refs for ${repo}. Keeping floating HEAD only.\n${shortOutput(result)}\n`);
    return [base];
  }

  const refs = result.stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .map(ref => {
      if (ref.startsWith('refs/heads/')) return { kind: 'head', name: ref.slice('refs/heads/'.length) };
      if (ref.startsWith('refs/tags/')) return { kind: 'tag', name: ref.slice('refs/tags/'.length) };
      return null;
    })
    .filter(Boolean)
    .filter(ref => !ref.name.includes('^{}'));

  const mainish = refs.filter(ref => ref.kind === 'head' && ['main', 'master'].includes(ref.name));
  const tags = newestSemverFirst(refs.filter(ref => ref.kind === 'tag').map(ref => ref.name)).map(name => ({ kind: 'tag', name }));
  const heads = refs.filter(ref => ref.kind === 'head' && !['main', 'master'].includes(ref.name));
  const picked = [...mainish, ...tags, ...heads].slice(0, maxRefs);

  return [base, ...picked.map(ref => `${base}#${ref.name}`)];
}

function isPicSideModule(bytes) {
  if (bytes.length < 8) return false;
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return false;
  return bytes.includes('GOT.func') && bytes.includes('external_scanner');
}

async function fileHash(file) {
  const bytes = await fs.readFile(file);
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

async function writePackageJson(tmp, versions, candidate) {
  const pkg = {
    private: true,
    type: 'module',
    dependencies: {
      'web-tree-sitter': versions.webTreeSitter,
      'tree-sitter-cli': versions.treeSitterCli,
      [candidate.packageName]: candidate.depSpec,
    },
  };
  await fs.writeFile(path.join(tmp, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await fs.writeFile(
    path.join(tmp, 'pnpm-workspace.yaml'),
    `allowBuilds:\n  tree-sitter-cli: true\n  ${candidate.packageName}: true\n`
  );
}

async function packageNameAt(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    return JSON.parse(raw).name ?? null;
  } catch {
    return null;
  }
}

function hasTreeSitterGrammar(dir) {
  return existsSync(path.join(dir, 'grammar.js')) || existsSync(path.join(dir, 'src/grammar.json'));
}

async function findPackageDir(tmp, packageName = 'tree-sitter-vue') {
  const direct = path.join(tmp, 'node_modules', packageName);
  if (existsSync(direct)) return await fs.realpath(direct).catch(() => direct);

  const roots = [path.join(tmp, 'node_modules/.pnpm'), path.join(tmp, 'node_modules')].filter(existsSync);
  const stack = [...roots];
  const seen = new Set();

  while (stack.length) {
    const dir = stack.pop();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);

    if (path.basename(dir) === packageName || await packageNameAt(dir) === packageName) {
      return await fs.realpath(dir).catch(() => dir);
    }

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (
        entry.name === 'node_modules' ||
        entry.name === packageName ||
        entry.name.includes(packageName) ||
        dir.includes(`${path.sep}.pnpm`)
      ) {
        stack.push(full);
      }
    }
  }

  return null;
}

async function findNewestWasm(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.wasm')) {
        const stat = await fs.stat(full);
        found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return found[0]?.file ?? null;
}

function treeSitterBinFor(tmp) {
  const bins = [
    path.join(tmp, 'node_modules/.bin/tree-sitter'),
    path.join(tmp, 'node_modules/tree-sitter-cli/tree-sitter'),
    path.join(repoRoot, 'packages/zenith-mcp/node_modules/.bin/tree-sitter'),
    path.join(repoRoot, 'packages/zenith-mcp/node_modules/tree-sitter-cli/tree-sitter'),
  ];
  return bins.find(existsSync) ?? bins[0];
}

async function tryBuild(treeSitterBin, grammarDir, wasmPath) {
  const attempts = [
    ['build', '--wasm'],
    ['build', '--wasm', '.'],
    ['build', '-w'],
    ['build'],
    ['build', '--wasm', '-o', wasmPath],
    ['build', '--wasm', '--output', wasmPath],
  ];

  const failures = [];
  for (const attempt of attempts) {
    await fs.rm(wasmPath, { force: true });
    const result = run(treeSitterBin, attempt, { cwd: grammarDir });

    if (result.ok) {
      if (existsSync(wasmPath)) return { ok: true, attempt, output: shortOutput(result) };
      const emitted = await findNewestWasm(grammarDir);
      if (emitted) {
        await fs.copyFile(emitted, wasmPath);
        return { ok: true, attempt, output: `${shortOutput(result)}\nemitted ${emitted}`.trim() };
      }
    }

    failures.push(`$ tree-sitter ${attempt.join(' ')}\n${shortOutput(result) || '(no output)'}`);
  }

  return { ok: false, output: failures.join('\n\n---\n\n') };
}

function parseWithFreshNode(cwd, wasmPath) {
  const code = `
    import { Parser, Language } from 'web-tree-sitter';
    import { copyFileSync, existsSync } from 'node:fs';
    import path from 'node:path';
    import { createRequire } from 'node:module';

    const fixtures = ${JSON.stringify(sampleVueFixtures)};
    const require = createRequire(import.meta.url);
    const webTreeSitterEntry = require.resolve('web-tree-sitter');
    const webTreeSitterDir = path.dirname(webTreeSitterEntry);
    const zenithRuntimeWasm = ${JSON.stringify(path.join(repoRoot, 'packages/zenith-mcp/grammars/tree-sitter.wasm'))};

    function ensureRuntimeAlias() {
      const expected = path.join(webTreeSitterDir, 'tree-sitter.wasm');
      const shipped = path.join(webTreeSitterDir, 'web-tree-sitter.wasm');
      if (!existsSync(expected) && existsSync(shipped)) {
        try { copyFileSync(shipped, expected); } catch {}
      }
    }

    function locateRuntimeWasm(fileName) {
      const candidates = [
        path.join(webTreeSitterDir, fileName),
        path.join(webTreeSitterDir, 'web-tree-sitter.wasm'),
        path.join(webTreeSitterDir, 'tree-sitter.wasm'),
        zenithRuntimeWasm,
      ];
      const found = candidates.find(existsSync);
      if (!found) return path.join(webTreeSitterDir, fileName);
      return found;
    }

    function scan(node, stats) {
      if (node.type === 'ERROR' || node.hasError) stats.errorCount += 1;
      if (node.isMissing) stats.missingCount += 1;
      stats.nodeCount += 1;
      for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child) scan(child, stats);
      }
    }

    ensureRuntimeAlias();
    await Parser.init({ locateFile: locateRuntimeWasm });
    const language = await Language.load(${JSON.stringify(wasmPath)});
    const parser = new Parser();
    parser.setLanguage(language);

    const parsed = [];
    for (const fixture of fixtures) {
      const tree = parser.parse(fixture.source);
      const stats = { errorCount: 0, missingCount: 0, nodeCount: 0 };
      scan(tree.rootNode, stats);
      parsed.push({
        name: fixture.name,
        root: tree.rootNode.type,
        hasError: tree.rootNode.hasError,
        childCount: tree.rootNode.namedChildCount,
        nodeCount: stats.nodeCount,
        errorCount: stats.errorCount,
        missingCount: stats.missingCount,
        preview: tree.rootNode.toString().slice(0, 300),
      });
    }

    console.log(JSON.stringify({ parsed }));
  `;

  const result = run(process.execPath, ['--input-type=module', '-e', code], { cwd });
  if (!result.ok) return { ok: false, output: shortOutput(result) };

  try {
    const parsed = JSON.parse(result.stdout.split('\n').at(-1));
    const bad = parsed.parsed.find(f => f.hasError || f.errorCount > 0 || f.missingCount > 0 || f.childCount === 0);
    if (bad) {
      return {
        ok: false,
        output: `${bad.name}: root=${bad.root} errors=${bad.errorCount} missing=${bad.missingCount} children=${bad.childCount}\n${bad.preview}`,
      };
    }
    return { ok: true, parsed };
  } catch {
    return { ok: false, output: result.stdout || result.stderr || 'parse script produced no JSON' };
  }
}

async function inspectExistingWasm(label, wasmPath, parseCwd) {
  if (!existsSync(wasmPath)) return { label, ok: false, stage: 'missing', detail: wasmPath };
  const bytes = await fs.readFile(wasmPath);
  const base = { label, size: bytes.length, hash: await fileHash(wasmPath) };

  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    return { ...base, ok: false, stage: 'wasm', detail: 'not a valid wasm module' };
  }

  if (isPicSideModule(bytes)) {
    return {
      ...base,
      ok: false,
      stage: 'pic-side-module',
      detail: 'contains both GOT.func and external_scanner; skipped before Language.load()'
    };
  }

  const parse = parseWithFreshNode(parseCwd, wasmPath);
  if (!parse.ok) return { ...base, ok: false, stage: 'parse', detail: parse.output };
  const fixtures = parse.parsed.parsed;
  const roots = fixtures.map(f => `${f.name}:${f.root}/${f.nodeCount}`).join(', ');
  return { ...base, ok: true, stage: 'ok', detail: `fixtures=${fixtures.length} ${roots}` };
}

async function findCargoPackageDir(tmp, crateName) {
  const metadata = run('cargo', ['metadata', '--format-version', '1'], { cwd: tmp });
  if (!metadata.ok) return null;

  try {
    const parsed = JSON.parse(metadata.stdout);
    const pkg = parsed.packages?.find(p => p.name === crateName && p.manifest_path && !p.manifest_path.startsWith(tmp));
    return pkg?.manifest_path ? path.dirname(pkg.manifest_path) : null;
  } catch {
    return null;
  }
}

async function writeToolPackageJson(tmp, versions) {
  const pkg = {
    private: true,
    type: 'module',
    dependencies: {
      'web-tree-sitter': versions.webTreeSitter,
      'tree-sitter-cli': versions.treeSitterCli,
    },
  };
  await fs.writeFile(path.join(tmp, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await fs.writeFile(
    path.join(tmp, 'pnpm-workspace.yaml'),
    'allowBuilds:\n  tree-sitter-cli: true\n'
  );
}

async function testCargoCandidate(candidate, versions) {
  const installSpec = candidate.label;
  const crateName = candidate.crateSpec.split('@')[0];
  const tmp = path.join(probeRoot, specSlug(installSpec));
  const wasmPath = path.join(tmp, 'tree-sitter-vue.wasm');

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'Cargo.toml'), '[package]\nname = "zenith_vue_wasm_probe"\nversion = "0.0.0"\nedition = "2021"\n');
  await fs.writeFile(path.join(tmp, 'src/lib.rs'), 'pub fn probe() {}\n');

  const cargoAdd = run('cargo', ['add', candidate.crateSpec], { cwd: tmp });
  if (!cargoAdd.ok) return { candidate: installSpec, ok: false, stage: 'cargo-add', detail: shortOutput(cargoAdd), tmp };

  const packageDir = await findCargoPackageDir(tmp, crateName);
  if (!packageDir || !existsSync(packageDir)) {
    return { candidate: installSpec, ok: false, stage: 'cargo-locate', detail: `could not locate cargo package source for ${crateName}`, tmp };
  }

  await writeToolPackageJson(tmp, versions);
  const toolInstall = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: tmp });
  if (!toolInstall.ok) return { candidate: installSpec, ok: false, stage: 'tool-install', detail: shortOutput(toolInstall), tmp };

  const treeSitterBin = treeSitterBinFor(tmp);
  if (!existsSync(treeSitterBin)) return { candidate: installSpec, ok: false, stage: 'cli', detail: `missing tree-sitter CLI; tried ${treeSitterBin}`, tmp };

  const shippedWasm = await findNewestWasm(packageDir);
  if (shippedWasm) {
    await fs.copyFile(shippedWasm, wasmPath);
    const shipped = await inspectExistingWasm(installSpec, wasmPath, tmp);
    if (shipped.ok) {
      return {
        candidate: installSpec,
        ok: true,
        stage: 'ok',
        detail: `${shipped.detail} source=cargo-shipped ${shippedWasm}`,
        tmp,
        wasmPath,
        size: shipped.size,
        hash: shipped.hash,
      };
    }
  }

  const build = await tryBuild(treeSitterBin, packageDir, wasmPath);
  if (!build.ok) return { candidate: installSpec, ok: false, stage: 'cargo-build', detail: build.output, tmp };

  const inspected = await inspectExistingWasm(installSpec, wasmPath, tmp);
  return {
    candidate: installSpec,
    ok: inspected.ok,
    stage: inspected.stage,
    detail: inspected.detail,
    tmp,
    wasmPath,
    size: inspected.size,
    hash: inspected.hash,
  };
}

async function testCandidate(rawCandidate, versions) {
  const candidate = normalizeCandidate(rawCandidate);
  if (candidate.mode === 'cargo') return testCargoCandidate(candidate, versions);

  const installSpec = candidate.label;
  const tmp = path.join(probeRoot, specSlug(installSpec));
  const wasmPath = path.join(tmp, 'tree-sitter-vue.wasm');

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await writePackageJson(tmp, versions, candidate);

  const install = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: tmp });

  const packageDir = await findPackageDir(tmp, candidate.packageName);
  const treeSitterBin = treeSitterBinFor(tmp);

  if (!install.ok && (!packageDir || !existsSync(packageDir))) {
    return { candidate: installSpec, ok: false, stage: 'install', detail: shortOutput(install), tmp };
  }

  if (!packageDir || !existsSync(packageDir)) return { candidate: installSpec, ok: false, stage: 'locate', detail: `missing installed package ${candidate.packageName} under ${tmp}`, tmp };
  if (!existsSync(treeSitterBin)) return { candidate: installSpec, ok: false, stage: 'cli', detail: `missing tree-sitter CLI; tried ${treeSitterBin}`, tmp };

  const shippedWasm = await findNewestWasm(packageDir);
  if (shippedWasm) {
    await fs.copyFile(shippedWasm, wasmPath);
    const shipped = await inspectExistingWasm(installSpec, wasmPath, tmp);
    if (shipped.ok) {
      return {
        candidate: installSpec,
        ok: true,
        stage: 'ok',
        detail: `${shipped.detail} source=shipped ${shippedWasm}`,
        tmp,
        wasmPath,
        size: shipped.size,
        hash: shipped.hash,
      };
    }
  }

  if (!hasTreeSitterGrammar(packageDir)) {
    return { candidate: installSpec, ok: false, stage: 'no-grammar', detail: `package installed at ${packageDir}, but no grammar.js or src/grammar.json and no parseable shipped wasm`, tmp };
  }

  const build = await tryBuild(treeSitterBin, packageDir, wasmPath);
  if (!build.ok) return { candidate: installSpec, ok: false, stage: 'build', detail: build.output, tmp };

  const inspected = await inspectExistingWasm(installSpec, wasmPath, tmp);
  return {
    candidate: installSpec,
    ok: inspected.ok,
    stage: inspected.stage,
    detail: inspected.detail,
    tmp,
    wasmPath,
    size: inspected.size,
    hash: inspected.hash,
  };
}

async function main() {
  if (!existsSync(mcpPkgPath)) {
    throw new Error(`Run this from the repo root or pass --repo. Missing ${mcpPkgPath}`);
  }

  const versions = await readRepoTreeSitterVersions();
  await fs.mkdir(probeRoot, { recursive: true });

  console.log(`Repo: ${repoRoot}`);
  console.log(`Probe root: ${probeRoot}`);
  console.log(`web-tree-sitter: ${versions.webTreeSitter}`);
  console.log(`tree-sitter-cli: ${versions.treeSitterCli}`);

  const current = await inspectExistingWasm('current Zenith tree-sitter-vue.wasm', grammarDest, path.dirname(mcpPkgPath));
  const currentExtra = current.size ? ` size=${current.size} sha256=${current.hash}` : '';
  console.log(`current wasm: ${current.ok ? 'PASS' : `fail:${current.stage}`}${currentExtra}`);
  if (current.detail) console.log(`  ${current.detail}`);

  const discovered = explicitCandidates.length ? explicitCandidates : discoverNpmCandidates(maxArg);
  const githubCandidates = explicitCandidates.length
    ? []
    : githubRepos.flatMap(repo => discoverGithubCandidates(repo, githubRefLimit));
  const candidates = [...new Set([
    ...discovered,
    'vue-wasm@latest',
    'cargo:tree-sitter-vue@=0.0.2',
    ...githubCandidates,
    'tree-sitter-vue@github:tree-sitter-grammars/tree-sitter-vue#22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff',
  ])];

  console.log(`GitHub repos: ${explicitCandidates.length ? '(skipped because explicit candidates were supplied)' : githubRepos.join(', ')}`);
  console.log(`Candidates: ${candidates.length}\n`);

  let winner = null;
  const results = [];

  for (const candidate of candidates) {
    process.stdout.write(`testing ${candidate} ... `);
    const result = await testCandidate(candidate, versions);
    results.push(result);

    if (result.ok) {
      console.log(`PASS ${result.detail} size=${result.size} sha256=${result.hash}`);
      winner = result;
      break;
    }

    console.log(`fail:${result.stage}`);
    if (result.detail) {
      const detail = String(result.detail).split('\n').slice(0, 8).join('\n  ');
      console.log(`  ${detail}`);
    }
  }

  console.log('\nResults:');
  console.log(`  ${current.ok ? '✓' : '✗'} current Zenith tree-sitter-vue.wasm :: ${current.stage}${current.size ? ` size=${current.size} sha256=${current.hash}` : ''}`);
  for (const result of results) {
    const extra = result.ok
      ? `${result.detail} size=${result.size} sha256=${result.hash}`
      : `${result.stage}${result.size ? ` size=${result.size} sha256=${result.hash}` : ''}${result.detail ? ` :: ${String(result.detail).split('\n')[0]}` : ''}`;
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.candidate} :: ${extra}`);
  }

  if (!winner) {
    console.log('\nNo compatible Vue WASM found. Re-run with --all or explicit git refs after --.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nWinner: ${winner.candidate}`);
  console.log(`WASM:   ${winner.wasmPath}`);

  if (installWinner) {
    await fs.copyFile(winner.wasmPath, grammarDest);
    console.log(`Installed winner to ${grammarDest}`);
  } else {
    console.log('\nTo install it:');
    console.log(`  cp ${winner.wasmPath} ${grammarDest}`);
    console.log('  pnpm --filter zenith-mcp run build');
  }

  if (!keepTemp) {
    console.log('\nTemp dirs kept for the winner only. Use --keep to keep every failed attempt.');
    for (const result of results) {
      if (result.tmp !== winner.tmp) await fs.rm(result.tmp, { recursive: true, force: true });
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
