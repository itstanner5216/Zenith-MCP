; --- Functions ---

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

; --- Methods ---

(method_declaration
  name: (field_identifier) @name.definition.method
) @definition.method

; --- Function literals ---

(short_var_declaration
  left: (expression_list
    (identifier) @name.definition.function)
  right: (expression_list
    (func_literal))
) @definition.function

; --- Types ---

(type_spec
  name: (type_identifier) @name.definition.type
) @definition.type

; --- Constants ---

(const_spec
  name: (identifier) @name.definition.constant
) @definition.constant

; --- Variables ---

(var_spec
  name: (identifier) @name.definition.variable
) @definition.variable

(short_var_declaration
  left: (expression_list
    (identifier) @name.definition.variable)
) @definition.variable

; --- Struct fields ---

(field_declaration
  name: (field_identifier) @name.definition.field
) @definition.field

; --- Function calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (selector_expression
    field: (field_identifier) @name.reference.call)
) @reference.call

; --- Selector / member access ---

(selector_expression
  field: (field_identifier) @name.reference.property
) @reference.property

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Imports ---

(import_spec
  path: (interpreted_string_literal) @name.reference.module
) @reference.module

; --- Composite literals ---

(composite_literal
  type: (type_identifier) @name.reference.type
) @reference.type
