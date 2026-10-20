// @effect-diagnostics missingPipeableSignature:off extendsNativeError:off
// A depth limit for every htmlparser2 parse. The parser keeps its open elements in an array it prepends to, so a page
// that opens elements without closing them (`<div><div><div>…`) costs time quadratic in its depth: 100,000 levels take
// seconds, and the 5 MiB a fetch may read holds over a million. Conversion is synchronous, so nothing could interrupt
// it. Browsers stop nesting at 512 levels, so no real page reaches the limit; a page that does fails to convert, and
// `format: html` still returns it as it came.
import type { Handler } from "htmlparser2";

/** Most elements one page may have open at once. */
export const MAX_HTML_DEPTH = 1024;

/** A page nested deeper than `MAX_HTML_DEPTH`. */
export class HtmlTooDeepError extends Error {
  constructor() {
    super(`HTML is nested more than ${MAX_HTML_DEPTH} levels deep`);
    this.name = "HtmlTooDeepError";
  }
}

/** `handlers` that throw `HtmlTooDeepError` when an element opens past `MAX_HTML_DEPTH`. */
export const withDepthLimit = (handlers: Partial<Handler>): Partial<Handler> => {
  let depth = 0;

  return {
    ...handlers,
    onopentag(name, attributes, isImplied) {
      depth++;

      if (depth > MAX_HTML_DEPTH) throw new HtmlTooDeepError();

      handlers.onopentag?.(name, attributes, isImplied);
    },
    onclosetag(name, isImplied) {
      depth--;
      handlers.onclosetag?.(name, isImplied);
    },
  };
};
