; Prisma Schema Definitions
; Captures model, enum, type, datasource, generator, view, column, and enum value declarations.

; Model declaration: model Foo { ... }
(model_declaration
  (identifier) @name.definition.model) @definition.model

; View declaration: view Foo { ... }
(view_declaration
  (identifier) @name.definition.view) @definition.view

; Enum declaration: enum Foo { ... }
(enum_declaration
  (identifier) @name.definition.enum) @definition.enum

; Type declaration: type Foo { ... }
(type_declaration
  (identifier) @name.definition.type) @definition.type

; Datasource declaration: datasource db { ... }
(datasource_declaration
  (identifier) @name.definition.datasource) @definition.datasource

; Generator declaration: generator client { ... }
(generator_declaration
  (identifier) @name.definition.generator) @definition.generator

; Column/field declaration inside model/type/view
(column_declaration
  (identifier) @name.definition.field) @definition.field

; Enum value inside enum block
(enumeral
  (identifier) @name.definition.enum_value) @definition.enum_value
