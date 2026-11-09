// @effect-diagnostics missingPipeableSignature:off -- plain helpers over the page.

// docs/architecture/mcp-endpoint.md → Waiting requests: the link to a request waiting for the owner,
// `/sessions/<id>?request=<request_id>`, which `session_wait` and `session_get` give the Local agent, scrolls the Session
// page to that request's card. An Approval asked over the MCP endpoint (→ Approvals with no Session) has the link
// `/settings/<all|id>/<section>?request=<id>`, which scrolls the Settings page to its card the same way.
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { requestParamAtom } from "../router.ts";

/** The DOM id of the card for the request `requestId`: what `?request=` names. */
export const requestCardId = (requestId: string): string => `request-${requestId}`;

/**
 * How long the page looks for the card a link names while the Session loads: the card appears once the socket has
 * answered with the requests waiting, which can take a moment on a cold start.
 */
export const REQUEST_WAIT_MS = 10_000;

/** The page as `followRequest` reads it: a card by its id, changes to the page, and a timer. A test gives its own. */
export interface CardSource {
  /** The card with this DOM id, if it is on the page. */
  readonly find: (
    id: string,
  ) => { readonly scrollIntoView: (options: { block: "center" }) => void } | null;
  /** Calls `onChange` whenever the page's elements change; returns what stops it. */
  readonly watch: (onChange: () => void) => () => void;
  /** Calls `then` after `ms` milliseconds; returns what cancels it. */
  readonly after: (ms: number, then: () => void) => () => void;
}

/** The browser's page. */
export const browserCards: CardSource = {
  find: (id) => document.getElementById(id),
  watch: (onChange) => {
    const observer = new MutationObserver(onChange);

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  },
  after: (ms, then) => {
    const timer = window.setTimeout(then, ms);

    return () => {
      window.clearTimeout(timer);
    };
  },
};

/**
 * Bring the card of `request` into view: at once if it is on the page, else as soon as it renders, looking for
 * `REQUEST_WAIT_MS`. It scrolls once: it stops looking when the card is found. A request the Session no longer holds
 * (answered since) has no card, and the page stays where it is. Returns what stops the looking.
 */
export const followRequest = (request: string, source: CardSource): (() => void) => {
  const id = requestCardId(request);

  const show = (): boolean => {
    const card = source.find(id);

    card?.scrollIntoView({ block: "center" });

    return card !== null;
  };

  if (show()) return () => undefined;

  let stopWatching: () => void = () => undefined;
  let cancelGiveUp: () => void = () => undefined;

  const finish = () => {
    stopWatching();
    cancelGiveUp();
  };

  stopWatching = source.watch(() => {
    if (show()) finish();
  });
  cancelGiveUp = source.after(REQUEST_WAIT_MS, finish);

  return finish;
};

/** Brings the card of the request `?request=` names into view, once per request named (`followRequest`). */
export const useRequestInView = (): void => {
  const request = useAtomValue(requestParamAtom);

  useEffect(
    () => (request === undefined ? undefined : followRequest(request, browserCards)),
    [request],
  );
};
