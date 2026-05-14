; Tree-sitter CSS definitions
; Captures rule sets (by selector), keyframe animations, and media queries.

; --- Class selectors (.foo) ---
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.class))) @definition.class

; --- ID selectors (#foo) ---
(rule_set
  (selectors
    (id_selector
      (id_name) @name.definition.id))) @definition.id

; --- Tag/element selectors (div, span, etc.) ---
(rule_set
  (selectors
    (tag_name) @name.definition.tag)) @definition.tag

; --- Keyframe animations ---
(keyframes_statement
  (keyframes_name) @name.definition.keyframes) @definition.keyframes

; --- Media queries ---
(media_statement) @definition.media

; Tree-sitter CSS references
; Captures @import, property names, and references to classes/IDs.

; --- @import statements ---
(import_statement
  (string_value) @name.reference.import) @reference.import

; --- Property names ---
(declaration
  (property_name) @name.reference.property) @reference.property

; --- Tag names in selectors ---
(tag_name) @name.reference.tag

; --- Class names in selectors ---
(class_name) @name.reference.class

; --- ID names in selectors ---
(id_name) @name.reference.id

; --- Function calls (e.g., url(), rgb(), var()) ---
(call_expression
  (function_name) @name.reference.call) @reference.call
