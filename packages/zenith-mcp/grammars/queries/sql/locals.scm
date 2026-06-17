; Tree-sitter SQL locals (CONSERVATIVE — DerekStride/tree-sitter-sql grammar)
; Scopes for SELECT statements and function bodies.

; --- Scopes ---
(select) @scope
(subquery) @scope

; --- CTE definitions (WITH clause) ---
(cte
  (identifier) @local.definition)

; --- Column aliases ---
; In this grammar aliases are expressed via the `alias:` field on a term,
; not as a standalone `alias` node.
(term
  alias: (identifier) @local.definition)

; --- Table aliases ---
; Table aliases appear as `alias:` field on `relation` nodes in FROM/JOIN.
(relation
  alias: (identifier) @local.definition)
