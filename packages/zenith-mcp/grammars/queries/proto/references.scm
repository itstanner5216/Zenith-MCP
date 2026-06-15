; Protocol Buffers References
; captures type references used in field and rpc declarations.

; Type reference in a field declaration (e.g., MyMessage field_name = 1)
(type) @name.reference.type

; Message type used as rpc input/output
(rpc
  (message_or_enum_type (identifier) @name.reference.type) @reference.type)

; Import reference
(import
  path: (string) @reference.import) @reference.import

; Option name reference (simple identifier)
(option
  (identifier) @name.reference.option) @reference.option

; Option name reference (qualified identifier)
(option
  (full_ident (identifier) @name.reference.option)) @reference.option

; Field option name reference (simple identifier)
(field_option
  (identifier) @name.reference.option) @reference.option

; Field option name reference (qualified identifier)
(field_option
  (full_ident) @name.reference.option) @reference.option
