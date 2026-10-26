// @effect-diagnostics missingPipeableSignature:off -- a plain function over text.

// What the Browser Pane's URL bar opens (#238): an http or https URL as it is, an address without a scheme over https
// (`example.com/a`, `localhost:3000`), or a blank page. Anything else is refused with a note: text that is not an
// address is not searched for or guessed at, and another scheme (`javascript:`, `file:`, `data:`) is not opened.

/** The URL to open, or why the text was refused. */
export type Address = { readonly url: string } | { readonly refused: string };

const NOT_AN_ADDRESS = "That is not a web address. Type a URL, such as https://example.com.";

const OTHER_SCHEME = "Only http and https addresses open here.";

/** A scheme at the start (`https:`), unless it is a host and port (`localhost:3000`). */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const HOST_AND_PORT = /^[^\s/:]+:\d+(?:[/?#]|$)/;

const parsed = (text: string): URL | undefined => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

/** What `text`, as the owner typed it in the URL bar, opens. */
export const addressOf = (text: string): Address => {
  const typed = text.trim();

  if (typed === "" || /\s/.test(typed)) return { refused: NOT_AN_ADDRESS };

  if (typed.toLowerCase() === "about:blank") return { url: "about:blank" };

  if (SCHEME.test(typed) && !HOST_AND_PORT.test(typed)) {
    const url = parsed(typed);

    if (url === undefined) return { refused: NOT_AN_ADDRESS };

    if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: OTHER_SCHEME };

    return url.hostname === "" ? { refused: NOT_AN_ADDRESS } : { url: url.href };
  }

  const url = parsed(`https://${typed}`);

  // A host with a dot (a domain or an IPv4 address), `localhost`, or an IPv6 address: one word alone is not an address.
  const host = url?.hostname ?? "";

  if (url === undefined || !(host.includes(".") || host === "localhost" || host.startsWith("["))) {
    return { refused: NOT_AN_ADDRESS };
  }

  return { url: url.href };
};
