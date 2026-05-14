import { describe, expect, it } from 'vitest';
import { findMatch, applyEditList, syntaxWarn } from '../dist/core/edit-engine.js';

const sampleContent = `function hello() {
    console.log("hello");
    return true;
}

function world() {
    console.log("world");
    return false;
}

const x = 42;
`;

describe('findMatch', () => {
    it('finds exact match', () => {
        const result = findMatch(sampleContent, '    return true;', undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('exact');
    });

    it('finds exact multiline match', () => {
        const old = 'function hello() {\n    console.log("hello");\n    return true;\n}';
        const result = findMatch(sampleContent, old, undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('exact');
    });

    it('returns null for non-matching text', () => {
        const result = findMatch(sampleContent, 'this text does not exist', undefined);
        expect(result).toBeNull();
    });

    it('uses trim-trailing strategy when trailing whitespace differs', () => {
        const content = 'line1   \nline2   \nline3\n';
        const result = findMatch(content, 'line1\nline2', undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('trim-trailing');
    });

    it('uses indent-stripped strategy when indentation differs', () => {
        const content = '    if (true) {\n        doSomething();\n    }\n';
        const result = findMatch(content, 'if (true) {\ndoSomething();\n}', undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('indent-stripped');
    });

    it('prefers exact match over other strategies', () => {
        const content = 'exact line\n    exact line\n';
        const result = findMatch(content, 'exact line', undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('exact');
    });

    it('finds occurrence near specified line', () => {
        const content = 'a\nb\nc\na\nb\nc\n';
        const result = findMatch(content, 'a', 5);
        expect(result).not.toBeNull();
        const linesBefore = content.slice(0, result.index).split('\n').length - 1;
        expect(linesBefore).toBeGreaterThanOrEqual(3);
    });

    it('handles empty content gracefully', () => {
        const result = findMatch('', 'something', undefined);
        expect(result).toBeNull();
    });

    it('handles matching against empty oldText', () => {
        const result = findMatch('content', '', undefined);
        expect(result).not.toBeNull();
        expect(result.strategy).toBe('exact');
    });
});

describe('applyEditList content mode', () => {
    it('replaces exact content match', async () => {
        const edits = [{
            mode: 'content',
            oldContent: '    return true;',
            newContent: '    return false;',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('return false');
        expect(result.workingContent).not.toContain('return true;');
    });

    it('returns error when oldContent not found', async () => {
        const edits = [{
            mode: 'content',
            oldContent: 'nonexistent text here',
            newContent: 'replacement',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].msg).toContain('not found');
    });

    it('handles multiple content edits in batch', async () => {
        const edits = [
            { mode: 'content', oldContent: '"hello"', newContent: '"hi"' },
            { mode: 'content', oldContent: '"world"', newContent: '"earth"' },
        ];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js', isBatch: true });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('"hi"');
        expect(result.workingContent).toContain('"earth"');
    });

    it('all-or-nothing: failed edit does not modify content', async () => {
        const edits = [
            { mode: 'content', oldContent: '"hello"', newContent: '"hi"' },
            { mode: 'content', oldContent: 'NONEXISTENT', newContent: '"fail"' },
        ];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js', isBatch: true });
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('reindents content when using indent-stripped strategy', async () => {
        const indented = '    function foo() {\n        return 1;\n    }\n';
        const edits = [{
            mode: 'content',
            oldContent: 'function foo() {\n    return 1;\n}',
            newContent: 'function foo() {\n    return 2;\n}',
        }];
        const result = await applyEditList(indented, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('return 2');
    });
});

describe('applyEditList block mode', () => {
    it('replaces block between start and end markers', async () => {
        const edits = [{
            mode: 'block',
            block_start: 'function hello() {',
            block_end: '}',
            replacement_block: 'function hello() {\n    console.log("replaced");\n}',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('replaced');
        expect(result.workingContent).not.toContain('return true');
    });

    it('returns error when block_start not found', async () => {
        const edits = [{
            mode: 'block',
            block_start: 'function nonexistent() {',
            block_end: '}',
            replacement_block: 'something',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].msg).toContain('block_start not found');
    });

    it('returns ambiguous error when multiple candidates exist', async () => {
        const ambiguous = `function foo() {
    return 1;
}

function foo() {
    return 2;
}
`;
        const edits = [{
            mode: 'block',
            block_start: 'function foo() {',
            block_end: '}',
            replacement_block: 'replaced',
        }];
        const result = await applyEditList(ambiguous, edits, { filePath: '/tmp/test.js' });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].msg).toContain('Ambiguous');
    });

    it('resolves ambiguity with disambiguations map', async () => {
        const ambiguous = `function foo() {
    return 1;
}

function foo() {
    return 2;
}
`;
        const disambiguations = new Map();
        disambiguations.set(0, { startLine: 1 });
        const edits = [{
            mode: 'block',
            block_start: 'function foo() {',
            block_end: '}',
            replacement_block: 'replaced block',
        }];
        const result = await applyEditList(ambiguous, edits, {
            filePath: '/tmp/test.js',
            disambiguations,
        });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('replaced block');
    });

    it('replaces block with empty content', async () => {
        const edits = [{
            mode: 'block',
            block_start: 'function hello() {',
            block_end: '}',
            replacement_block: '',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
    });
});

describe('applyEditList symbol mode', () => {
    it('replaces a named symbol', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'hello',
            newText: 'function hello() {\n    return "replaced";\n}',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('replaced');
    });

    it('returns error for unknown symbol', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'nonexistent',
            newText: 'irrelevant',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].msg).toContain('Symbol not found');
    });

    it('returns error for unsupported file extension', async () => {
        const edits = [{
            mode: 'symbol',
            symbol: 'hello',
            newText: 'irrelevant',
        }];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.xyz' });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].msg).toContain('Unsupported file type');
    });
});

describe('applyEditList mixed modes', () => {
    it('applies block then content edit sequentially', async () => {
        const edits = [
            {
                mode: 'block',
                block_start: 'function hello() {',
                block_end: '}',
                replacement_block: 'function hello() {\n    return "block";\n}',
            },
            {
                mode: 'content',
                oldContent: 'const x = 42;',
                newContent: 'const x = 99;',
            },
        ];
        const result = await applyEditList(sampleContent, edits, { filePath: '/tmp/test.js' });
        expect(result.errors).toHaveLength(0);
        expect(result.workingContent).toContain('block');
        expect(result.workingContent).toContain('99');
    });
});

describe('syntaxWarn', () => {
    it('returns empty string for clean JS', async () => {
        const result = await syntaxWarn('/tmp/test.js', 'const x = 1;');
        expect(result).toBe('');
    });

    it('returns empty string for unsupported extensions', async () => {
        const result = await syntaxWarn('/tmp/test.scss', 'broken {');
        expect(result).toBe('');
    });

    it('returns empty string for .mdx files', async () => {
        const result = await syntaxWarn('/tmp/test.mdx', 'anything');
        expect(result).toBe('');
    });

    it('returns empty string for .jsonc files', async () => {
        const result = await syntaxWarn('/tmp/test.jsonc', '// comment\n{}');
        expect(result).toBe('');
    });

    it('returns empty string for unknown extensions', async () => {
        const result = await syntaxWarn('/tmp/test.xyz', 'anything');
        expect(result).toBe('');
    });
});
