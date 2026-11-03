// docs/architecture/mcp-endpoint.md → Waiting requests: the link to a request waiting for the owner,
// `/sessions/<id>?request=<request_id>`, which `session_wait` and `session_get` give the Local agent, scrolls the Session
// page to that request's card.
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

/**
 * Bring the card of the request `?request=` names into view, once it has rendered, and once per request named. A request
 * the Session no longer holds (answered since) has no card: the page stays where it is, after `REQUEST_WAIT_MS`.
 */
export const useRequestInView = (): void => {
  const request = useAtomValue(requestParamAtom);

  useEffect(() => {
    if (request === undefined) return;

    const id = requestCardId(request);

    const show = (): boolean => {
      const card = document.getElementById(id);

      card?.scrollIntoView({ block: "center" });

      return card !== null;
    };

    if (show()) return;

    const watch = new MutationObserver(() => {
      if (show()) watch.disconnect();
    });

    watch.observe(document.body, { childList: true, subtree: true });

    const giveUp = window.setTimeout(() => {
      watch.disconnect();
    }, REQUEST_WAIT_MS);

    return () => {
      watch.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [request]);
};
