; Tree-sitter Markdown definitions
; Captures heading sections as definition anchors.

; --- ATX headings (# Heading) ---
(atx_heading
  (inline) @name.definition.section) @definition.section

; --- Setext headings (underline style) ---
(setext_heading
  (paragraph
    (inline) @name.definition.section)) @definition.section

; Tree-sitter Markdown references
; Captures links and image references.

; --- Inline links ---
(inline_link
  (link_destination) @name.reference.link) @reference.link

; --- Reference links ---
(full_reference_link
  (link_label) @name.reference.link) @reference.link

(collapsed_reference_link
  (link_label) @name.reference.link) @reference.link

; --- Images ---
(image
  (link_destination) @name.reference.link) @reference.link
