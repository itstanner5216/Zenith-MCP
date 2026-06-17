; =============================================================================
; Regex — references.scm
; Backreferences refer back to a previously captured group.
; =============================================================================

; Numbered backreference  →  \1
(decimal_escape) @name.reference.backref @reference.backref

; Named backreference  →  \k<name>
(backreference_escape
  (group_name) @name.reference.group) @reference.group
