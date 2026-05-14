; --- Functions ---

(function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(function_expression
  name: (identifier) @name.definition.function
) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function
) @definition.function

(generator_function
  name: (identifier) @name.definition.function
) @definition.function

; --- Arrow functions via variable declarator ---

(variable_declarator
  name: (identifier) @name.definition.function
  value: (arrow_function)
) @definition.function

(variable_declarator
  name: (identifier) @name.definition.function
  value: (function_expression)
) @definition.function

; --- Classes ---

(class_declaration
  name: (identifier) @name.definition.class
) @definition.class

(class
  name: (identifier) @name.definition.class
) @definition.class

; --- Methods ---

(method_definition
  name: (property_identifier) @name.definition.method
) @definition.method

; --- Variables / Constants ---

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
  )
) @definition.variable

; --- Assignments (module.exports style) ---

(assignment_expression
  left: (identifier) @name.definition.variable
) @definition.variable

; --- Object method shorthand ---

(pair
  key: (property_identifier) @name.definition.method
  value: [(function_expression) (arrow_function)]
) @definition.method

; --- Function/method calls ---

(call_expression
  function: (identifier) @name.reference.call
) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
) @reference.call

; --- Constructor calls ---

(new_expression
  constructor: (identifier) @name.reference.class
) @reference.class

(new_expression
  constructor: (member_expression
    property: (property_identifier) @name.reference.class)
) @reference.class

; --- Imports ---

(import_statement
  source: (string) @name.reference.module
) @reference.module

; --- Member access ---

(member_expression
  property: (property_identifier) @name.reference.property
) @reference.property

