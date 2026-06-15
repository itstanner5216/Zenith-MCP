; Protocol Buffers Definitions
; Captures message, enum, service, rpc, and field definitions.

; Message definition: message Foo { ... }
(message
  (message_name (identifier) @name.definition.message)) @definition.message

; Enum definition: enum Foo { ... }
(enum
  (enum_name (identifier) @name.definition.enum)) @definition.enum

; Service definition: service Foo { ... }
(service
  (service_name (identifier) @name.definition.service)) @definition.service

; RPC method definition: rpc Method(...) returns (...)
(rpc
  (rpc_name (identifier) @name.definition.rpc)) @definition.rpc

; Message field definition
(field
  (identifier) @name.definition.field) @definition.field

; Oneof field definition
(oneof_field
  (identifier) @name.definition.field) @definition.field

; Map field definition
(map_field
  (identifier) @name.definition.field) @definition.field

; Enum field/value definition
(enum_field
  (identifier) @name.definition.enum_value) @definition.enum_value

; Oneof definition
(oneof
  (identifier) @name.definition.oneof) @definition.oneof
