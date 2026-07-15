// polaris-contracts.test.js — POLARIS Task 2.1 contract freeze
//
// Ten isolated in-memory TypeScript programs prove the positive and negative
// public type contracts under the package's strict compiler flags. A source
// scan also guards NodeNext relative module specifiers for later Wave 2 files.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(TESTS_DIR, '..');
const INTELLIGENCE_DIR = path.join(PACKAGE_DIR, 'src', 'core', 'intelligence');
const FIXTURE_PATH = path.join(INTELLIGENCE_DIR, '__polaris_contract_fixture__.ts');

const COMPILER_OPTIONS = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
};

const FACT_LOCATED_SYMBOL_SOURCE = [
    "const factLocatedSymbol = {",
    "    handle: {",
    "        kind: 'fact',",
    "        stableKey: 'fact:one',",
    "        factKey: 'fact:one',",
    "        snapshot: null,",
    "        profile: null,",
    "    },",
    "    path: 'src/value.ts',",
    "    name: 'value',",
    "    qualifiedName: 'value',",
    "    kind: 'function',",
    "    range: {",
    "        precision: 'byte',",
    "        startByte: 0,",
    "        endByte: 5,",
    "        startLine: 1,",
    "        startColumn: 0,",
    "        endLine: 1,",
    "        endColumn: 5,",
    "    },",
    "    candidateBasis: 'exact_declaration',",
    "    parentChain: [],",
    "    parentChainSource: 'none',",
    "} satisfies LocatedSymbol;",
];

const RESOLVED_LOCATED_SYMBOL_SOURCE = [
    ...FACT_LOCATED_SYMBOL_SOURCE,
    'const resolvedLocatedSymbol: ResolvedLocatedSymbol = factLocatedSymbol;',
];

function compileFixture(source) {
    const baseHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const normalizedFixturePath = path.resolve(FIXTURE_PATH);
    const host = {
        ...baseHost,
        fileExists(fileName) {
            return path.resolve(fileName) === normalizedFixturePath || baseHost.fileExists(fileName);
        },
        readFile(fileName) {
            if (path.resolve(fileName) === normalizedFixturePath) return source;
            return baseHost.readFile(fileName);
        },
        getSourceFile(fileName, languageVersion) {
            const text = host.readFile(fileName);
            if (text === undefined) return undefined;
            return ts.createSourceFile(
                fileName,
                text,
                languageVersion,
                true,
                ts.getScriptKindFromFileName(fileName)
            );
        },
    };
    const program = ts.createProgram({
        rootNames: [FIXTURE_PATH],
        options: COMPILER_OPTIONS,
        host,
    });
    return ts.getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function formatDiagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        if (diagnostic.file === undefined || diagnostic.start === undefined) {
            return 'TS' + diagnostic.code + ': ' + message;
        }
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return path.relative(PACKAGE_DIR, diagnostic.file.fileName)
            + ':' + (position.line + 1)
            + ':' + (position.character + 1)
            + ' TS' + diagnostic.code + ': ' + message;
    }).join('\n');
}

function expectClean(source) {
    const diagnostics = compileFixture(source);
    expect(diagnostics, formatDiagnostics(diagnostics)).toEqual([]);
}

function expectFixtureDiagnostic(source, expectedCode) {
    const diagnostics = compileFixture(source);
    const fixtureDiagnostics = diagnostics.filter((diagnostic) =>
        diagnostic.file !== undefined
        && path.resolve(diagnostic.file.fileName) === path.resolve(FIXTURE_PATH)
    );
    const detail = formatDiagnostics(diagnostics);
    expect(fixtureDiagnostics.length, detail).toBeGreaterThan(0);
    expect(
        fixtureDiagnostics.some((diagnostic) => diagnostic.code === expectedCode),
        detail
    ).toBe(true);
}

describe('positive public type contracts', () => {
    it('a. accepts an ambiguous ResolutionAnswer with two candidates and null target/basis', () => {
        expectClean([
            "import type { LocatedSymbol, ResolutionAnswer } from './types.js';",
            ...FACT_LOCATED_SYMBOL_SOURCE,
            'const secondLocatedSymbol = {',
            '    ...factLocatedSymbol,',
            "    handle: { kind: 'fact', stableKey: 'fact:two', factKey: 'fact:two', snapshot: null, profile: null },",
            "    name: 'other',",
            "    qualifiedName: 'other',",
            '} satisfies LocatedSymbol;',
            'const answer: ResolutionAnswer = {',
            "    status: 'ambiguous',",
            '    target: null,',
            '    basis: null,',
            '    proof: [],',
            '    candidates: [factLocatedSymbol, secondLocatedSymbol],',
            '    resolvedThrough: 0,',
            '    stoppedAt: null,',
            '};',
            'void answer;',
        ].join('\n'));
    });

    it('b. accepts an unresolved answer with module_not_found reason', () => {
        expectClean([
            "import type { ResolutionAnswer } from './types.js';",
            'const answer: ResolutionAnswer = {',
            "    status: 'unresolved',",
            '    target: null,',
            '    basis: null,',
            '    proof: [],',
            '    candidates: [],',
            "    reason: 'module_not_found',",
            '    resolvedThrough: 0,',
            '    stoppedAt: null,',
            '};',
            'void answer;',
        ].join('\n'));
    });

    it('c. accepts PageRequest values of {} and { limit: 5 }', () => {
        expectClean([
            "import type { PageRequest } from './types.js';",
            'const empty: PageRequest = {};',
            'const limited: PageRequest = { limit: 5 };',
            'void [empty, limited];',
        ].join('\n'));
    });

    it('d. builds NonEmpty<BindingProofStep> from a literal one-element tuple', () => {
        expectClean([
            "import type { BindingProofStep, NonEmpty } from './types.js';",
            'const proof: NonEmpty<BindingProofStep> = [{',
            "    kind: 'declaration',",
            "    from: 'fact:source',",
            "    to: 'fact:target',",
            "    factKey: 'fact:proof',",
            '}];',
            'void proof;',
        ].join('\n'));
    });
});

describe('negative public type contracts', () => {
    it('e. rejects a resolved answer with an empty proof', () => {
        expectFixtureDiagnostic([
            "import type { LocatedSymbol, ResolvedLocatedSymbol, ResolutionAnswer } from './types.js';",
            ...RESOLVED_LOCATED_SYMBOL_SOURCE,
            'const answer: ResolutionAnswer = {',
            "    status: 'resolved',",
            '    target: resolvedLocatedSymbol,',
            "    basis: 'declaration_self',",
            '    proof: [],',
            '    candidates: [],',
            '    resolvedThrough: 1,',
            '    stoppedAt: null,',
            '};',
            'void answer;',
        ].join('\n'), 2322);
    });

    it('f. rejects a resolved answer with null basis', () => {
        expectFixtureDiagnostic([
            "import type { LocatedSymbol, ResolvedLocatedSymbol, ResolutionAnswer } from './types.js';",
            ...RESOLVED_LOCATED_SYMBOL_SOURCE,
            'const answer: ResolutionAnswer = {',
            "    status: 'resolved',",
            '    target: resolvedLocatedSymbol,',
            '    basis: null,',
            "    proof: [{ kind: 'declaration', from: 'a', to: 'b', factKey: 'proof' }],",
            '    candidates: [],',
            '    resolvedThrough: 1,',
            '    stoppedAt: null,',
            '};',
            'void answer;',
        ].join('\n'), 2322);
    });

    it('g. rejects a resolved answer with a nonempty candidates tuple', () => {
        expectFixtureDiagnostic([
            "import type { LocatedSymbol, ResolvedLocatedSymbol, ResolutionAnswer } from './types.js';",
            ...RESOLVED_LOCATED_SYMBOL_SOURCE,
            'const answer: ResolutionAnswer = {',
            "    status: 'resolved',",
            '    target: resolvedLocatedSymbol,',
            "    basis: 'declaration_self',",
            "    proof: [{ kind: 'declaration', from: 'a', to: 'b', factKey: 'proof' }],",
            '    candidates: [factLocatedSymbol],',
            '    resolvedThrough: 1,',
            '    stoppedAt: null,',
            '};',
            'void answer;',
        ].join('\n'), 2322);
    });

    it('h. rejects a ResolvedLocatedSymbol whose handle is the text arm', () => {
        expectFixtureDiagnostic([
            "import type { LocatedSymbol, ResolvedLocatedSymbol } from './types.js';",
            'const textLocatedSymbol = {',
            "    handle: { kind: 'text', stableKey: 'text:one', textKey: 'text:one', snapshot: null, profile: null },",
            "    path: 'src/value.ts',",
            "    name: 'value',",
            "    qualifiedName: 'value',",
            "    kind: 'function',",
            "    range: { precision: 'line', startLine: 1, startColumn: 0, endLine: 1 },",
            "    candidateBasis: 'text_occurrence',",
            '    parentChain: [],',
            "    parentChainSource: 'none',",
            '} satisfies LocatedSymbol;',
            'const resolved: ResolvedLocatedSymbol = textLocatedSymbol;',
            'void resolved;',
        ].join('\n'), 2322);
    });

    it('i. rejects a plain string where ContinuationCursor is required', () => {
        expectFixtureDiagnostic([
            "import type { ContinuationCursor } from './types.js';",
            'declare function resume(after: ContinuationCursor): void;',
            "resume('forged-cursor');",
        ].join('\n'), 2345);
    });

    it('j. rejects PageRequest { limit: undefined } under exact optional types', () => {
        expectFixtureDiagnostic([
            "import type { PageRequest } from './types.js';",
            'const request: PageRequest = { limit: undefined };',
            'void request;',
        ].join('\n'), 2375);
    });
});

function walkTypeScriptFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) return walkTypeScriptFiles(absolute);
        return entry.isFile() && absolute.endsWith('.ts') ? [absolute] : [];
    });
}

function relativeModuleSpecifiers(fileName, sourceText) {
    const text = sourceText ?? fs.readFileSync(fileName, 'utf8');
    const sourceFile = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const specifiers = [];
    const record = (literal) => {
        if (!ts.isStringLiteralLike(literal)) return;
        if (!literal.text.startsWith('.')) return;
        const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
        specifiers.push({
            text: literal.text,
            line: position.line + 1,
        });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
            record(node.moduleSpecifier);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
            record(node.moduleSpecifier);
        } else if (
            ts.isImportEqualsDeclaration(node)
            && ts.isExternalModuleReference(node.moduleReference)
            && node.moduleReference.expression !== undefined
        ) {
            record(node.moduleReference.expression);
        } else if (
            ts.isImportTypeNode(node)
            && ts.isLiteralTypeNode(node.argument)
        ) {
            record(node.argument.literal);
        } else if (
            ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments.length === 1
        ) {
            const argument = node.arguments[0];
            if (argument !== undefined) record(argument);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
}

describe('NodeNext ESM source contract', () => {
    it('every relative module specifier under src/core/intelligence ends in .js', () => {
        const importTypeProbe = relativeModuleSpecifiers(
            path.join(INTELLIGENCE_DIR, '__import_type_probe__.ts'),
            "type Imported = import('./missing-extension').Thing;"
        );
        expect(importTypeProbe.map((specifier) => specifier.text))
            .toEqual(['./missing-extension']);

        const files = walkTypeScriptFiles(INTELLIGENCE_DIR).sort();
        expect(files.length).toBeGreaterThanOrEqual(2);
        const violations = files.flatMap((fileName) =>
            relativeModuleSpecifiers(fileName)
                .filter((specifier) => !specifier.text.endsWith('.js'))
                .map((specifier) =>
                    path.relative(PACKAGE_DIR, fileName)
                    + ':' + specifier.line
                    + ' imports ' + specifier.text
                )
        );
        expect(violations, violations.join('\n')).toEqual([]);
    });
});
