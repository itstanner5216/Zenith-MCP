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

; Local variable declarations — initialized form: local x = expr
(variable_declaration
  (assignment_statement
    (variable_list
      name: (identifier) @local.definition)))

; Local variable declarations — bare form: local x  (no assignment)
(variable_declaration
  (variable_list
    name: (identifier) @local.definition))

; Local function at top level (direct child of chunk)
(chunk
  local_declaration: (function_declaration
    name: (identifier) @local.definition))

; Local function inside a block (nested inside any function/do/if/for/while/repeat)
(block
  local_declaration: (function_declaration
    name: (identifier) @local.definition))

; Numeric for-loop variable is a local definition
(for_numeric_clause
  name: (identifier) @local.definition)

; Generic for-loop variables are local definitions
(for_generic_clause
  (variable_list
    name: (identifier) @local.definition))

; Identifier references (all unresolved identifiers)
(identifier) @local.reference
