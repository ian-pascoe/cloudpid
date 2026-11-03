// The head of a result's text that the model is given, found without a pass over the whole text
// (`docs/architecture/mcp-in-a-session.md` → Calls and results; `docs/architecture/mcp-connections.md` → The engine): a
// result may be 16 MiB of text, and the Session holds one at a time, so counting its lines and bytes must stop at the
// limits, not walk what lies beyond them.
// @effect-diagnostics missingPipeableSignature:off

/** The most text the model is given of one result before pi-durable cuts it: its default limits, which it does not export. */
export const MAX_TEXT_BYTES = 50 * 1024;

export const MAX_TEXT_LINES = 2000;

const encoder = new TextEncoder();

/** The offset of the newline that ends the last line the limit allows, or -1 when `text` has no more lines than that. */
const lineLimitAt = (text: string): number => {
  let from = 0;

  for (let lines = 1; lines <= MAX_TEXT_LINES; lines++) {
    const at = text.indexOf("\n", from);

    if (at < 0) return -1;

    // A trailing newline ends the last line; it does not start another.
    if (lines === MAX_TEXT_LINES) return at === text.length - 1 ? -1 : at;

    from = at + 1;
  }

  return -1;
};

/** How many characters of `text` fit in `MAX_TEXT_BYTES` as UTF-8, and whether all of it does. */
const byteLimitAt = (text: string): { readonly chars: number; readonly fits: boolean } => {
  const { read, written } = encoder.encodeInto(text, new Uint8Array(MAX_TEXT_BYTES + 1));

  return written <= MAX_TEXT_BYTES && read === text.length
    ? { chars: read, fits: true }
    : { chars: encoder.encodeInto(text, new Uint8Array(MAX_TEXT_BYTES)).read, fits: false };
};

/** How many lines `text` has: a trailing newline ends the last line, and starts no other. */
export const lineCountOf = (text: string): number => {
  if (text === "") return 0;

  let newlines = 0;

  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) newlines++;

  return newlines + (text.endsWith("\n") ? 0 : 1);
};

/**
 * The head of `text` within the limits (2000 lines, 50 KiB), as pi-durable's own cut of a tool's output keeps it: whole
 * lines, each with its newline, unless its first line is over the bytes; `undefined` when `text` is within them.
 */
export const headWithin = (text: string): string | undefined => {
  const lineEnd = lineLimitAt(text);
  const bytes = byteLimitAt(text);

  if (lineEnd < 0 && bytes.fits) return undefined;

  // The newline that ends the last line kept stays, as pi-durable's own cut leaves it.
  const byLines = lineEnd < 0 ? text.length : lineEnd + 1;

  if (bytes.fits || byLines <= bytes.chars) return text.slice(0, byLines);

  const cut = text.slice(0, bytes.chars);
  const lastLine = cut.lastIndexOf("\n");

  return lastLine >= 0 ? cut.slice(0, lastLine + 1) : cut;
};
