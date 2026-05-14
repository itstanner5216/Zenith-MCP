; Tree-sitter C++ definitions
; Extends C with classes, namespaces, templates, aliases, and concepts.

; --- Functions (same as C) ---
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier) @name.definition.function)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (destructor_name) @name.definition.function)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (operator_name) @name.definition.function)) @definition.function

; --- Structs (C-style) ---
(struct_specifier
  name: (type_identifier) @name.definition.struct) @definition.struct

; --- Unions ---
(union_specifier
  name: (type_identifier) @name.definition.union) @definition.union

; --- Enums ---
(enum_specifier
  name: (type_identifier) @name.definition.enum) @definition.enum

; --- Classes ---
(class_specifier
  name: (type_identifier) @name.definition.class) @definition.class

; --- Namespaces ---
(namespace_definition
  name: (identifier) @name.definition.namespace) @definition.namespace

(namespace_definition
  name: (namespace_identifier) @name.definition.namespace) @definition.namespace

; --- Typedefs ---
(type_definition
  declarator: (type_identifier) @name.definition.type) @definition.type

; --- Using / alias declarations ---
(alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

; --- Concepts ---
(concept_definition
  name: (identifier) @name.definition.concept) @definition.concept

; --- Macros ---
(preproc_def
  name: (identifier) @name.definition.macro) @definition.macro

(preproc_function_def
  name: (identifier) @name.definition.macro) @definition.macro

; --- Fields ---
(field_declaration
  declarator: (field_identifier) @name.definition.field) @definition.field

; --- Enum members ---
(enumerator
  name: (identifier) @name.definition.enumerator) @definition.enumerator

; Tree-sitter C++ references
; Extends C with qualified identifiers, template types, and new expressions.

; --- Function calls (direct) ---
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (qualified_identifier) @name.reference.call) @reference.call

; --- Function calls (through member) ---
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; --- Field access ---
(field_expression
  field: (field_identifier) @name.reference.field) @reference.field

; --- Type references ---
(type_identifier) @name.reference.type

; --- Qualified names (namespace::name) ---
(qualified_identifier
  name: (identifier) @name.reference.qualified) @reference.qualified

; --- Template types ---
(template_type
  name: (type_identifier) @name.reference.type) @reference.type

; --- new expressions ---
(new_expression
  type: (type_identifier) @name.reference.type) @reference.type

; --- Preprocessor includes ---
(preproc_include) @reference.include
