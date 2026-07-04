import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';

import {
    getCharBudget,
    RANK_THRESHOLD,
    getDefaultExcludes,
    getSensitivePatterns,
    isSensitive,
    BM25Index,
    ripgrepAvailable,
} from '../dist/core/shared.js';
import { loadConfig } from '../dist/config/index.js';

describe('getCharBudget', () => {
    it('returns the char_budget from the MCP config', () => {
        const config = loadConfig();
        expect(getCharBudget()).toBe(config.advanced.char_budget);
    });
});

describe('shared constants', () => {
    it('RANK_THRESHOLD is 50', () => {
        expect(RANK_THRESHOLD).toBe(50);
    });

    it('getDefaultExcludes contains common directories', () => {
        expect(getDefaultExcludes()).toContain('node_modules');
        expect(getDefaultExcludes()).toContain('.git');
    });

    it('sensitive patterns cover .env and pem files', () => {
        expect(isSensitive('.env')).toBe(true);
        expect(isSensitive('server.pem')).toBe(true);
    });

    it('getSensitivePatterns returns patterns covering .env and .pem', () => {
        const patterns = getSensitivePatterns();
        expect(Array.isArray(patterns)).toBe(true);
        expect(patterns.some(p => p.includes('.env'))).toBe(true);
        expect(patterns.some(p => p.includes('.pem'))).toBe(true);
    });
});

describe('shared isSensitive', () => {
    const homeDir = os.homedir();

    it('detects .env files as sensitive', () => {
        expect(isSensitive('.env')).toBe(true);
        expect(isSensitive(path.join(homeDir, '.env'))).toBe(true);
    });

    it('detects pem and key files as sensitive', () => {
        expect(isSensitive('key.pem')).toBe(true);
        expect(isSensitive('credentials.key')).toBe(true);
        expect(isSensitive('-cert.crt')).toBe(true);
    });

    it('detects credential-containing filenames as sensitive', () => {
        expect(isSensitive('credentials.json')).toBe(true);
        expect(isSensitive('secrets.yaml')).toBe(true);
        expect(isSensitive('my_secret.txt')).toBe(true);
    });

    it('allows normal source files', () => {
        expect(isSensitive('main.js')).toBe(false);
        expect(isSensitive('/project/src/index.ts')).toBe(false);
        expect(isSensitive('package.json')).toBe(false);
    });

    it('handles paths relative to home', () => {
        const relPath = path.relative(homeDir, path.join(homeDir, 'Documents', 'notes.txt'));
        expect(isSensitive(relPath)).toBe(false);
    });
});

describe('shared BM25Index', () => {
    it('tokenizes text correctly', () => {
        const tokens = BM25Index.tokenize('Hello World foo_bar');
        expect(tokens).toEqual(['hello', 'world', 'foo_bar']);
    });

    it('filters single characters except a and i', () => {
        expect(BM25Index.tokenize('a i x y z')).toEqual(['a', 'i']);
    });

    it('handles empty or null input', () => {
        expect(BM25Index.tokenize('')).toEqual([]);
        expect(BM25Index.tokenize(null)).toEqual([]);
    });

    it('builds index from documents', () => {
        const index = new BM25Index();
        index.build([
            { id: 'doc1', text: 'hello world' },
            { id: 'doc2', text: 'hello foo' },
            { id: 'doc3', text: 'bar world' },
        ]);
        const docs = index.search('hello', 10);
        expect(docs.length).toBeGreaterThan(0);
    });

    it('ranks documents by relevance', () => {
        const index = new BM25Index();
        index.build([
            { id: 'a', text: 'foo bar baz' },
            { id: 'b', text: 'foo foo foo' },
            { id: 'c', text: 'bar baz qux' },
        ]);
        const results = index.search('foo', 3);
        expect(results[0].id).toBe('b');
    });

    it('returns empty array for empty corpus', () => {
        const index = new BM25Index();
        expect(index.search('anything', 10)).toEqual([]);
    });

    it('returns empty array for empty corpus after build([])', () => {
        const index = new BM25Index();
        index.build([]);
        const results = index.search('test', 10);
        expect(results).toEqual([]);
    });

    it('handles single document corpus', () => {
        const index = new BM25Index();
        index.build([{ id: 'only', text: 'hello world' }]);
        const results = index.search('world', 10);
        expect(results[0].id).toBe('only');
    });

    it('respects topK parameter', () => {
        const index = new BM25Index();
        index.build([
            { id: 'doc1', text: 'test test test test' },
            { id: 'doc2', text: 'test test' },
            { id: 'doc3', text: 'test' },
            { id: 'doc4', text: 'test' },
        ]);
        const results = index.search('test', 2);
        expect(results.length).toBe(2);
    });
});

describe('shared ripgrepAvailable', () => {
    it('ripgrepAvailable returns a boolean', async () => {
        const result = await ripgrepAvailable();
        expect(typeof result).toBe('boolean');
    });
});
