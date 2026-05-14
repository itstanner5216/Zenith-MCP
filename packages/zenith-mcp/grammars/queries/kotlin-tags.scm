; Tree-sitter Kotlin definitions (CONSERVATIVE — fwcd grammar)
; Node names based on tree-sitter-kotlin by fwcd.
; May need adjustment for other Kotlin grammar implementations.

; --- Functions ---
(function_declaration
  (simple_identifier) @name.definition.function) @definition.function

; --- Classes ---
(class_declaration
  (type_identifier) @name.definition.class) @definition.class

; --- Objects (singletons) ---
(object_declaration
  (simple_identifier) @name.definition.object) @definition.object

; --- Properties ---
(property_declaration
  (simple_identifier) @name.definition.property) @definition.property

; --- Type aliases ---
(type_alias
  (simple_identifier) @name.definition.type) @definition.type

; Tree-sitter Kotlin references (CONSERVATIVE — fwcd grammar)
; Captures function calls, navigation expressions, and imports.

; --- Call expressions ---
(call_expression
  (simple_identifier) @name.reference.call) @reference.call

; --- Navigation (member access) ---
(navigation_expression
  (navigation_suffix
    (simple_identifier) @name.reference.member)) @reference.member

; --- Import headers ---
(import_header
  (identifier) @name.reference.import) @reference.import

; --- Type references ---
(user_type
  (simple_identifier) @name.reference.type) @reference.type

(user_type
  (type_identifier) @name.reference.type) @reference.type
