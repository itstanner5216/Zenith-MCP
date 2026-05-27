import {
  defaultToonConfig,
  defaultFieldMatcher,
  defaultCodecConfig,
  defaultBMXConfig,
  type ToonConfig,
  type EncoderRule,
  type FieldMatcher,
} from './config.js';

// ---------------------------------------------------------------------------
//  Preset definitions
// ---------------------------------------------------------------------------

export const PRESETS: Record<string, ToonConfig> = {

  // generic
  // Safe default: only compresses long strings. Good starting point
  // when you don't know the shape of the tool output.
  "generic": defaultToonConfig({
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 500 }),
        codec: defaultCodecConfig("truncate", 400),
      } satisfies EncoderRule,
    ],
  }),

  "logs": defaultToonConfig({
    preserve_rules: [
      defaultFieldMatcher({ field_pattern: "(message|reasoning)$" }),
    ] satisfies FieldMatcher[],
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ field_path: "payload.output" }),
        codec: defaultCodecConfig("truncate", 400),
      } satisfies EncoderRule,
      {
        matcher: defaultFieldMatcher({ field_path: "payload.arguments" }),
        codec: defaultCodecConfig("parse_json"),
      } satisfies EncoderRule,
      {
        matcher: defaultFieldMatcher({ field_pattern: "(output|stdout|stderr)$" }),
        codec: defaultCodecConfig("truncate", 300),
      } satisfies EncoderRule,
    ],
  }),

  // mcp_responses
  // MCP (Model Context Protocol) tool responses: preserve structural
  // metadata fields, compress only genuinely large payloads.
  "mcp_responses": defaultToonConfig({
    preserve_rules: [
      defaultFieldMatcher({
        field_pattern: "(error|status|message|id|type)$",
      }),
    ] satisfies FieldMatcher[],
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 1000 }),
        codec: defaultCodecConfig("truncate", 500),
      } satisfies EncoderRule,
    ],
  }),

  // aggressive
  // Maximum compression: enables BMX+ scoring and applies tight
  // truncation to anything >= 200 characters.
  "aggressive": defaultToonConfig({
    bmx: defaultBMXConfig({ enabled: true }),
    encode_rules: [
      {
        matcher: defaultFieldMatcher({ min_length: 200 }),
        codec: defaultCodecConfig("truncate", 200),
      } satisfies EncoderRule,
    ],
  }),
};
