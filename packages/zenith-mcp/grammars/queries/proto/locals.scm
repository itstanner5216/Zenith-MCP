; Protocol Buffers Locals
; Message/enum/service/oneof/rpc blocks create scopes; fields/enum values are local definitions.

; Message body is a scope
(message
  (message_body) @scope)

; Enum body is a scope
(enum
  (enum_body) @scope)

; Service creates a scope
(service) @scope

; RPC creates a scope
(rpc) @scope

; Oneof creates a scope
(oneof) @scope

; Field names are local definitions within their scope
(field
  (identifier) @local.definition)

(oneof_field
  (identifier) @local.definition)

(map_field
  (identifier) @local.definition)

; Enum values are local definitions
(enum_field
  (identifier) @local.definition)

; Type references
(type) @local.reference
