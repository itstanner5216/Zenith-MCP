import fs from "fs/promises";
import { createReadStream } from "fs";
import { constants as fsConstants } from "fs";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import { minimatch } from "minimatch";
import { loadConfig } from '../config/index.js';

const _config = loadConfig();

export const CHAR_BUDGET: number = (() => {
    const val = _config.advanced.char_budget;
    if (typeof val === 'number' && !isNaN(val) && val >= 10_000 && val <= 2_000_000) return val;
    return 400_000;
})();
export const RANK_THRESHOLD = 50;

export const DEFAULT_EXCLUDES: string[] = (() => {
    const raw = _config.advanced.default_excludes;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) return parsed;
    }
    return 'node_modules,.git,.next,.venv,venv,.env.local,dist,build,out,output,.cache,.turbo,.nuxt,.output,.svelte-kit,.parcel-cache,__pycache__,.pytest_cache,.mypy_cache,coverage,.nyc_output,.coverage,.DS_Store,*.min.js,*.min.css,*.map,.tsbuildinfo'
        .split(',').map(p => p.trim()).filter(Boolean);
})();

export const SENSITIVE_PATTERNS: string[] = (() => {
    const raw = _config.advanced.sensitive_patterns;
    if (raw && typeof raw === 'string') {
        const parsed = raw.split(',').map(p => p.trim()).filter(Boolean);
        if (parsed.length > 0) return parsed;
    }
    return '**/.env,**/*.pem,**/*.key,**/*.crt,**/*credentials*,**/*secret*,**/docker-compose.yaml,**/docker-compose.yml,**/.config/**'
        .split(',').map(p => p.trim()).filter(Boolean);
})();

export function isSensitive(filePath: string): boolean {
    const rel = path.relative(os.homedir(), filePath);
    return SENSITIVE_PATTERNS.some(pat =>
        minimatch(rel, pat, { dot: true, nocase: true }) ||
        minimatch(path.basename(filePath), pat.replace(/\*\*\//g, ''), { dot: true, nocase: true })
    );
}

const WORD_RE = /[a-z0-9_]+/g;

export class BM25Index {
    k1: number;
    b: number;
    beta: number;
    _postingLists: Map<string, Map<string, number>>;
    _docLengths: Map<string, number>;
    _avgDocLength: number;
    _idfCache: Map<string, number>;
    _termEntropy: Map<string, number>;
    _termTotalFreqs: Map<string, number>;
    _totalDocs: number;

    constructor(k1 = 1.2, b = 0.75, beta = 0.6) {
        this.k1 = k1;
        this.b = b;
        this.beta = beta;
        this._postingLists = new Map();
        this._docLengths = new Map();
        this._avgDocLength = 0;
        this._idfCache = new Map();
        this._termEntropy = new Map();
        this._termTotalFreqs = new Map();
        this._totalDocs = 0;
    }

    static tokenize(text: string) {
        if (!text) return [];
        const tokens = text.toLowerCase().match(WORD_RE);
        if (!tokens) return [];
        return tokens.filter(t => t.length > 1 || t === 'a' || t === 'i');
    }

    build(docs: Array<{ id: string; text: string }>) {
        this._postingLists.clear();
        this._docLengths.clear();
        this._idfCache.clear();
        this._termEntropy.clear();
        this._termTotalFreqs.clear();
        let totalLength = 0;
        for (const doc of docs) {
            if (!doc.id) continue;
            const tokens = BM25Index.tokenize(doc.text);
            this._docLengths.set(doc.id, tokens.length);
            totalLength += tokens.length;
            const tfMap = new Map<string, number>();
            for (const token of tokens) tfMap.set(token, (tfMap.get(token) || 0) + 1);
            for (const [term, count] of tfMap) {
                if (!this._postingLists.has(term)) this._postingLists.set(term, new Map());
                this._postingLists.get(term)!.set(doc.id, count);
                this._termTotalFreqs.set(term, (this._termTotalFreqs.get(term) || 0) + count);
            }
        }
        this._totalDocs = this._docLengths.size;
        if (this._totalDocs === 0) return;
        this._avgDocLength = totalLength / this._totalDocs;
        for (const [term, posting] of this._postingLists) {
            const df = posting.size;
            this._idfCache.set(term, Math.log((this._totalDocs - df + 0.5) / (df + 0.5) + 1));
        }
        for (const [term, posting] of this._postingLists) {
            const totalTf = this._termTotalFreqs.get(term)!;
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

    search(query: string, topK = 200) {
        if (this._totalDocs === 0 || !query) return [];
        const queryTokens = BM25Index.tokenize(query);
        if (queryTokens.length === 0) return [];
        const qtfMap = new Map<string, number>();
        for (const t of queryTokens) qtfMap.set(t, (qtfMap.get(t) || 0) + 1);
        const termWeights = new Map<string, number>();
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
        const { k1, b, _avgDocLength: avgdl } = this;
        const scores = new Map<string, number>();
        for (const [term, qtf] of qtfMap) {
            const weight = termWeights.get(term);
            if (weight === undefined) continue;
            const w = weight * qtf;
            const posting = this._postingLists.get(term)!;
            for (const [docId, tf] of posting) {
                const dl = this._docLengths.get(docId)!;
                const K = k1 * (1 - b + b * (dl / avgdl));
                const tfComponent = 1 / (1 + Math.exp(-k1 * (tf - K / 2) / K));
                scores.set(docId, (scores.get(docId) || 0) + w * tfComponent);
            }
        }
        if (scores.size === 0) return [];
        const invMax = 1 / maxPossible;
        const sorted = [...scores.entries()]
            .map(([id, s]) => ({ id, score: s * invMax }))
            .sort((a, b) => b.score - a.score);
        return sorted.slice(0, topK);
    }
}

export function bm25RankResults(lines: string[], query: string, charBudget = CHAR_BUDGET) {
    const index = new BM25Index();
    const docs = lines.map((line, i) => ({ id: String(i), text: line }));
    index.build(docs);
    const ranked = index.search(query, lines.length);
    const result: string[] = [];
    let charCount = 0;
    for (const { id } of ranked) {
        const line = lines[Number(id)];
        if (line === undefined) continue;
        if (charCount + line.length + 1 > charBudget) break;
        result.push(line);
        charCount += line.length + 1;
    }
    return { ranked: result, totalCount: lines.length };
}

export async function bm25PreFilterFiles(rootPath: string, query: string, topK = 50, excludePatterns: string[] = []) {
    const docs: Array<{ id: string; text: string }> = [];
    const MAX_FILE_SIZE = 512 * 1024;
    const MAX_FILES = 5000;
    const defaultExcludeGlobs = DEFAULT_EXCLUDES.map(p => `**/${p}/**`);
    const allExcludes = [...excludePatterns, ...defaultExcludeGlobs];
    const textExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.vue', '.svelte', '.html', '.css', '.scss', '.less', '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.sql', '.graphql', '.proto', '.tf', '.hcl', '.lua', '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.r', '.dockerfile', '.makefile', '.cmake', '.gradle', '.sbt', '.env.example', '.gitignore', '.editorconfig']);
    const hasRg = await ripgrepAvailable();
    let filePaths: string[] = [];
    if (hasRg) {
        const rgFiles = await ripgrepFindFiles(rootPath, { maxResults: MAX_FILES, excludePatterns: allExcludes });
        if (Array.isArray(rgFiles) && rgFiles.length > 0) filePaths = rgFiles;
    }
    if (filePaths.length === 0) {
        async function walk(dir: string) {
            if (filePaths.length >= MAX_FILES) return;
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (filePaths.length >= MAX_FILES) return;
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(rootPath, fullPath);
                if (DEFAULT_EXCLUDES.some(p => entry.name === p)) continue;
                const excluded = allExcludes.some(pat => minimatch(rel, pat, { dot: true }) || minimatch(rel, pat.replace(/^\*\*\//, ''), { dot: true }));
                if (excluded) continue;
                if (isSensitive(fullPath)) continue;
                if (entry.isDirectory()) await walk(fullPath);
                else if (entry.isFile()) filePaths.push(fullPath);
            }
        }
        await walk(rootPath);
    }
    for (const fullPath of filePaths) {
        if (docs.length >= MAX_FILES) break;
        const ext = path.extname(fullPath).toLowerCase();
        const nameLC = path.basename(fullPath).toLowerCase();
        const isText = textExts.has(ext) || nameLC === 'dockerfile' || nameLC === 'makefile' || nameLC === 'cmakelists.txt' || nameLC === 'gemfile' || nameLC === 'rakefile' || nameLC === 'justfile' || nameLC.startsWith('.') && !nameLC.includes('.');
        if (!isText) continue;
        try {
            const stat = await fs.stat(fullPath);
            if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
            const content = await fs.readFile(fullPath, 'utf-8');
            const rel = path.relative(rootPath, fullPath);
            const pathTokens = rel.replace(/[/\\]/g, ' ').replace(/\./g, ' ');
            const boostedText = `${pathTokens} ${pathTokens} ${pathTokens} ${content.slice(0, 8192)}`;
            docs.push({ id: fullPath, text: boostedText });
        } catch { }
    }
    if (docs.length === 0) return [];
    const index = new BM25Index();
    index.build(docs);
    const results = index.search(query, topK);
    return results.map(r => r.id);
}

export const RG_PATH = '/usr/bin/rg';

export async function ripgrepAvailable() {
    try {
        await fs.access(RG_PATH, fsConstants.X_OK);
        return true;
    } catch { return false; }
}

export interface RipgrepResult {
    file: string;
    line: number;
    content: string;
}

export async function ripgrepSearch(rootPath: string, options: {
    contentQuery?: string;
    filePattern?: string | null;
    ignoreCase?: boolean;
    maxResults?: number;
    excludePatterns?: string[];
    contextLines?: number;
    literalSearch?: boolean;
    includeHidden?: boolean;
    fileList?: string[] | null;
} = {}): Promise<RipgrepResult[] | null> {
    const { contentQuery, filePattern = null, ignoreCase = true, maxResults = 50, excludePatterns = [], contextLines = 0, literalSearch = false, includeHidden = false, fileList = null } = options;
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
    rgArgs.push('--', contentQuery ?? '');
    if (fileList && fileList.length > 0) for (const f of fileList) rgArgs.push(f); else rgArgs.push(rootPath);
    return new Promise<RipgrepResult[] | null>((resolveP) => {
        const results: RipgrepResult[] = [];
        let stderr = '';
        const proc = spawn(RG_PATH, rgArgs, { timeout: 30000 });
        let buffer = '';
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === 'match' && results.length < maxResults) {
                        const d = msg.data;
                        const filePath = d.path?.text;
                        if (filePath && !isSensitive(filePath)) {
                            results.push({ file: filePath, line: d.line_number, content: d.lines?.text?.replace(/\n$/, '') || '' });
                        }
                    }
                } catch { }
            }
        });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('close', (code) => {
            if ((code ?? 0) > 1) {
                console.error('ripgrep exited with code ' + code, stderr.slice(0, 200));
                resolveP(null);
                return;
            }
            resolveP(results);
        });
        proc.on('error', () => resolveP(null));
    });
}

export async function ripgrepFindFiles(rootPath: string, options: {
    namePattern?: string | null;
    pathContains?: string | null;
    maxResults?: number;
    excludePatterns?: string[];
} = {}): Promise<string[] | null> {
    const { namePattern = null, pathContains = null, maxResults = 100, excludePatterns = [] } = options;
    const rgArgs = ['--files'];
    for (const p of DEFAULT_EXCLUDES) {
        rgArgs.push('--glob', `!**/${p}`);
        rgArgs.push('--glob', `!**/${p}/**`);
    }
    for (const pat of excludePatterns) rgArgs.push('--glob', `!${pat}`);
    if (namePattern) rgArgs.push('--glob', namePattern);
    rgArgs.push(rootPath);
    return new Promise<string[] | null>((resolveP) => {
        const results: string[] = [];
        let buffer = '';
        const proc = spawn(RG_PATH, rgArgs, { timeout: 30000 });
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
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

export async function readFileAsBase64Stream(filePath: string) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: string | Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        stream.on('error', reject);
    });
}
