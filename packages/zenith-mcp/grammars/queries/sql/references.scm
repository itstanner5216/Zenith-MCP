; Tree-sitter SQL references (CONSERVATIVE — DerekStride/tree-sitter-sql grammar)
; Captures table references in FROM/JOIN and function calls.

; --- Table references in FROM ---
(from
  (object_reference
    name: (identifier) @name.reference.table)) @reference.table

; --- Table references in JOIN ---
; join wraps its table in a `relation` node.
(join
  (relation
    (object_reference
      name: (identifier) @name.reference.table))) @reference.table

; --- Function calls ---
(invocation
  (object_reference
    name: (identifier) @name.reference.call)) @reference.call

; --- General identifier references ---
(object_reference
  name: (identifier) @name.reference.identifier) @reference.identifier

