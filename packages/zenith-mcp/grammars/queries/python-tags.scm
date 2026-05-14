; --- Functions ---

(function_definition
  name: (identifier) @name.definition.function
) @definition.function

; --- Decorated functions ---

(decorated_definition
  definition: (function_definition
    name: (identifier) @name.definition.function)
) @definition.function

; --- Classes ---

(class_definition
  name: (identifier) @name.definition.class
) @definition.class

; --- Decorated classes ---

(decorated_definition
  definition: (class_definition
    name: (identifier) @name.definition.class)
) @definition.class

; --- Function calls ---

(call
  function: (identifier) @name.reference.call
) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)
) @reference.call

; --- Imports ---

(import_statement
  name: (dotted_name
    (identifier) @name.reference.module)
) @reference.module

(import_from_statement
  module_name: (dotted_name
    (identifier) @name.reference.module)
) @reference.module

(import_from_statement
  name: (dotted_name
    (identifier) @name.reference.import)
) @reference.import

; --- Attribute access ---

(attribute
  attribute: (identifier) @name.reference.property
) @reference.property
