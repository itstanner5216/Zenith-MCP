// ---------------------------------------------------------------------------
// shared.js — Updated shared module
//
// Changes from original:
//   1. Added inline BM25 engine (BM25Index class) — zero external deps,
//      ~120 lines. TAAT posting-list architecture, Lucene-variant IDF
//      (always non-negative), code-aware tokenizer (/[a-z0-9_]+/).
//   2. Added buildFileCorpus() helper for pre-filter mode — uses ripgrep
//      for file discovery (respects .gitignore automatically), falls back
//      to manual walk. Builds BM25 docs from file content.
//   3. Added rankResults() helper for post-filter mode — takes raw ripgrep
//      result lines and returns BM25-ranked slice within a char budget.
//   4. Existing ripgrepSearch / ripgrepFindFiles / isSensitive untouched
//      except minor robustness improvements.
// ---------------------------------------------------------------------------

import fs from "fs/promises";
import { createReadStream } from "fs";
import { constants as fsConstants } from "fs";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Dynamic char budget — right-sizes to the model's actual context capacity.
// Defaults to 400k (safe margin under Claude's 500k limit).
// Override via CHAR_BUDGET env var for models with different limits.
export const CHAR_BUDGET = (() => {
    const env = process.env.CHAR_BUDGET;
    if (env) {
        const trimmed = env.trim();
        if (/^\s*[+-]?\d+\s*$/.test(trimmed)) {
            const parsed = parseInt(trimmed, 10);
            if (!isNaN(parsed) && parsed >= 10_000 && parsed <= 2_000_000) return parsed;
        }
    }
    return 400_000;
})();
export const RANK_THRESHOLD = 50;   // BM25 only kicks in above this count

export const DEFAULT_EXCLUDES = (process.env.DEFAULT_EXCLUDES ||
    'node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo'
).split(',').map(p => p.trim()).filter(Boolean);

export const SENSITIVE_PATTERNS = (process.env.SENSITIVE_PATTERNS ||
    '**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**'
).split(',').map(p => p.trim()).filter(Boolean);

export function isSensitive(filePath) {
    const rel = path.relative(os.homedir(), filePath);
    return SENSITIVE_PATTERNS.some(pat =>
        minimatch(rel, pat, { dot: true, nocase: true }) ||
        minimatch(path.basename(filePath), pat.replace(/\*\*\//g, ''), { dot: true, nocase: true })
    );
}

// ---------------------------------------------------------------------------
// BM.X-T Engine — entropy-weighted TAAT search, zero deps
// ---------------------------------------------------------------------------

const WORD_RE = /[a-z0-9_]+/g;

export class BM25Index {
    constructor(k1 = 1.2, b = 0.75, beta = 0.6) {
        this.k1 = k1;
        this.b = b;
        this.beta = beta;
        this._postingLists = new Map(); // term -> Map<docId, tf>
        this._docLengths = new Map();   // docId -> tokenCount
        this._avgDocLength = 0;
        this._idfCache = new Map();     // term -> idf
        this._termEntropy = new Map();  // term -> normalized entropy [0,1]
        this._termTotalFreqs = new Map(); // term -> total tf across corpus
        this._totalDocs = 0;
    }

    static tokenize(text) {
        if (!text) return [];
        const tokens = text.toLowerCase().match(WORD_RE);
        if (!tokens) return [];
        return tokens.filter(t => t.length > 1 || t === 'a' || t === 'i');
    }

    /**
     * Build index from array of { id: string, text: string }.
     */
    build(docs) {
        this._postingLists.clear();
        this._docLengths.clear();
        this._idfCache.clear();
        this._termEntropy.clear();
        this._termTotalFreqs.clear();

        let totalLength = 0;

        // Pass 1: tokenize, build inverted index
        for (const doc of docs) {
            if (!doc.id) continue;
            const tokens = BM25Index.tokenize(doc.text);
            this._docLengths.set(doc.id, tokens.length);
            totalLength += tokens.length;

            const tfMap = new Map();
            for (const token of tokens) {
                tfMap.set(token, (tfMap.get(token) || 0) + 1);
            }

            for (const [term, count] of tfMap) {
                if (!this._postingLists.has(term)) {
                    this._postingLists.set(term, new Map());
                }
                this._postingLists.get(term).set(doc.id, count);
                this._termTotalFreqs.set(term, (this._termTotalFreqs.get(term) || 0) + count);
            }
        }

        this._totalDocs = this._docLengths.size;
        if (this._totalDocs === 0) return;
        this._avgDocLength = totalLength / this._totalDocs;

        // Pass 2: IDF
        for (const [term, posting] of this._postingLists) {
            const df = posting.size;
            this._idfCache.set(term, Math.log((this._totalDocs - df + 0.5) / (df + 0.5) + 1));
        }

        // Pass 3: per-term entropy
        for (const [term, posting] of this._postingLists) {
            const totalTf = this._termTotalFreqs.get(term);
            const nDocs = posting.size;
            if (totalTf === 0 || nDocs <= 1) {
                this._termEntropy.set(term, 0);
                continue;
            }
            let entropy = 0;
            for (const tf of posting.values()) {
                const p = tf / totalTf;
                entropy -= p * Math.log(p);
            }
            const maxEntropy = Math.log(nDocs);
            this._termEntropy.set(term, maxEntropy > 0 ? entropy / maxEntropy : 0);
        }
    }

    /**
     * TAAT search with entropy-weighted scoring and sigmoid TF saturation.
     * Returns array of { id, score } sorted desc, scores normalized to [0, 1].
     */
    search(query, topK = 200) {
        if (this._totalDocs === 0 || !query) return [];

        const queryTokens = BM25Index.tokenize(query);
        if (queryTokens.length === 0) return [];

        // Count query term frequencies
        const qtfMap = new Map();
        for (const t of queryTokens) qtfMap.set(t, (qtfMap.get(t) || 0) + 1);

        // Pre-compute per-term weights and max_possible
        const termWeights = new Map();
        let maxPossible = 0;

        for (const [term, qtf] of qtfMap) {
            if (!this._postingLists.has(term)) continue;
            const idf = this._idfCache.get(term) || 0;
            const entropy = this._termEntropy.get(term) || 0;
            const weight = idf * (1 + this.beta * (1 - entropy));
            termWeights.set(term, weight);
            maxPossible += weight * qtf;
        }

        if (maxPossible === 0) return [];

        // TAAT: accumulate scores by traversing postings
        const { k1, b, _avgDocLength: avgdl } = this;
        const scores = new Map();

        for (const [term, qtf] of qtfMap) {
            const weight = termWeights.get(term);
            if (weight === undefined) continue;
            const w = weight * qtf;
            const posting = this._postingLists.get(term);

            for (const [docId, tf] of posting) {
                const dl = this._docLengths.get(docId);
                const K = k1 * (1 - b + b * (dl / avgdl));
                // Sigmoid TF saturation
                const tfComponent = 1 / (1 + Math.exp(-k1 * (tf - K / 2) / K));
                scores.set(docId, (scores.get(docId) || 0) + w * tfComponent);
            }
        }

        if (scores.size === 0) return [];

        // Normalize to [0, 1]
        const invMax = 1 / maxPossible;
        const sorted = [...scores.entries()]
            .map(([id, s]) => ({ id, score: s * invMax }))
            .sort((a, b) => b.score - a.score);

        return sorted.slice(0, topK);
    }
}

// ---------------------------------------------------------------------------
// BM25 Helpers for search_files
// ---------------------------------------------------------------------------

/**
 * Post-filter mode: rank raw result lines by BM25, accumulate within charBudget.
 * @param {string[]} lines - raw result lines like "file:line: content"
 * @param {string} query - the content query
 * @param {number} charBudget - max chars to return
 * @returns {{ ranked: string[], totalCount: number }}
 */
export function bm25RankResults(lines, query, charBudget = CHAR_BUDGET) {
    const index = new BM25Index();
    const docs = lines.map((line, i) => ({ id: String(i), text: line }));
    index.build(docs);

    const ranked = index.search(query, lines.length);
    const result = [];
    let charCount = 0;

    for (const { id } of ranked) {
        const line = lines[Number(id)];
        if (charCount + line.length + 1 > charBudget) break;
        result.push(line);
        charCount += line.length + 1; // +1 for newline
    }

    return { ranked: result, totalCount: lines.length };
}

/**
 * Pre-filter mode: build file-level BM25 corpus from directory, rank files.
 * Returns top-k file paths most relevant to the query.
 * @param {string} rootPath - directory to index
 * @param {string} query - natural language query
 * @param {number} topK - number of files to return
 * @param {string[]} excludePatterns - glob patterns to exclude
 * @returns {Promise<string[]>} ranked file paths
 */
export async function bm25PreFilterFiles(rootPath, query, topK = 50, excludePatterns = []) {
    const docs = [];
    const MAX_FILE_SIZE = 512 * 1024; // 512KB max per file for indexing
    const MAX_FILES = 5000;           // cap to prevent runaway on huge repos

    const defaultExcludeGlobs = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);
    const allExcludes = [...excludePatterns, ...defaultExcludeGlobs];

    // Text extensions for BM25 content indexing
    const textExts = new Set([
        '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs',
        '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
        '.cs', '.php', '.vue', '.svelte', '.html', '.css', '.scss',
        '.less', '.json', '.yaml', '.yml', '.toml', '.xml', '.md',
        '.txt', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
        '.sql', '.graphql', '.proto', '.tf', '.hcl', '.lua',
        '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.r',
        '.dockerfile', '.makefile', '.cmake', '.gradle', '.sbt',
        '.env.example', '.gitignore', '.editorconfig',
    ]);

    // Use ripgrep for file discovery when available — automatically respects
    // .gitignore, .ignore, and .rgignore files, eliminating noise from build
    // artifacts, vendored code, and test fixtures that projects exclude.
    const hasRg = await ripgrepAvailable();
    let filePaths = [];

    if (hasRg) {
        const rgFiles = await ripgrepFindFiles(rootPath, {
            maxResults: MAX_FILES,
            excludePatterns: allExcludes,
        });
        if (rgFiles && rgFiles.length > 0) {
            filePaths = rgFiles;
        }
    }

    // JS fallback — manual walk (no .gitignore awareness)
    if (filePaths.length === 0) {
        async function walk(dir) {
            if (filePaths.length >= MAX_FILES) return;
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (filePaths.length >= MAX_FILES) return;
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(rootPath, fullPath);

                if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                const excluded = allExcludes.some(pat =>
                    minimatch(rel, pat, { dot: true }) ||
                    minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true })
                );
                if (excluded) continue;
                if (isSensitive(fullPath)) continue;

                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    filePaths.push(fullPath);
                }
            }
        }
        await walk(rootPath);
    }

    // Index text files with BM25
    for (const fullPath of filePaths) {
        if (docs.length >= MAX_FILES) break;
        const ext = path.extname(fullPath).toLowerCase();
        const nameLC = path.basename(fullPath).toLowerCase();
        const isText = textExts.has(ext) ||
            nameLC === 'dockerfile' || nameLC === 'makefile' ||
            nameLC === 'cmakelists.txt' || nameLC === 'gemfile' ||
            nameLC === 'rakefile' || nameLC === 'justfile' ||
            nameLC.startsWith('.') && !nameLC.includes('.');

        if (!isText) continue;

        try {
            const stat = await fs.stat(fullPath);
            if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

            const content = await fs.readFile(fullPath, 'utf-8');
            const rel = path.relative(rootPath, fullPath);
            const pathTokens = rel.replace(/[/\\]/g, ' ').replace(/\./g, ' ');
            const boostedText = `${pathTokens} ${pathTokens} ${pathTokens} ${content.slice(0, 8192)}`;
            docs.push({ id: fullPath, text: boostedText });
        } catch { /* skip unreadable */ }
    }

    if (docs.length === 0) return [];

    const index = new BM25Index();
    index.build(docs);
    const results = index.search(query, topK);
    return results.map(r => r.id);
}

// ---------------------------------------------------------------------------
// Ripgrep
// ---------------------------------------------------------------------------

export const RG_PATH = '/usr/bin/rg';

export async function ripgrepAvailable() {
    try {
        await fs.access(RG_PATH, fsConstants.X_OK);
        return true;
    } catch { return false; }
}

export async function ripgrepSearch(rootPath, options = {}) {
    const {
        contentQuery, filePattern = null,
        ignoreCase = true, maxResults = 50,
        excludePatterns = [], contextLines = 0,
        literalSearch = false, includeHidden = false,
        fileList = null, // NEW: array of file paths to restrict search to
    } = options;

    const rgArgs = ['--json', '--max-count', '100', '-m', '500'];
    if (ignoreCase) rgArgs.push('-i');
    if (literalSearch) rgArgs.push('-F');
    if (includeHidden) rgArgs.push('--hidden');
    if (contextLines > 0) rgArgs.push('-C', String(contextLines));
    for (const pat of excludePatterns) rgArgs.push('--glob', `!${pat}`);
    if (filePattern) {
        const includeGlob = filePattern.includes('/') ? filePattern : `**/${filePattern}`;
        rgArgs.push('--glob', includeGlob);
    }
    rgArgs.push('--', contentQuery);

    // If fileList is provided, search only those files (pre-filter mode)
    if (fileList && fileList.length > 0) {
        for (const f of fileList) rgArgs.push(f);
    } else {
        rgArgs.push(rootPath);
    }

    return new Promise((resolveP) => {
        const results = [];
        let stderr = '';
        const proc = spawn(RG_PATH, rgArgs, { timeout: 30000 });
        let buffer = '';

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === 'match' && results.length < maxResults) {
                        const d = msg.data;
                        const filePath = d.path?.text;
                        if (filePath && !isSensitive(filePath)) {
                            results.push({
                                file: filePath,
                                line: d.line_number,
                                content: d.lines?.text?.replace(/\n$/, '') || '',
                            });
                        }
                    }
                } catch { /* skip malformed JSON */ }
            }
        });

        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('close', (code) => {
            if (code > 1) {
                console.error('ripgrep exited with code ' + code, stderr.slice(0, 200));
                resolveP(null);
                return;
            }
            resolveP(results);
        });
        proc.on('error', () => resolveP(null));
    });
}

export async function ripgrepFindFiles(rootPath, options = {}) {
    const {
        namePattern = null, pathContains = null,
        maxResults = 100, excludePatterns = [],
    } = options;

    const rgArgs = ['--files'];
    for (const p of DEFAULT_EXCLUDES) {
        rgArgs.push('--glob', `!**/${p}`);
        rgArgs.push('--glob', `!**/${p}/**`);
    }
    for (const pat of excludePatterns) rgArgs.push('--glob', `!${pat}`);
    if (namePattern) rgArgs.push('--glob', namePattern);
    rgArgs.push(rootPath);

    return new Promise((resolveP) => {
        const results = [];
        let buffer = '';
        const proc = spawn(RG_PATH, rgArgs, { timeout: 30000 });

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (pathContains && !trimmed.toLowerCase().includes(pathContains.toLowerCase())) continue;
                if (!isSensitive(trimmed) && results.length < maxResults) results.push(trimmed);
            }
        });

        proc.on('close', () => resolveP(results));
        proc.on('error', () => resolveP(null));
    });
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export async function readFileAsBase64Stream(filePath) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        stream.on('error', reject);
    });
}
