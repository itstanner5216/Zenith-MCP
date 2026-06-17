; Vue definitions
; Compatible with tree-sitter-grammars/tree-sitter-vue @ ce8011a414fdf8091f4e4071752efc376f4afb08
;
; @definition.* captures intentionally sit on canonical definition
; containers, not wrapper nodes like start_tag or self_closing_tag.

; Template elements / component tags
(element
  (start_tag
    (tag_name) @name.definition.element)) @definition.element

(element
  (self_closing_tag
    (tag_name) @name.definition.element)) @definition.element

; Attribute and directive names
(attribute
  (attribute_name) @name.definition.attribute) @definition.attribute

(directive_attribute
  (directive_name) @name.definition.directive) @definition.directive
