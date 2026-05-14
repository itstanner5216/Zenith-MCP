; Tree-sitter Ruby definitions
; Captures methods, singleton methods, classes, modules, and assignments.

; --- Instance methods ---
(method
  name: (identifier) @name.definition.method) @definition.method

; --- Singleton (class-level) methods ---
(singleton_method
  name: (identifier) @name.definition.method) @definition.method

; --- Classes ---
(class
  name: (constant) @name.definition.class) @definition.class

(class
  name: (scope_resolution) @name.definition.class) @definition.class

; --- Modules ---
(module
  name: (constant) @name.definition.module) @definition.module

(module
  name: (scope_resolution) @name.definition.module) @definition.module

; --- Constant assignments ---
(assignment
  left: (constant) @name.definition.constant) @definition.constant

; --- Variable assignments ---
(assignment
  left: (identifier) @name.definition.variable) @definition.variable

; --- Aliases ---
(alias
  name: (identifier) @name.definition.alias) @definition.alias

; Tree-sitter Ruby references
; Captures method calls, constant references, and scope resolutions.

; --- Method calls ---
(call
  method: (identifier) @name.reference.call) @reference.call

; --- Scope resolution (Namespace::Name) ---
(scope_resolution
  name: (constant) @name.reference.constant) @reference.constant

(scope_resolution
  name: (identifier) @name.reference.constant) @reference.constant

; --- Standalone constant references ---
(constant) @name.reference.type
