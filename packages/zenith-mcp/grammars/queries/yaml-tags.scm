; Tree-sitter YAML definitions (ikatyang grammar)
; Captures mapping keys as property definitions.
; Anchors are captured as reusable definitions.

; --- Block mapping pairs (key: value) ---
(block_mapping_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name.definition.property)) @definition.property)

(block_mapping_pair
  key: (flow_node
    (double_quote_scalar) @name.definition.property) @definition.property)

(block_mapping_pair
  key: (flow_node
    (single_quote_scalar) @name.definition.property) @definition.property)

; --- Flow mapping pairs ---
(flow_pair
  key: (flow_node
    (plain_scalar
      (string_scalar) @name.definition.property)) @definition.property)

; --- Anchor definitions (&anchor_name) ---
(anchor
  (anchor_name) @name.definition.anchor) @definition.anchor

; Tree-sitter YAML references
; Captures alias references (*anchor_name) and anchor definitions.

; --- Alias references (*anchor_name) ---
(alias
  (alias_name) @name.reference.anchor) @reference.anchor

; --- Anchor as definition target (also a reference point) ---
(anchor
  (anchor_name) @name.reference.anchor) @reference.anchor
