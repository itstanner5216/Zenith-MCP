; =============================================================================
; Nix — references.scm
; =============================================================================

; Bare identifier reference
(identifier) @name.reference.identifier @reference.identifier

; Attribute selection  →  expr.attr
(select_expression
  attrpath: (attrpath
    attr: (identifier) @name.reference.attribute)) @reference.attribute

; Function application  →  f x
(apply_expression
  function: (variable_expression
    name: (identifier) @name.reference.function)) @reference.function

; String interpolation  →  ${expr}
(interpolation
  expression: (variable_expression
    name: (identifier) @name.reference.variable)) @reference.variable
