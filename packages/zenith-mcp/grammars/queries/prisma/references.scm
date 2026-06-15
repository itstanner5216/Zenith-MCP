; Prisma Schema References
; captures type references and attribute references.

; Type reference in field type position (e.g., String, Int, MyModel)
(column_type
  (identifier) @name.reference.type)

; Attribute reference: @id, @unique, @relation
(attribute
  [
    (identifier) @name.reference.attribute
    (call_expression
      (identifier) @name.reference.attribute)
  ]) @reference.attribute

; Block attribute: @@index, @@unique
(block_attribute_declaration
  [
    (identifier) @name.reference.attribute
    (call_expression
      (identifier) @name.reference.attribute)
  ]) @reference.attribute

; Identifiers used as call arguments (e.g., model names in @relation)
(arguments
  (identifier) @name.reference.identifier) @reference.argument

(arguments
  (array
    (identifier) @name.reference.identifier)) @reference.argument

(arguments
  (type_expression
    (array
      (identifier) @name.reference.identifier))) @reference.argument
