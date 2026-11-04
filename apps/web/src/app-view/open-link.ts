// docs/architecture/mcp-apps.md → App sandbox, The bridge: `ui/open-link`. A View asks the host to open a link; nothing is opened
// without the owner: only `http` and `https` URLs are taken, the card shows the whole URL with its host emphasised, and the owner
// opens it (a new tab with no `opener` or referrer, or the Browser Pane) or dismisses it, which answers the View `-32000`. One
// request waits at a time: a newer one replaces it, and the replaced one is answered as dismissed.
/* oxlint-disable anti-slop/no-unknown-parameters -- a handler is given a View's own `params`, which `linkOf` decodes before anything reads them */
// @effect-diagnostics missingPipeableSignature:off globalTimers:off newPromise:off -- a promise that the owner's click settles.
import { MCP_APP_INVALID_PARAMS } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RpcError, type RequestHandler } from "./bridge.ts";

/** JSON-RPC's implementation-defined error that answers a request the owner turned down or did not answer. */
export const DISMISSED = -32000;

/** The longest URL a confirmation takes, in characters; one longer is refused, since the owner could not read it in full. */
export const MAX_LINK_CHARS = 4096;

/** A link waiting for the owner. */
export interface PendingLink {
  /** The URL as the View sent it, which the confirmation shows whole and which is what gets opened. */
  readonly url: string;
  /** The URL's host with its port: the part the confirmation emphasises. */
  readonly host: string;
  /** What the confirmation shows before the host, and after it, so the whole URL reads as sent. */
  readonly before: string;
  readonly after: string;
  /** The owner chose: open it in a new tab, in the Browser Pane, or dismiss it. */
  readonly settle: (choice: "open" | "pane" | "dismiss") => void;
}

const decodeParams = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

/**
 * The URL a `ui/open-link`'s `params` ask for, parsed: an `http` or `https` URL with a host and no credentials (they would
 * make the host the owner reads not the one the browser goes to); anything else is the View's mistake (`-32602`).
 */
export const linkOf = (params: unknown): URL => {
  const decoded = decodeParams(params);

  if (Option.isNone(decoded)) {
    throw new RpcError(MCP_APP_INVALID_PARAMS, "ui/open-link needs a url");
  }

  const text = decoded.value.url;

  if (text.length > MAX_LINK_CHARS)
    throw new RpcError(MCP_APP_INVALID_PARAMS, "The url is too long");

  const url = URL.canParse(text) ? new URL(text) : undefined;

  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new RpcError(MCP_APP_INVALID_PARAMS, "Only http and https links can be opened");
  }

  if (url.hostname === "" || url.username !== "" || url.password !== "") {
    throw new RpcError(MCP_APP_INVALID_PARAMS, "The url has no plain host");
  }

  return url;
};

/** The link as the confirmation shows it: the URL the browser would go to, split around its host. */
export const shownLink = (url: URL): Pick<PendingLink, "url" | "host" | "before" | "after"> => {
  const href = url.href;
  const at = href.indexOf(url.host);
  // `href` always holds its own `host`, after `//`.
  const start = at === -1 ? 0 : at;

  return {
    url: href,
    host: url.host,
    before: href.slice(0, start),
    after: href.slice(start + url.host.length),
  };
};

/**
 * The handler of `ui/open-link` for a card: `show` is told of the link waiting for the owner (and of none, when it is settled).
 * `open` does what Open does (`window.open(url, "_blank", "noopener,noreferrer")`) and `openInPane` what "Open in Browser Pane"
 * does; each is called only after the owner chose it. The View is answered `{}` once its link has been opened, and `-32000` when
 * the owner dismissed it, a newer request replaced it, or the frame went first.
 */
export const openLinkHandler = (options: {
  readonly show: (link: PendingLink | null) => void;
  readonly open: (url: string) => void;
  readonly openInPane: (url: string) => void;
}): RequestHandler => {
  let waiting: PendingLink | undefined;

  return (params, { signal }) =>
    new Promise((resolve, reject) => {
      const url = (() => {
        try {
          return linkOf(params);
        } catch (error: unknown) {
          reject(error);

          return undefined;
        }
      })();

      if (url === undefined) return;

      // A newer request replaces the one waiting: that one is answered as dismissed.
      waiting?.settle("dismiss");

      let over = false;

      const settle = (choice: "open" | "pane" | "dismiss"): void => {
        if (over) return;

        over = true;
        signal.removeEventListener("abort", dismiss);

        if (waiting === link) {
          waiting = undefined;
          options.show(null);
        }

        if (choice === "dismiss") {
          reject(new RpcError(DISMISSED, "The owner did not open the link"));

          return;
        }

        if (choice === "open") options.open(link.url);
        else options.openInPane(link.url);

        resolve({});
      };

      const dismiss = (): void => {
        settle("dismiss");
      };

      const link: PendingLink = { ...shownLink(url), settle };

      waiting = link;

      // A frame that is already going answers at once and shows nothing.
      if (signal.aborted) {
        dismiss();

        return;
      }

      signal.addEventListener("abort", dismiss, { once: true });
      options.show(link);
    });
};
