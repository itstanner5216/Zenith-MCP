; SCSS Definitions
; tree-sitter-scss grammar (serenadeai/tree-sitter-scss)
; Captures rule sets, mixins, functions, variables, placeholders, keyframes, selectors.

; Rule set selector — the selectors node is the "name"
(rule_set
  (selectors) @name.definition.rule) @definition.rule

; Mixin declaration: @mixin name { ... }
(mixin_statement
  (name) @name.definition.mixin) @definition.mixin

; Function declaration: @function name($params) { ... }
(function_statement
  (name) @name.definition.function) @definition.function

; SCSS variable declaration: $var: value;
; Variable declarations have (variable_name) as the first child of (declaration)
(declaration
  (variable_name) @name.definition.variable) @definition.variable

; Placeholder selector: %placeholder { ... }
(placeholder
  (name) @name.definition.placeholder) @definition.placeholder

; Keyframes definition: @keyframes name { ... }
(keyframes_statement
  (keyframes_name) @name.definition.keyframes) @definition.keyframes

; Class selector inside rule set selectors
(class_selector
  (class_name) @name.definition.class) @definition.class

; ID selector
(id_selector
  (id_name) @name.definition.id) @definition.id
