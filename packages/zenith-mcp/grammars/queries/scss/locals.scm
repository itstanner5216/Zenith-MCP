; SCSS Locals
; tree-sitter-scss grammar
; Scopes: rule sets, mixin bodies, function bodies, @each, @for, @while, @if.
; Local definitions: variables, parameters, loop iteration variables.

; Rule set body is a scope
(rule_set
  (block) @scope)

; Mixin body is a scope
(mixin_statement
  (block) @scope)

; Function body is a scope
(function_statement
  (block) @scope)

; Each statement: @each $key, $value in list { }
(each_statement) @scope

; For statement: @for $var from 1 to 10 { }
(for_statement) @scope

; While statement: @while condition { }
(while_statement) @scope

; If clause body is a scope
(if_clause
  (block) @scope)

; Else clause body is a scope
(else_clause
  (block) @scope)

; SCSS variable local definitions (declarations with variable_name on LHS)
(declaration
  (variable_name) @local.definition)

; Mixin parameters
(mixin_statement
  (parameters
    (parameter
      (variable_name) @local.parameter)))

; Function parameters
(function_statement
  (parameters
    (parameter
      (variable_name) @local.parameter)))

; @each loop iteration variables — key
(each_statement
  (key) @local.definition)

; @each loop iteration variables — value
(each_statement
  (value) @local.definition)

; @for loop variable
(for_statement
  (variable) @local.definition)

; Variable references
(variable_value) @local.reference
