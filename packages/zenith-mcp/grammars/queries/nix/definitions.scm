; =============================================================================
; Nix — definitions.scm
; Tree-sitter grammar: cstrahan/tree-sitter-nix
; =============================================================================

; let binding  →  name = expr;
(let_expression
  (binding_set
    (binding
      attrpath: (attrpath
        attr: (identifier) @name.definition.binding)))) @definition.binding

; Attribute set binding  →  { name = expr; }
(attrset_expression
  (binding_set
    (binding
      attrpath: (attrpath
        attr: (identifier) @name.definition.attribute)))) @definition.attribute

; Recursive attribute set binding  →  rec { name = expr; }
(rec_attrset_expression
  (binding_set
    (binding
      attrpath: (attrpath
        attr: (identifier) @name.definition.attribute)))) @definition.attribute

; Function parameter (simple)  →  arg: body
(function_expression
  universal: (identifier) @name.definition.parameter) @definition.parameter

; Function formals parameter  →  { arg, ... }: body
(function_expression
  formals: (formals
    (formal
      name: (identifier) @name.definition.parameter))) @definition.parameter

; inherit binding  →  inherit name;  or  inherit (src) name;
(inherit
  attrs: (inherited_attrs
    attr: (identifier) @name.definition.inherit)) @definition.inherit

(inherit_from
  attrs: (inherited_attrs
    attr: (identifier) @name.definition.inherit)) @definition.inherit
