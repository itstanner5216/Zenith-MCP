; Tree-sitter Bash definitions
; Captures function definitions and variable assignments.

; --- Functions ---
(function_definition
  name: (word) @name.definition.function) @definition.function

; --- Variable assignments ---
(variable_assignment
  name: (variable_name) @name.definition.variable) @definition.variable

; Tree-sitter Bash references
; Captures command invocations and variable expansions.

; --- Command invocations ---
(command
  name: (command_name
    (word) @name.reference.call)) @reference.call

; --- Simple variable expansions ($VAR) ---
(simple_expansion
  (variable_name) @name.reference.variable) @reference.variable

; --- Full variable expansions (${VAR}) ---
(expansion
  (variable_name) @name.reference.variable) @reference.variable

; --- Command substitutions ---
(command_substitution) @reference.call
