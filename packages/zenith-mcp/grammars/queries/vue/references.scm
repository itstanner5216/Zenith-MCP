; Vue references
; Compatible with tree-sitter-grammars/tree-sitter-vue @ ce8011a414fdf8091f4e4071752efc376f4afb08
;
; @reference.* captures intentionally sit on canonical reference
; containers, not wrapper nodes like end_tag or quoted_attribute_value.

; End tags reference their opening elements
(element
  (end_tag
    (tag_name) @name.reference.element)) @reference.element

; Vue directive values and dynamic directive expressions
(directive_attribute
  (directive_value) @name.reference.directive) @reference.directive

(directive_attribute
  (dynamic_directive_value
    (dynamic_directive_inner_value) @name.reference.directive)) @reference.directive

; Mustache/interpolation content
(interpolation
  (raw_text) @name.reference.expression) @reference.expression

; URL-ish attribute values
(attribute
  (attribute_name) @_attr_name
  (quoted_attribute_value
    (attribute_value) @name.reference.url)
  (#any-of? @_attr_name "href" "src")) @reference.url
