; Tree-sitter C definitions
; Captures function definitions, struct/union/enum types, typedefs, macros, and fields.

; --- Functions ---
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function)) @definition.function

; --- Structs ---
(struct_specifier
  name: (type_identifier) @name.definition.struct) @definition.struct

; --- Unions ---
(union_specifier
  name: (type_identifier) @name.definition.union) @definition.union

; --- Enums ---
(enum_specifier
  name: (type_identifier) @name.definition.enum) @definition.enum

; --- Typedefs ---
(type_definition
  declarator: (type_identifier) @name.definition.type) @definition.type

; --- Macro definitions ---
(preproc_def
  name: (identifier) @name.definition.macro) @definition.macro

(preproc_function_def
  name: (identifier) @name.definition.macro) @definition.macro

; --- Variable declarations (with initializers) ---
(declaration
  declarator: (init_declarator
    declarator: (identifier) @name.definition.variable)) @definition.variable

; --- Struct/union field declarations ---
(field_declaration
  declarator: (field_identifier) @name.definition.field) @definition.field

; --- Enum members ---
(enumerator
  name: (identifier) @name.definition.enumerator) @definition.enumerator

; Tree-sitter C references
; Captures function calls, field accesses, and type references.

; --- Function calls (direct) ---
(call_expression
  function: (identifier) @name.reference.call) @reference.call

; --- Function calls (through pointer / member) ---
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; --- Field access ---
(field_expression
  field: (field_identifier) @name.reference.field) @reference.field

; --- Type references ---
(type_identifier) @name.reference.type

; --- Preprocessor includes ---
(preproc_include) @reference.include
