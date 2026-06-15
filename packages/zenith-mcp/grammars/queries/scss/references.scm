; SCSS References
; tree-sitter-scss grammar
; Captures mixin includes, variable references, function calls, and selector references.

; Mixin include: @include name
(include_statement
  (identifier) @name.reference.mixin) @reference.mixin

; Variable reference in property value
(variable_value) @name.reference.variable

; Function call: name(args)
(call_expression
  (function_name) @name.reference.call) @reference.call

; Class selector reference (used in compound selectors / extends)
(class_selector
  (class_name) @name.reference.class) @reference.class

; Extend reference: @extend .selector
(extend_statement
  (class_selector
    (class_name) @name.reference.class)) @reference.extend

; Property name reference
(property_name) @name.reference.property
