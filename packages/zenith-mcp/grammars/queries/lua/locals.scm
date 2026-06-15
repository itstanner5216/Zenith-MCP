; Lua Locals
; scopes from blocks and functions; parameters; local bindings.

; Function body creates a scope
(function_declaration
  body: (block) @scope)

; do...end creates a scope
(do_statement
  body: (block) @scope)

; for loops create a scope
(for_statement
  body: (block) @scope)

; while loop creates a scope
(while_statement
  body: (block) @scope)

; repeat...until creates a scope
(repeat_statement
  body: (block) @scope)

; if statement body
(if_statement
  consequence: (block) @scope)

; Parameters are local definitions
(parameters
  (identifier) @local.parameter)

; Local variable declarations
(variable_declaration
  (assignment_statement
    (variable_list
      (identifier) @local.definition)))

; Local function is a local definition
(chunk
  local_declaration: (function_declaration
    name: (identifier) @local.definition))

; Identifier references (all unresolved identifiers)
(identifier) @local.reference
