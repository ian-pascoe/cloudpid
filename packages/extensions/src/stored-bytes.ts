// What a value weighs in a stored tool result (`docs/architecture/workspace.md` → The rest of one tool result). A result
// is one row of the Session DO's SQLite, written as JSON, so every cap on a part of it counts that part's JSON in UTF-8
// bytes: a quote, backslash or newline escaped takes two bytes, another control character six.
// @effect-diagnostics missingPipeableSignature:off
const encoder = new TextEncoder();

/** A part of a stored result: JSON, read-only or with properties left out, or `undefined` for a part left out. */
export type Stored =
  | null
  | boolean
  | number
  | string
  | readonly Stored[]
  | { readonly [key: string]: Stored }
  | undefined;

/** The UTF-8 bytes of `text`. */
export const byteLength = (text: string): number => encoder.encode(text).length;

/** What `value` weighs stored: its JSON, in UTF-8 bytes (a string's quotes included); `undefined` weighs nothing. */
export const storedBytes = (value: Stored): number => {
  // SAFETY: `JSON.stringify` answers `undefined` for `undefined`, which its declared `string` leaves out.
  const json = JSON.stringify(value) as string | undefined;

  return json === undefined ? 0 : byteLength(json);
};

/**
 * The head of `text` whose JSON string weighs at most `maxBytes` stored, followed by `marker`, cut on a character
 * boundary (a surrogate pair is never split); `text` itself when it fits.
 */
export const cutStored = (text: string, maxBytes: number, marker: string): string => {
  if (storedBytes(text) <= maxBytes) return text;

  // The longest head that fits with the marker, found by halving: the stored weight grows with the head.
  let low = 0;
  let high = text.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (storedBytes(text.slice(0, middle) + marker) <= maxBytes) low = middle;
    else high = middle - 1;
  }

  const code = text.charCodeAt(low - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? low - 1 : low;

  return text.slice(0, end) + marker;
};
