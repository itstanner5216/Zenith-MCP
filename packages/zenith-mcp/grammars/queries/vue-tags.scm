; Vue symbol tags
; Compatible with tree-sitter-grammars/tree-sitter-vue @ ce8011a414fdf8091f4e4071752efc376f4afb08
; WASM sha256 short: 94d9292677797c4d
;
; Zenith consumes @name.definition.* / @definition.* and
; @name.reference.* / @reference.* capture pairs from this file.
;
; Important: @definition.* captures must sit on canonical DEF_TYPES
; containers. Do not attach them to wrapper nodes like start_tag or
; self_closing_tag.

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
