// @effect-diagnostics missingPipeableSignature:off -- a plain string function.
// docs/architecture/visuals.md → The check (Page text reaches the model). A page's own words, as they go into a line the model
// reads: quoted, on one line, so a newline or a quote in them cannot start a line or a section of the tool's own.

/** `text` (cut at `max` characters, when given) as one JSON-quoted string; U+2028 and U+2029, which JSON leaves, are escaped. */
export const quoted = (text: string, max?: number): string =>
  JSON.stringify(max === undefined ? text : text.slice(0, max))
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
