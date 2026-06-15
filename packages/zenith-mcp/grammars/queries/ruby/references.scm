; Tree-sitter Ruby references
; Captures method calls, constant references, and scope resolutions.

; --- Method calls ---
(call
  method: (identifier) @name.reference.call) @reference.call

; --- Scope resolution (Namespace::Name) ---
; Only `constant` can appear as the name in scope_resolution;
; the grammar never produces an `identifier` there, so a single
; scope_resolution pattern (constant) covers all cases.
(scope_resolution
  name: (constant) @name.reference.constant) @reference.constant

; --- Standalone constant references ---
(constant) @name.reference.type

