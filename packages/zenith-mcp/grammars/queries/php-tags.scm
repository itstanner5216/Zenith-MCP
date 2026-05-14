; Tree-sitter PHP definitions
; Captures functions, classes, interfaces, traits, enums, methods,
; properties, constants, and namespaces.

; --- Namespaces ---
(namespace_definition
  name: (namespace_name) @name.definition.namespace) @definition.namespace

; --- Functions ---
(function_definition
  name: (name) @name.definition.function) @definition.function

; --- Classes ---
(class_declaration
  name: (name) @name.definition.class) @definition.class

; --- Interfaces ---
(interface_declaration
  name: (name) @name.definition.interface) @definition.interface

; --- Traits ---
(trait_declaration
  name: (name) @name.definition.trait) @definition.trait

; --- Enums ---
(enum_declaration
  name: (name) @name.definition.enum) @definition.enum

; --- Methods ---
(method_declaration
  name: (name) @name.definition.method) @definition.method

; --- Constants ---
(const_declaration
  (const_element
    name: (name) @name.definition.constant)) @definition.constant

; --- Properties ---
(property_declaration
  (property_element
    (variable_name) @name.definition.property)) @definition.property

; Tree-sitter PHP references
; Captures function calls, method calls, object creation, and use declarations.

; --- Function calls ---
(function_call_expression
  function: (name) @name.reference.call) @reference.call

(function_call_expression
  function: (qualified_name) @name.reference.call) @reference.call

; --- Member method calls ---
(member_call_expression
  name: (name) @name.reference.call) @reference.call

; --- Static method calls ---
(scoped_call_expression
  name: (name) @name.reference.call) @reference.call

; --- Member property access ---
(member_access_expression
  name: (name) @name.reference.member) @reference.member

; --- Object creation ---
(object_creation_expression
  class: (named_type
    (name) @name.reference.type)) @reference.type

(object_creation_expression
  class: (named_type
    (qualified_name) @name.reference.type)) @reference.type

; --- Use declarations ---
(use_declaration
  (use_declarator
    (qualified_name) @name.reference.import)) @reference.import
