; Tree-sitter Swift locals (CONSERVATIVE — alex-pinkus grammar)
; Scopes, local definitions, and parameters.

; --- Scopes ---
(function_declaration) @scope
(class_declaration) @scope
(protocol_declaration) @scope
(init_declaration) @scope
(lambda_literal) @scope
(if_statement) @scope
(while_statement) @scope
(for_statement) @scope

; --- Parameters ---
(parameter
  name: (simple_identifier) @local.parameter)

(lambda_parameter
  name: (simple_identifier) @local.parameter)

; --- Local variable bindings ---
; In `let x = ...` the identifier lives in (pattern bound_identifier:)
; inside a property_declaration; value_binding_pattern is just the sibling
; let/var keyword node, so we anchor on property_declaration.
(property_declaration
  (pattern
    bound_identifier: (simple_identifier) @local.definition))

; --- Local references ---
(simple_identifier) @local.reference
