; --- Classes ---

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

; --- Interfaces ---

(interface_declaration
  name: (identifier) @name.definition.interface
) @definition.interface

; --- Enums ---

(enum_declaration
  name: (identifier) @name.definition.enum
) @definition.enum

; --- Enum constants ---

(enum_constant
  name: (identifier) @name.definition.constant
) @definition.constant

; --- Annotation types ---

(annotation_type_declaration
  name: (identifier) @name.definition.annotation
) @definition.annotation

; --- Records ---

(record_declaration
  name: (identifier) @name.definition.class
) @definition.class

; --- Methods ---

(method_declaration
  name: (identifier) @name.definition.method
) @definition.method

; --- Constructors ---

(constructor_declaration
  name: (identifier) @name.definition.constructor
) @definition.constructor

; --- Fields ---

(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name.definition.field)
) @definition.field

; --- Constants (static final fields) ---

(constant_declaration
  declarator: (variable_declarator
    name: (identifier) @name.definition.constant)
) @definition.constant

; --- Method invocations ---

(method_invocation
  name: (identifier) @name.reference.call
) @reference.call

(method_invocation
  object: (identifier) @name.reference.object
  name: (identifier) @name.reference.call
) @reference.call

; --- Object creation ---

(object_creation_expression
  type: (type_identifier) @name.reference.class
) @reference.class

; --- Field access ---

(field_access
  field: (identifier) @name.reference.field
) @reference.field

; --- Type references ---

(type_identifier) @name.reference.type @reference.type

; --- Imports ---

(import_declaration
  (scoped_identifier
    name: (identifier) @name.reference.import)
) @reference.import

; --- Scoped identifiers ---

(scoped_identifier
  name: (identifier) @name.reference.scoped
) @reference.scoped

; --- Class literals ---

(class_literal
  name: (identifier) @name.reference.class
) @reference.class
