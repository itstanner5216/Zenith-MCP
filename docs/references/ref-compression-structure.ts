// ---------------------------------------------------------------------------
// tree-sitter/compression-structure.ts — Block / anchor compression structure
//
// Contains:
//   - BlockEntry (exported interface)
//   - AnchorRule, AnchorRuleMap, AnchorEntry (private interfaces)
//   - COMPRESSION_ANCHOR_RULES constant
//   - maybeAddAnchor, assignAnchorToInnermostBlock, shouldCaptureAnchor helpers
//   - getCompressionStructure() (exported)
// ---------------------------------------------------------------------------

import { Parser, Node } from 'web-tree-sitter';
import { loadLanguage } from './runtime.js';
import { getDefinitions } from './symbols.js';
import type { SymbolInfo } from './symbols.js';

interface AnchorRule {
    kind: string;
    priority: number;
}

interface AnchorRuleMap {
    [nodeType: string]: AnchorRule;
}

interface AnchorEntry {
    startLine: number;
    endLine: number;
    kind: string;
    priority: number;
}

export interface BlockEntry {
    type: string;
    name: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    anchors: AnchorEntry[];
}

const COMPRESSION_ANCHOR_RULES: Record<string, AnchorRuleMap> = {
    javascript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    typescript: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    tsx: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        for_in_statement: { kind: 'loop', priority: 250 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
        call_expression: { kind: 'call', priority: 140 },
    },
    python: {
        return_statement: { kind: 'return', priority: 400 },
        raise_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        elif_clause: { kind: 'if', priority: 310 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        try_statement: { kind: 'try', priority: 280 },
        except_clause: { kind: 'catch', priority: 270 },
        with_statement: { kind: 'with', priority: 220 },
        await: { kind: 'await', priority: 180 },
        call: { kind: 'call', priority: 140 },
    },

    go: {
        return_statement:   { kind: 'return', priority: 400 },
        if_statement:       { kind: 'if',     priority: 320 },
        for_statement:      { kind: 'loop',   priority: 260 },
        select_statement:   { kind: 'switch', priority: 300 },
        go_statement:       { kind: 'call',   priority: 200 },
        defer_statement:    { kind: 'defer',  priority: 220 },
    },

    rust: {
        return_expression:  { kind: 'return', priority: 400 },
        if_expression:      { kind: 'if',     priority: 320 },
        match_expression:   { kind: 'switch', priority: 300 },
        loop_expression:    { kind: 'loop',   priority: 260 },
        for_expression:     { kind: 'loop',   priority: 260 },
        while_expression:   { kind: 'loop',   priority: 250 },
        try_expression:     { kind: 'try',    priority: 280 },
        macro_invocation:   { kind: 'call',   priority: 140 },
    },

    java: {
        return_statement:        { kind: 'return', priority: 400 },
        throw_statement:         { kind: 'throw',  priority: 380 },
        if_statement:            { kind: 'if',     priority: 320 },
        switch_expression:       { kind: 'switch', priority: 300 },
        for_statement:           { kind: 'loop',   priority: 260 },
        enhanced_for_statement:  { kind: 'loop',   priority: 255 },
        while_statement:         { kind: 'loop',   priority: 250 },
        do_statement:            { kind: 'loop',   priority: 240 },
        try_statement:           { kind: 'try',    priority: 280 },
        catch_clause:            { kind: 'catch',  priority: 270 },
        method_invocation:       { kind: 'call',   priority: 140 },
    },

    c: {
        return_statement:   { kind: 'return', priority: 400 },
        if_statement:       { kind: 'if',     priority: 320 },
        switch_statement:   { kind: 'switch', priority: 300 },
        for_statement:      { kind: 'loop',   priority: 260 },
        while_statement:    { kind: 'loop',   priority: 250 },
        do_statement:       { kind: 'loop',   priority: 240 },
    },

    cpp: {
        return_statement:   { kind: 'return', priority: 400 },
        throw_statement:    { kind: 'throw',  priority: 380 },
        if_statement:       { kind: 'if',     priority: 320 },
        switch_statement:   { kind: 'switch', priority: 300 },
        for_statement:      { kind: 'loop',   priority: 260 },
        while_statement:    { kind: 'loop',   priority: 250 },
        do_statement:       { kind: 'loop',   priority: 240 },
        try_statement:      { kind: 'try',    priority: 280 },
        catch_clause:       { kind: 'catch',  priority: 270 },
    },

    csharp: {
        return_statement:   { kind: 'return', priority: 400 },
        throw_statement:    { kind: 'throw',  priority: 380 },
        if_statement:       { kind: 'if',     priority: 320 },
        switch_statement:   { kind: 'switch', priority: 300 },
        for_statement:      { kind: 'loop',   priority: 260 },
        foreach_statement:  { kind: 'loop',   priority: 255 },
        while_statement:    { kind: 'loop',   priority: 250 },
        do_statement:       { kind: 'loop',   priority: 240 },
        try_statement:      { kind: 'try',    priority: 280 },
        catch_clause:       { kind: 'catch',  priority: 270 },
        await_expression:   { kind: 'await',  priority: 180 },
    },

    kotlin: {
        return_expression:    { kind: 'return', priority: 400 },
        throw_expression:     { kind: 'throw',  priority: 380 },
        if_expression:        { kind: 'if',     priority: 320 },
        when_expression:      { kind: 'switch', priority: 300 },
        for_statement:        { kind: 'loop',   priority: 260 },
        while_statement:      { kind: 'loop',   priority: 250 },
        do_while_statement:   { kind: 'loop',   priority: 240 },
        try_expression:       { kind: 'try',    priority: 280 },
    },

    php: {
        return_statement:   { kind: 'return', priority: 400 },
        throw_expression:   { kind: 'throw',  priority: 380 },
        if_statement:       { kind: 'if',     priority: 320 },
        switch_statement:   { kind: 'switch', priority: 300 },
        for_statement:      { kind: 'loop',   priority: 260 },
        foreach_statement:  { kind: 'loop',   priority: 255 },
        while_statement:    { kind: 'loop',   priority: 250 },
        do_statement:       { kind: 'loop',   priority: 240 },
        try_statement:      { kind: 'try',    priority: 280 },
        catch_clause:       { kind: 'catch',  priority: 270 },
    },

    ruby: {
        return:             { kind: 'return', priority: 400 },
        raise:              { kind: 'throw',  priority: 380 },
        if:                 { kind: 'if',     priority: 320 },
        unless:             { kind: 'if',     priority: 310 },
        for:                { kind: 'loop',   priority: 260 },
        while:              { kind: 'loop',   priority: 250 },
        until:              { kind: 'loop',   priority: 240 },
        begin:              { kind: 'try',    priority: 280 },
        rescue:             { kind: 'catch',  priority: 270 },
    },

    swift: {
        return_statement:           { kind: 'return', priority: 400 },
        throw_statement:            { kind: 'throw',  priority: 380 },
        if_statement:               { kind: 'if',     priority: 320 },
        guard_statement:            { kind: 'if',     priority: 315 },
        switch_statement:           { kind: 'switch', priority: 300 },
        for_in_statement:           { kind: 'loop',   priority: 260 },
        while_statement:            { kind: 'loop',   priority: 250 },
        repeat_while_statement:     { kind: 'loop',   priority: 240 },
        do_statement:               { kind: 'try',    priority: 280 },
    },

    bash: {
        if_statement:       { kind: 'if',     priority: 320 },
        case_statement:     { kind: 'switch', priority: 300 },
        for_statement:      { kind: 'loop',   priority: 260 },
        while_statement:    { kind: 'loop',   priority: 250 },
        pipeline:           { kind: 'call',   priority: 140 },
    },

    lua: {
        return_statement:   { kind: 'return', priority: 400 },
        if_statement:       { kind: 'if',     priority: 320 },
        for_statement:      { kind: 'loop',   priority: 260 },
        while_statement:    { kind: 'loop',   priority: 250 },
        repeat_statement:   { kind: 'loop',   priority: 240 },
        function_call:      { kind: 'call',   priority: 140 },
    },

    nix: {
        if_expression:      { kind: 'if',   priority: 320 },
        assert_expression:  { kind: 'if',   priority: 315 },
        with_expression:    { kind: 'with', priority: 220 },
        let_expression:     { kind: 'call', priority: 160 },
    },
};

function maybeAddAnchor(block: BlockEntry, anchor: AnchorEntry): void {
    if (!block.anchors) block.anchors = [];

    const existing = block.anchors.find(
        (item: AnchorEntry) => item.startLine === anchor.startLine && item.endLine === anchor.endLine
    );

    if (existing) {
        if (anchor.priority > existing.priority) {
            existing.priority = anchor.priority;
            existing.kind = anchor.kind;
        }
        return;
    }

    block.anchors.push(anchor);
}

function assignAnchorToInnermostBlock(blocks: BlockEntry[], startLine: number, endLine: number, kind: string, priority: number): void {
    let target: BlockEntry | null = null;

    for (const block of blocks) {
        if (block.startLine > startLine || block.endLine < endLine) continue;
        if (!target || (block.endLine - block.startLine) < (target.endLine - target.startLine)) {
            target = block;
        }
    }

    if (!target || startLine <= target.startLine) return;

    maybeAddAnchor(target, { startLine, endLine, kind, priority });
}

function shouldCaptureAnchor(node: Node, parent: Node | null, rule: AnchorRule | undefined): boolean {
    if (node.type === 'call_expression' && parent && (
        parent.type === 'call_expression' ||
        parent.type === 'await_expression' ||
        parent.type === 'expression_statement'
    )) {
        return false;
    }

    if (node.type === 'call' && parent && parent.type === 'await') {
        return false;
    }

    return !!rule;
}

export async function getCompressionStructure(source?: string, langName?: string): Promise<BlockEntry[] | null> {
    const defs = await getDefinitions(source ?? '', langName ?? '');
    if (!defs) return null;
    if (defs.length === 0) return [];

    let blocks: BlockEntry[] = defs.map((d: SymbolInfo) => ({
        type: d.type,
        name: d.name,
        startLine: d.line - 1,
        endLine: d.endLine - 1,
        exported: false,
        anchors: [],
    }));

    // Filter out nested blocks (e.g. local variables inside functions)
    // A block is nested if there exists another block that strictly contains it,
    // or if they have the exact same bounds, we keep the one that appears first (usually the parent declaration).
    blocks = blocks.filter((b, i) => {
        return !blocks.some((other, j) => {
            if (i === j) return false;
            const strictlyContains = other.startLine <= b.startLine && other.endLine >= b.endLine &&
                                     (other.startLine < b.startLine || other.endLine > b.endLine);
            const identicalBounds = other.startLine === b.startLine && other.endLine === b.endLine && j < i;
            return strictlyContains || identicalBounds;
        });
    });

    const rulesOrUndef = langName !== undefined ? COMPRESSION_ANCHOR_RULES[langName] : undefined;
    if (!rulesOrUndef) return blocks;
    const rules: AnchorRuleMap = rulesOrUndef;

    const language = await loadLanguage(langName ?? '');
    if (!language) return blocks;

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source ?? '');

    if (!tree) return blocks;

    try {
        function walk(node: Node, parent: Node | null = null): void {
            const rule = rules[node.type];
            if (rule !== undefined && shouldCaptureAnchor(node, parent, rule)) {
                const startLine = node.startPosition.row;
                const rawEndLine = node.endPosition.row;
                const endLine = rawEndLine <= startLine + 1 ? rawEndLine : startLine;
                assignAnchorToInnermostBlock(blocks, startLine, endLine, rule.kind, rule.priority);
            }

            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) walk(child, node);
            }
        }

        walk(tree.rootNode, null);
    } finally {
        tree.delete();
        parser.delete();
    }

    for (const block of blocks) {
        if (block.anchors.length > 0) {
            block.anchors.sort((a: AnchorEntry, b: AnchorEntry) => b.priority - a.priority || a.startLine - b.startLine);
            block.anchors = block.anchors.slice(0, 16);
        }
    }

    return blocks;
}
