; Lua Definitions
; Covers function declarations, local functions, and variable assignments.

; Top-level function declaration: function foo() end
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Method/dot-style function: function obj.method() end
(function_declaration
  name: (dot_index_expression
    field: (identifier) @name.definition.method)) @definition.method

; Method style: function obj:method() end
(function_declaration
  name: (method_index_expression
    method: (identifier) @name.definition.method)) @definition.method

; Local function declaration: local function foo() end
; (represented as function_declaration inside a local_declaration field)
(chunk
  local_declaration: (function_declaration
    name: (identifier) @name.definition.function) @definition.function)

; Local variable declaration: local foo = ...
(variable_declaration
  (assignment_statement
    (variable_list
      (identifier) @name.definition.variable))) @definition.variable

; Assignment that looks like a definition at top scope
(assignment_statement
  (variable_list
    (identifier) @name.definition.variable)) @definition.variable
