; Tree-sitter Swift definitions (CONSERVATIVE — alex-pinkus grammar)
; Node names based on tree-sitter-swift by alex-pinkus.
; May need adjustment for other Swift grammar implementations.

; --- Functions ---
(function_declaration
  name: (simple_identifier) @name.definition.function) @definition.function

; --- Classes ---
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

; --- Protocols ---
(protocol_declaration
  name: (type_identifier) @name.definition.protocol) @definition.protocol

; --- Type aliases ---
(typealias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

; --- Initializers ---
(init_declaration) @definition.init

; --- Properties (via pattern binding) ---
(property_declaration
  (pattern
    (simple_identifier) @name.definition.property)) @definition.property

; Tree-sitter Swift references (CONSERVATIVE — alex-pinkus grammar)
; Captures function calls, navigation (member access), and imports.

; --- Call expressions ---
(call_expression
  (simple_identifier) @name.reference.call) @reference.call

; --- Navigation / member access ---
(navigation_expression
  (navigation_suffix
    (simple_identifier) @name.reference.member)) @reference.member

; --- Import declarations ---
(import_declaration
  (identifier) @name.reference.import) @reference.import

; --- Type references ---
(user_type
  (type_identifier) @name.reference.type) @reference.type
