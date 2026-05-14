; --- Functions ---

(function_item
  name: (identifier) @name.definition.function
) @definition.function

; --- Structs ---

(struct_item
  name: (type_identifier) @name.definition.struct
) @definition.struct

; --- Enums ---

(enum_item
  name: (type_identifier) @name.definition.enum
) @definition.enum

; --- Enum variants ---

(enum_variant
  name: (identifier) @name.definition.variant
) @definition.variant

; --- Traits ---

(trait_item
  name: (type_identifier) @name.definition.trait
) @definition.trait

; --- Impl blocks ---

(impl_item
  type: (type_identifier) @name.definition.impl
) @definition.impl

; --- Type aliases ---

(type_item
  name: (type_identifier) @name.definition.type
) @definition.type

; --- Modules ---

(mod_item
  name: (identifier) @name.definition.module
) @definition.module

; --- Constants ---

(const_item
  name: (identifier) @name.definition.constant
) @definition.constant

; --- Statics ---

(static_item
  name: (identifier) @name.definition.static
) @definition.static

; --- Unions ---

(union_item
  name: (type_identifier) @name.definition.union
) @definition.union

; --- Macros ---

(macro_definition
  name: (identifier) @name.definition.macro
) @definition.macro

; --- Struct/union fields ---

(field_declaration
  name: (field_identifier) @name.definition.field
) @definition.field

; --- Function calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)
) @reference.call

(call_expression
  function: (scoped_identifier
    name: (identifier) @name.reference.call)
) @reference.call

; --- Macro invocations ---

(macro_invocation
  macro: (identifier) @name.reference.macro
) @reference.macro

; --- Use declarations ---

(use_declaration
  argument: (scoped_identifier
    name: (identifier) @name.reference.import)
) @reference.import

(use_declaration
  argument: (identifier) @name.reference.import
) @reference.import

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Field access ---

(field_expression
  field: (field_identifier) @name.reference.field
) @reference.field

; --- Scoped identifiers (path references) ---

(scoped_identifier
  path: (identifier) @name.reference.module
) @reference.module
