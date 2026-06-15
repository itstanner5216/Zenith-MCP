; Prisma Schema Locals
; Model/enum/type/view/datasource/generator blocks create scopes; columns/enum values are local definitions.

; Model body is a scope
(model_declaration
  (statement_block) @scope)

; View body is a scope
(view_declaration
  (statement_block) @scope)

; Enum body is a scope
(enum_declaration
  (enum_block) @scope)

; Type body is a scope
(type_declaration
  (statement_block) @scope)

; Datasource body is a scope
(datasource_declaration
  (statement_block) @scope)

; Generator body is a scope
(generator_declaration
  (statement_block) @scope)

; Column/field declarations are local definitions
(column_declaration
  (identifier) @local.definition)

; Enum values are local definitions
(enumeral
  (identifier) @local.definition)

; Type identifier references in column_type / type_expression
(column_type
  (identifier) @local.reference)

(type_expression
  (identifier) @local.reference)

; General identifier references
(identifier) @local.reference
