; --- Scopes ---

(statement_block) @scope
(arrow_function) @scope
(function_declaration) @scope
(function_expression) @scope
(generator_function_declaration) @scope
(generator_function) @scope
(class_body) @scope
(for_statement) @scope
(for_in_statement) @scope
(catch_clause) @scope
(module) @scope
(jsx_element) @scope

; --- Parameters ---
; In the TSX grammar every parameter is wrapped in required_parameter /
; optional_parameter (there is no bare identifier directly under
; formal_parameters), so the parameter captures live in the section below. The
; bare (formal_parameters (identifier) ...) patterns are JavaScript-grammar
; shapes that are invalid here and made the whole query fail to compile.

; --- Required parameters (TypeScript typed) ---

(required_parameter
  (identifier) @local.parameter)

(optional_parameter
  (identifier) @local.parameter)

; --- Local definitions ---

(variable_declarator
  name: (identifier) @local.definition)

(function_declaration
  name: (identifier) @local.definition)

(class_declaration
  name: (type_identifier) @local.definition)

(interface_declaration
  name: (type_identifier) @local.definition)

(type_alias_declaration
  name: (type_identifier) @local.definition)

(enum_declaration
  name: (identifier) @local.definition)

; --- Local references ---

(identifier) @local.reference

(type_identifier) @local.reference

