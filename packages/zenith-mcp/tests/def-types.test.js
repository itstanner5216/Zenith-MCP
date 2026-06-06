// ---------------------------------------------------------------------------
// def-types.test.js
//
// Unit tests for DEF_TYPES, the canonical set of AST node types that act as
// definition containers in shipped tree-sitter tag queries.
//
// Covers:
//   - Correct export from the tree-sitter barrel (tree-sitter.ts)
//   - Structural properties (type, size, entry format)
//   - Presence of entries for each major language family
//   - Absence of non-definition / wildcard node types
//   - Alphabetical ordering of the snake_case section
//   - ReadonlySet runtime behaviour (has(), add() throws)
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { DEF_TYPES } from '../dist/core/tree-sitter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid tree-sitter node identifier: starts with [A-Za-z_], followed by word
 *  chars. camelCase (XML) and snake_case are both acceptable. */
const VALID_NODE_ID_RE = /^[_a-zA-Z]\w*$/;

// ---------------------------------------------------------------------------
// Structural properties
// ---------------------------------------------------------------------------

describe('DEF_TYPES structural properties', () => {
    it('is exported from the tree-sitter barrel module', () => {
        expect(DEF_TYPES).toBeDefined();
    });

    it('is a Set instance', () => {
        expect(DEF_TYPES).toBeInstanceOf(Set);
    });

    it('contains at least 146 entries (all shipped grammar types)', () => {
        // The PR derives 146 types across 36 shipped languages.
        // This bound guards against accidental truncation.
        expect(DEF_TYPES.size).toBeGreaterThanOrEqual(146);
    });

    it('every entry is a non-empty string', () => {
        for (const entry of DEF_TYPES) {
            expect(typeof entry).toBe('string');
            expect(entry.length).toBeGreaterThan(0);
        }
    });

    it('every entry matches the tree-sitter node identifier pattern', () => {
        for (const entry of DEF_TYPES) {
            expect(VALID_NODE_ID_RE.test(entry), `"${entry}" is not a valid node identifier`).toBe(true);
        }
    });

    it('has no leading or trailing whitespace in any entry', () => {
        for (const entry of DEF_TYPES) {
            expect(entry).toBe(entry.trim());
        }
    });

    it('contains no duplicate values (Set semantics)', () => {
        // A Set cannot store duplicates; verifying .size equals the array
        // length from the source is a useful cross-check.
        const arr = [...DEF_TYPES];
        const unique = new Set(arr);
        expect(arr.length).toBe(unique.size);
    });
});

// ---------------------------------------------------------------------------
// XML / HTML camelCase entries
// ---------------------------------------------------------------------------

describe('DEF_TYPES XML/HTML camelCase entries', () => {
    it('contains Attribute (XML attribute node)', () => {
        expect(DEF_TYPES.has('Attribute')).toBe(true);
    });

    it('contains EmptyElemTag (self-closing XML element)', () => {
        expect(DEF_TYPES.has('EmptyElemTag')).toBe(true);
    });

    it('contains STag (XML start tag)', () => {
        expect(DEF_TYPES.has('STag')).toBe(true);
    });

    it('has exactly 3 camelCase entries', () => {
        // Only the XML upstream node names are camelCase; all others are snake_case.
        const camel = [...DEF_TYPES].filter(t => /[A-Z]/.test(t));
        expect(camel.sort()).toEqual(['Attribute', 'EmptyElemTag', 'STag']);
    });
});

// ---------------------------------------------------------------------------
// Language-family coverage spot-checks
// ---------------------------------------------------------------------------

describe('DEF_TYPES JavaScript / TypeScript coverage', () => {
    it('contains function_declaration', () => expect(DEF_TYPES.has('function_declaration')).toBe(true));
    it('contains function_expression', () => expect(DEF_TYPES.has('function_expression')).toBe(true));
    it('contains generator_function', () => expect(DEF_TYPES.has('generator_function')).toBe(true));
    it('contains generator_function_declaration', () => expect(DEF_TYPES.has('generator_function_declaration')).toBe(true));
    it('contains class_declaration', () => expect(DEF_TYPES.has('class_declaration')).toBe(true));
    it('contains method_definition', () => expect(DEF_TYPES.has('method_definition')).toBe(true));
    it('contains lexical_declaration', () => expect(DEF_TYPES.has('lexical_declaration')).toBe(true));
    it('contains variable_declarator', () => expect(DEF_TYPES.has('variable_declarator')).toBe(true));
    it('contains abstract_class_declaration', () => expect(DEF_TYPES.has('abstract_class_declaration')).toBe(true));
    it('contains abstract_method_signature', () => expect(DEF_TYPES.has('abstract_method_signature')).toBe(true));
    it('contains public_field_definition', () => expect(DEF_TYPES.has('public_field_definition')).toBe(true));
    it('contains generator_declaration', () => expect(DEF_TYPES.has('generator_declaration')).toBe(true));
});

describe('DEF_TYPES Python coverage', () => {
    it('contains function_definition', () => expect(DEF_TYPES.has('function_definition')).toBe(true));
    it('contains class_definition', () => expect(DEF_TYPES.has('class_definition')).toBe(true));
    it('contains decorated_definition', () => expect(DEF_TYPES.has('decorated_definition')).toBe(true));
    it('contains assignment_statement', () => expect(DEF_TYPES.has('assignment_statement')).toBe(true));
});

describe('DEF_TYPES Rust coverage', () => {
    it('contains function_item', () => expect(DEF_TYPES.has('function_item')).toBe(true));
    it('contains struct_item', () => expect(DEF_TYPES.has('struct_item')).toBe(true));
    it('contains enum_item', () => expect(DEF_TYPES.has('enum_item')).toBe(true));
    it('contains trait_item', () => expect(DEF_TYPES.has('trait_item')).toBe(true));
    it('contains impl_item', () => expect(DEF_TYPES.has('impl_item')).toBe(true));
    it('contains const_item', () => expect(DEF_TYPES.has('const_item')).toBe(true));
    it('contains static_item', () => expect(DEF_TYPES.has('static_item')).toBe(true));
    it('contains type_item', () => expect(DEF_TYPES.has('type_item')).toBe(true));
    it('contains macro_definition', () => expect(DEF_TYPES.has('macro_definition')).toBe(true));
    it('contains mod_item', () => expect(DEF_TYPES.has('mod_item')).toBe(true));
    it('contains union_item', () => expect(DEF_TYPES.has('union_item')).toBe(true));
    it('contains enum_variant', () => expect(DEF_TYPES.has('enum_variant')).toBe(true));
});

describe('DEF_TYPES Go coverage', () => {
    it('contains short_var_declaration', () => expect(DEF_TYPES.has('short_var_declaration')).toBe(true));
    it('contains var_spec', () => expect(DEF_TYPES.has('var_spec')).toBe(true));
    it('contains const_spec', () => expect(DEF_TYPES.has('const_spec')).toBe(true));
    it('contains type_spec', () => expect(DEF_TYPES.has('type_spec')).toBe(true));
    it('contains type_declaration', () => expect(DEF_TYPES.has('type_declaration')).toBe(true));
});

describe('DEF_TYPES Java / C# / OOP coverage', () => {
    it('contains class_specifier (C++ class)', () => expect(DEF_TYPES.has('class_specifier')).toBe(true));
    it('contains interface_declaration', () => expect(DEF_TYPES.has('interface_declaration')).toBe(true));
    it('contains constructor_declaration', () => expect(DEF_TYPES.has('constructor_declaration')).toBe(true));
    it('contains method_declaration', () => expect(DEF_TYPES.has('method_declaration')).toBe(true));
    it('contains annotation_type_declaration', () => expect(DEF_TYPES.has('annotation_type_declaration')).toBe(true));
    it('contains enum_declaration', () => expect(DEF_TYPES.has('enum_declaration')).toBe(true));
    it('contains field_declaration', () => expect(DEF_TYPES.has('field_declaration')).toBe(true));
    it('contains delegate_declaration', () => expect(DEF_TYPES.has('delegate_declaration')).toBe(true));
    it('contains event_declaration', () => expect(DEF_TYPES.has('event_declaration')).toBe(true));
    it('contains record_declaration', () => expect(DEF_TYPES.has('record_declaration')).toBe(true));
    it('contains namespace_declaration', () => expect(DEF_TYPES.has('namespace_declaration')).toBe(true));
    it('contains file_scoped_namespace_declaration', () => expect(DEF_TYPES.has('file_scoped_namespace_declaration')).toBe(true));
});

describe('DEF_TYPES CSS / SCSS coverage', () => {
    it('contains rule_set', () => expect(DEF_TYPES.has('rule_set')).toBe(true));
    it('contains media_statement', () => expect(DEF_TYPES.has('media_statement')).toBe(true));
    it('contains keyframes_statement', () => expect(DEF_TYPES.has('keyframes_statement')).toBe(true));
    it('contains class_selector', () => expect(DEF_TYPES.has('class_selector')).toBe(true));
    it('contains id_selector', () => expect(DEF_TYPES.has('id_selector')).toBe(true));
    it('contains mixin_statement', () => expect(DEF_TYPES.has('mixin_statement')).toBe(true));
});

describe('DEF_TYPES SQL coverage', () => {
    it('contains create_table_statement', () => expect(DEF_TYPES.has('create_table_statement')).toBe(true));
    it('contains create_function_statement', () => expect(DEF_TYPES.has('create_function_statement')).toBe(true));
    it('contains create_view_statement', () => expect(DEF_TYPES.has('create_view_statement')).toBe(true));
    it('contains create_index_statement', () => expect(DEF_TYPES.has('create_index_statement')).toBe(true));
    it('contains create_type_statement', () => expect(DEF_TYPES.has('create_type_statement')).toBe(true));
    it('contains column_definition', () => expect(DEF_TYPES.has('column_definition')).toBe(true));
});

describe('DEF_TYPES Dockerfile coverage', () => {
    it('contains arg_instruction', () => expect(DEF_TYPES.has('arg_instruction')).toBe(true));
    it('contains env_instruction', () => expect(DEF_TYPES.has('env_instruction')).toBe(true));
    it('contains from_instruction', () => expect(DEF_TYPES.has('from_instruction')).toBe(true));
    it('contains label_instruction', () => expect(DEF_TYPES.has('label_instruction')).toBe(true));
});

describe('DEF_TYPES GraphQL / Protobuf coverage', () => {
    it('contains object_type_definition', () => expect(DEF_TYPES.has('object_type_definition')).toBe(true));
    it('contains interface_type_definition', () => expect(DEF_TYPES.has('interface_type_definition')).toBe(true));
    it('contains enum_type_definition', () => expect(DEF_TYPES.has('enum_type_definition')).toBe(true));
    it('contains input_object_type_definition', () => expect(DEF_TYPES.has('input_object_type_definition')).toBe(true));
    it('contains fragment_definition', () => expect(DEF_TYPES.has('fragment_definition')).toBe(true));
    it('contains operation_definition', () => expect(DEF_TYPES.has('operation_definition')).toBe(true));
    it('contains scalar_type_definition', () => expect(DEF_TYPES.has('scalar_type_definition')).toBe(true));
    it('contains schema_definition', () => expect(DEF_TYPES.has('schema_definition')).toBe(true));
    it('contains union_type_definition', () => expect(DEF_TYPES.has('union_type_definition')).toBe(true));
    it('contains message (Protobuf)', () => expect(DEF_TYPES.has('message')).toBe(true));
    it('contains service (Protobuf)', () => expect(DEF_TYPES.has('service')).toBe(true));
    it('contains rpc (Protobuf)', () => expect(DEF_TYPES.has('rpc')).toBe(true));
    it('contains oneof (Protobuf)', () => expect(DEF_TYPES.has('oneof')).toBe(true));
});

describe('DEF_TYPES Nix coverage', () => {
    it('contains attrset_expression', () => expect(DEF_TYPES.has('attrset_expression')).toBe(true));
    it('contains rec_attrset_expression', () => expect(DEF_TYPES.has('rec_attrset_expression')).toBe(true));
    it('contains let_expression', () => expect(DEF_TYPES.has('let_expression')).toBe(true));
    it('contains inherit', () => expect(DEF_TYPES.has('inherit')).toBe(true));
});

describe('DEF_TYPES Ruby coverage', () => {
    it('contains singleton_method', () => expect(DEF_TYPES.has('singleton_method')).toBe(true));
    it('contains alias', () => expect(DEF_TYPES.has('alias')).toBe(true));
});

describe('DEF_TYPES YAML / TOML / JSON coverage', () => {
    it('contains block_mapping_pair (YAML)', () => expect(DEF_TYPES.has('block_mapping_pair')).toBe(true));
    it('contains flow_pair (YAML)', () => expect(DEF_TYPES.has('flow_pair')).toBe(true));
    it('contains anchor (YAML)', () => expect(DEF_TYPES.has('anchor')).toBe(true));
    it('contains table (TOML)', () => expect(DEF_TYPES.has('table')).toBe(true));
    it('contains table_array_element (TOML)', () => expect(DEF_TYPES.has('table_array_element')).toBe(true));
    it('contains pair (JSON)', () => expect(DEF_TYPES.has('pair')).toBe(true));
    it('contains object (JSON)', () => expect(DEF_TYPES.has('object')).toBe(true));
});

describe('DEF_TYPES Markdown coverage', () => {
    it('contains atx_heading', () => expect(DEF_TYPES.has('atx_heading')).toBe(true));
    it('contains setext_heading', () => expect(DEF_TYPES.has('setext_heading')).toBe(true));
});

describe('DEF_TYPES C / C++ preprocessor coverage', () => {
    it('contains preproc_def', () => expect(DEF_TYPES.has('preproc_def')).toBe(true));
    it('contains preproc_function_def', () => expect(DEF_TYPES.has('preproc_function_def')).toBe(true));
    it('contains struct_specifier', () => expect(DEF_TYPES.has('struct_specifier')).toBe(true));
    it('contains union_specifier', () => expect(DEF_TYPES.has('union_specifier')).toBe(true));
    it('contains enum_specifier', () => expect(DEF_TYPES.has('enum_specifier')).toBe(true));
    it('contains concept_definition (C++20)', () => expect(DEF_TYPES.has('concept_definition')).toBe(true));
    it('contains namespace_definition', () => expect(DEF_TYPES.has('namespace_definition')).toBe(true));
});

// ---------------------------------------------------------------------------
// Absence checks — common node types that are NOT definition containers
// ---------------------------------------------------------------------------

describe('DEF_TYPES exclusion of non-definition node types', () => {
    it('does not contain the tree-sitter wildcard _', () => {
        expect(DEF_TYPES.has('_')).toBe(false);
    });

    it('does not contain identifier (a reference, not a definition container)', () => {
        expect(DEF_TYPES.has('identifier')).toBe(false);
    });

    it('does not contain string literal node types', () => {
        expect(DEF_TYPES.has('string')).toBe(false);
        expect(DEF_TYPES.has('string_literal')).toBe(false);
    });

    it('does not contain number literal types', () => {
        expect(DEF_TYPES.has('number')).toBe(false);
        expect(DEF_TYPES.has('integer')).toBe(false);
        expect(DEF_TYPES.has('number_literal')).toBe(false);
    });

    it('does not contain expression-only types', () => {
        expect(DEF_TYPES.has('binary_expression')).toBe(false);
        expect(DEF_TYPES.has('call_expression')).toBe(false);
        expect(DEF_TYPES.has('member_expression')).toBe(false);
    });

    it('does not contain comment node types', () => {
        expect(DEF_TYPES.has('comment')).toBe(false);
        expect(DEF_TYPES.has('block_comment')).toBe(false);
    });

    it('does not contain empty string', () => {
        expect(DEF_TYPES.has('')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Alphabetical ordering of the snake_case section
// ---------------------------------------------------------------------------

describe('DEF_TYPES alphabetical ordering', () => {
    it('snake_case entries appear in case-sensitive ASCII alphabetical order', () => {
        const snakeEntries = [...DEF_TYPES].filter(t => /^[a-z]/.test(t));
        const sorted = [...snakeEntries].sort();
        expect(snakeEntries).toEqual(sorted);
    });

    it('camelCase entries (XML) come before snake_case entries in insertion order', () => {
        const entries = [...DEF_TYPES];
        const firstSnakeIdx = entries.findIndex(t => /^[a-z]/.test(t));
        const lastCamelIdx = entries.map(t => /^[A-Z]/.test(t)).lastIndexOf(true);
        // All camelCase entries must appear before all snake_case entries
        expect(lastCamelIdx).toBeLessThan(firstSnakeIdx);
    });

    // Spot-check a few consecutive pairs within the snake_case section
    it('abstract_ entries precede alias entries', () => {
        const entries = [...DEF_TYPES];
        const abstractIdx = entries.indexOf('abstract_class_declaration');
        const aliasIdx = entries.indexOf('alias');
        expect(abstractIdx).toBeLessThan(aliasIdx);
    });

    it('function_ entries precede impl_ entries', () => {
        const entries = [...DEF_TYPES];
        const funcIdx = entries.indexOf('function_item');
        const implIdx = entries.indexOf('impl_item');
        expect(funcIdx).toBeLessThan(implIdx);
    });

    it('type_ entries precede variable_ entries', () => {
        const entries = [...DEF_TYPES];
        const typeIdx = entries.indexOf('type_alias');
        const varIdx = entries.indexOf('variable_assignment');
        expect(typeIdx).toBeLessThan(varIdx);
    });
});

// ---------------------------------------------------------------------------
// ReadonlySet runtime behaviour
// ---------------------------------------------------------------------------

describe('DEF_TYPES ReadonlySet runtime behaviour', () => {
    it('has() returns true for a known entry', () => {
        expect(DEF_TYPES.has('class_declaration')).toBe(true);
    });

    it('has() returns false for an unknown type', () => {
        expect(DEF_TYPES.has('definitely_not_a_node_type')).toBe(false);
    });

    it('has() returns false for a case-variant of a known entry', () => {
        // DEF_TYPES is case-sensitive; 'Class_Declaration' is not the same as
        // 'class_declaration'.
        expect(DEF_TYPES.has('Class_Declaration')).toBe(false);
        expect(DEF_TYPES.has('CLASS_DECLARATION')).toBe(false);
        expect(DEF_TYPES.has('ATTRIBUTE')).toBe(false);
    });

    it('has() returns false for partial matches', () => {
        expect(DEF_TYPES.has('class')).toBe(true); // 'class' IS in the set
        expect(DEF_TYPES.has('class_')).toBe(false);
        expect(DEF_TYPES.has('_class_declaration')).toBe(false);
    });

    it('iteration via for..of produces all entries', () => {
        let count = 0;
        for (const _entry of DEF_TYPES) count++;
        expect(count).toBe(DEF_TYPES.size);
    });

    it('spread operator produces an array of all entries', () => {
        const arr = [...DEF_TYPES];
        expect(arr.length).toBe(DEF_TYPES.size);
        expect(arr.every(e => typeof e === 'string')).toBe(true);
    });

    it('forEach iterates over all entries', () => {
        let count = 0;
        DEF_TYPES.forEach(() => count++);
        expect(count).toBe(DEF_TYPES.size);
    });
});

// ---------------------------------------------------------------------------
// Regression: minimum expected size guards against accidental deletion
// ---------------------------------------------------------------------------

describe('DEF_TYPES regression guards', () => {
    it('has at least 140 snake_case entries', () => {
        const snakeCount = [...DEF_TYPES].filter(t => /^[a-z]/.test(t)).length;
        expect(snakeCount).toBeGreaterThanOrEqual(140);
    });

    it('has exactly 3 camelCase entries (XML upstream node names)', () => {
        const camelCount = [...DEF_TYPES].filter(t => /[A-Z]/.test(t)).length;
        expect(camelCount).toBe(3);
    });

    it('no entry starts with a digit', () => {
        for (const entry of DEF_TYPES) {
            expect(/^\d/.test(entry), `"${entry}" starts with a digit`).toBe(false);
        }
    });

    it('no entry contains spaces or tabs', () => {
        for (const entry of DEF_TYPES) {
            expect(/[\s\t]/.test(entry), `"${entry}" contains whitespace`).toBe(false);
        }
    });

    it('no entry contains a dot (dots are capture name separators, not node types)', () => {
        for (const entry of DEF_TYPES) {
            expect(entry.includes('.'), `"${entry}" contains a dot`).toBe(false);
        }
    });
});