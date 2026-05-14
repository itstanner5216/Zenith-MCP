; Tree-sitter JSON definitions
; Captures object keys as property definitions for indexing and navigation.
; JSON has minimal definition/reference semantics — keys are the primary symbols.

; --- Top-level object pairs ---
(document
  (object
    (pair
      key: (string
        (string_content) @name.definition.property) @definition.property)))

; --- Nested object pairs (first level of nesting) ---
(document
  (object
    (pair
      value: (object
        (pair
          key: (string
            (string_content) @name.definition.property) @definition.property)))))

; --- All object pairs (general) ---
(object
  (pair
    key: (string
      (string_content) @name.definition.property) @definition.property))

; Tree-sitter JSON references
; JSON has no meaningful reference semantics.
; String values that look like keys are included for completeness.

; --- String values (potential references to other keys) ---
(pair
  value: (string
    (string_content) @name.reference.value) @reference.value)
