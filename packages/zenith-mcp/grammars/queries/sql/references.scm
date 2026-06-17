; Tree-sitter SQL references (CONSERVATIVE — DerekStride/tree-sitter-sql grammar)
; Captures table references in FROM/JOIN/DML and function calls.

; --- Table references in FROM (SELECT) ---
; In SELECT, FROM wraps tables in `relation` nodes.
(from
  (relation
    (object_reference
      name: (identifier) @name.reference.table))) @reference.table

; --- Table references in FROM (DELETE) ---
; DELETE FROM does NOT wrap in `relation`, object_reference is a direct child.
(from
  (object_reference
    name: (identifier) @name.reference.table)) @reference.table

; --- Table references in JOIN ---
; join wraps its table in a `relation` node.
(join
  (relation
    (object_reference
      name: (identifier) @name.reference.table))) @reference.table

; --- Table references in INSERT ---
(insert
  (object_reference
    name: (identifier) @name.reference.table)) @reference.table

; --- Table references in UPDATE ---
(update
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
