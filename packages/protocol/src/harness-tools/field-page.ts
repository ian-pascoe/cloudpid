// Reading a whole text, and the endpoint's limits (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Reading a whole field, and the endpoint's limits; ADR-0050): on the endpoint, `environment_get` and `settings_get` take
// `field` and `offset`, and answer a page of that field's text. Every harness tool's output schema is a flat object
// with optional keys for its variants, a page included, so `structuredContent` has the same shape on both MCP lanes.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";

/** The most characters of text one endpoint answer carries (`McpServer`'s content text is cut at this). */
export const ENDPOINT_TEXT_CHARS = 12_000;

/** The most one endpoint answer's structured result weighs stored, in bytes: under the handler's 64 KiB with its envelope. */
export const ENDPOINT_STRUCTURED_BYTES = 56 * 1024;

/** The most UTF-16 code units one field page holds. */
export const MAX_PAGE_CHARS = 40_000;

/** The most one field page weighs stored (its text as a JSON string), in bytes. */
export const MAX_PAGE_BYTES = 48 * 1024;

/** The `field` paths of `environment_get`, the Agent-change fields that hold a text a page can read. */
export const ENVIRONMENT_FIELD_PATTERN =
  /^(setupScript|startScript|toolchains|ignore|variables\.[A-Za-z_][A-Za-z0-9_]*)$/;

/** The `field` of `settings_get`: the Scope's own Instructions. */
export const SETTINGS_FIELD = "instructions";

/** What `offset` says, for both tools. */
const OFFSET_DESCRIPTION =
  "With field: where the page starts, in characters (UTF-16 code units): the previous answer's next_offset. Default 0.";

/** The `offset` of a page: the previous answer's `next_offset`. */
export const PageOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description: OFFSET_DESCRIPTION,
});

/** The `field` of `environment_get` on the endpoint. */
export const EnvironmentField = Schema.String.check(
  Schema.isPattern(ENVIRONMENT_FIELD_PATTERN),
).annotate({
  description:
    "Read one long text whole, a page at a time: setupScript, startScript, toolchains, ignore (one pattern a line) or variables.<NAME>. Leave it out for the whole Environment, whose long texts are cut.",
});

/** The `field` of `settings_get` on the endpoint. */
export const SettingsField = Schema.Literal(SETTINGS_FIELD).annotate({
  description:
    "instructions: read the Scope's own Instructions whole, a page at a time. At an Environment that is its own text only; Global's, which its Sessions are shown first, are scope \"*\". Leave it out for the Settings.",
});

/**
 * What a page of a field's text answers, as optional keys of the tool's flat output (set together, or all absent):
 * the Scope's id, the field, the page's text, where it starts, the whole text's length, and where the next page starts
 * (absent on the last).
 */
export const FieldPageFields = {
  id: Schema.optionalKey(Schema.String.annotate({ description: "A page: the Scope's id" })),
  field: Schema.optionalKey(Schema.String.annotate({ description: "A page: the field it reads" })),
  text: Schema.optionalKey(
    Schema.String.annotate({
      description: "A page: the field's text from offset, whole pages only",
    }),
  ),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: "A page: where text starts, in characters" }),
  ),
  total_chars: Schema.optionalKey(
    Schema.Int.annotate({ description: "A page: the whole text's length, in characters" }),
  ),
  next_offset: Schema.optionalKey(
    Schema.Int.annotate({
      description: "A page: pass it as offset for the next page; absent on the last page",
    }),
  ),
};
