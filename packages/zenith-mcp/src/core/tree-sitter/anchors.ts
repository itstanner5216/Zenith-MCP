// ---------------------------------------------------------------------------
// tree-sitter/anchors.ts — In-body anchor extraction
//
// Invariant: Operates on a pre-parsed tree rootNode. Does NOT re-parse.
// The ANCHOR_RULES table covers 18 languages from the reference design.
// Unsupported languages return empty arrays (graceful no-op).
// ---------------------------------------------------------------------------

import type { Node } from 'web-tree-sitter';
// Node types that open a NESTED definition's OWN scope. The in-body anchor
// walk must not descend into these — their control-flow anchors belong to that
// inner symbol, not the enclosing one. This is deliberately NOT the canonical
// DEF_TYPES from symbols.ts: DEF_TYPES is the set of nodes that can HOST a
// definition *name* across grammars and includes body/structural nodes
// (block, statement_block, assignment, block_mapping_pair, …) that are part of
// a def's OWN body — pruning on those drops the def's own anchors (e.g. a
// function_declaration → block → if_statement would prune at `block`). This is
// the complete set of function/class/method/type *definition openers* across
// the supported grammars (a superset of the original 8, fixing the nested-def
// leak in review #40 without over-pruning bodies).
const DEF_SCOPE_NODE_TYPES: ReadonlySet<string> = new Set<string>([
    // functions / methods / closures
    'function_declaration', 'function_definition', 'function_item',
    'function_expression', 'arrow_function', 'method_definition',
    'method_declaration', 'constructor_declaration', 'func_literal',
    'generator_function', 'generator_function_declaration',
    // classes / structs / interfaces / enums / traits / modules with bodies
    'class_declaration', 'class_definition', 'class', 'abstract_class_declaration',
    'class_specifier', 'struct_specifier', 'struct_item', 'struct_declaration',
    'interface_declaration', 'enum_declaration', 'enum_item', 'trait_item',
    'impl_item', 'mod_item', 'module', 'namespace_definition',
    'namespace_declaration', 'record_declaration', 'object_declaration',
    'annotation_type_declaration', 'union_item', 'macro_definition',
]);

export interface AnchorEntry {
    line: number;         // 0-based line index
    endLine: number;      // 0-based
    kind: string;
    priority: number;
}

interface AnchorRule {
    kind: string;
    priority: number;
}

const ANCHOR_RULES: Readonly<Record<string, Record<string, AnchorRule>>> = {
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
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        for_statement: { kind: 'loop', priority: 260 },
        select_statement: { kind: 'switch', priority: 300 },
        go_statement: { kind: 'call', priority: 200 },
        defer_statement: { kind: 'defer', priority: 220 },
    },
    rust: {
        return_expression: { kind: 'return', priority: 400 },
        if_expression: { kind: 'if', priority: 320 },
        match_expression: { kind: 'switch', priority: 300 },
        loop_expression: { kind: 'loop', priority: 260 },
        for_expression: { kind: 'loop', priority: 260 },
        while_expression: { kind: 'loop', priority: 250 },
        macro_invocation: { kind: 'call', priority: 140 },
    },
    java: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_expression: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        enhanced_for_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        method_invocation: { kind: 'call', priority: 140 },
    },
    c: {
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
    },
    cpp: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
    },
    c_sharp: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        foreach_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
        await_expression: { kind: 'await', priority: 180 },
    },
    kotlin: {
        return_expression: { kind: 'return', priority: 400 },
        throw_expression: { kind: 'throw', priority: 380 },
        if_expression: { kind: 'if', priority: 320 },
        when_expression: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        do_while_statement: { kind: 'loop', priority: 240 },
        try_expression: { kind: 'try', priority: 280 },
    },
    php: {
        return_statement: { kind: 'return', priority: 400 },
        throw_expression: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        foreach_statement: { kind: 'loop', priority: 255 },
        while_statement: { kind: 'loop', priority: 250 },
        do_statement: { kind: 'loop', priority: 240 },
        try_statement: { kind: 'try', priority: 280 },
        catch_clause: { kind: 'catch', priority: 270 },
    },
    ruby: {
        return: { kind: 'return', priority: 400 },
        raise: { kind: 'throw', priority: 380 },
        if: { kind: 'if', priority: 320 },
        unless: { kind: 'if', priority: 310 },
        for: { kind: 'loop', priority: 260 },
        while: { kind: 'loop', priority: 250 },
        until: { kind: 'loop', priority: 240 },
        begin: { kind: 'try', priority: 280 },
        rescue: { kind: 'catch', priority: 270 },
    },
    swift: {
        return_statement: { kind: 'return', priority: 400 },
        throw_statement: { kind: 'throw', priority: 380 },
        if_statement: { kind: 'if', priority: 320 },
        guard_statement: { kind: 'if', priority: 315 },
        switch_statement: { kind: 'switch', priority: 300 },
        for_in_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        repeat_while_statement: { kind: 'loop', priority: 240 },
        do_statement: { kind: 'try', priority: 280 },
    },
    bash: {
        if_statement: { kind: 'if', priority: 320 },
        case_statement: { kind: 'switch', priority: 300 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        pipeline: { kind: 'call', priority: 140 },
    },
    lua: {
        return_statement: { kind: 'return', priority: 400 },
        if_statement: { kind: 'if', priority: 320 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
        repeat_statement: { kind: 'loop', priority: 240 },
        function_call: { kind: 'call', priority: 140 },
    },
    nix: {
        if_expression: { kind: 'if', priority: 320 },
        assert_expression: { kind: 'if', priority: 315 },
        with_expression: { kind: 'with', priority: 220 },
        let_expression: { kind: 'call', priority: 160 },
    },
    scss: {
        if_statement: { kind: 'if', priority: 320 },
        each_statement: { kind: 'loop', priority: 260 },
        for_statement: { kind: 'loop', priority: 260 },
        while_statement: { kind: 'loop', priority: 250 },
    },
};

/**
 * Extract anchors for a single definition body.
 * Walk the node subtree; for each child whose type matches an ANCHOR_RULES entry,
 * emit an AnchorEntry. Skip nested defs (don't report anchors inside inner functions).
 *
 * @param defNode   The AST node spanning the definition
 * @param langName  Language name for rule lookup
 * @param defStartRow 0-based start row of the def (used to skip the def signature line itself)
 */
export function extractAnchorsForDef(defNode: Node, langName: string, defStartRow: number): AnchorEntry[] {
    const rules = ANCHOR_RULES[langName];
    if (!rules) return [];
    // `rules` is provably non-null past the guard above; bind it to a local so
    // the walk closure references it without a `!` non-null assertion (Rule 6).
    const ruleTable = rules;

    const anchors: AnchorEntry[] = [];

    function walk(node: Node, depth: number): void {
        // Don't descend into nested definitions — their anchors belong to that
        // inner symbol, not this one. Prune only on genuine scope-opening def
        // nodes (see DEF_SCOPE_NODE_TYPES), NOT canonical DEF_TYPES, which would
        // also prune the def's own body (block/statement_block/etc.).
        if (depth > 0 && DEF_SCOPE_NODE_TYPES.has(node.type)) return;

        const rule = ruleTable[node.type];
        if (rule && node.startPosition.row > defStartRow) {
            anchors.push({
                line: node.startPosition.row,
                endLine: node.endPosition.row,
                kind: rule.kind,
                priority: rule.priority,
            });
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) walk(child, depth + 1);
        }
    }

    walk(defNode, 0);
    return anchors;
}
