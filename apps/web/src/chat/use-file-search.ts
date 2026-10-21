// The composer's `@` menu (`files`): what follows the `@` is sent to the Session once the owner pauses for
// `FILE_SEARCH_DEBOUNCE_MS`, and the last answer is kept while the next one is asked for, so the menu narrows it as the
// owner types (`filesMenu` in `menu.ts`). The Session holds the directory's listing, so each request is a ranking.

// @effect-diagnostics globalTimers:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: timers are the platform here.

import { useEffect, useRef, useState } from "react";
import type { SessionConnection } from "../session/connection.ts";
import type { FileResults } from "./menu.ts";

/** How long the owner pauses typing before the query is sent. */
export const FILE_SEARCH_DEBOUNCE_MS = 120;

/** A conversation and a query typed in its composer. */
type Asked = { readonly conversationId: number | undefined; readonly query: string };

/** An answer, with what it answers. */
type Held = Asked & { readonly paths: readonly string[] };

/**
 * What the Session answered for `query` (null while the menu is not open) in the root conversation's directory, or in
 * subagent conversation `conversationId`'s. The latest answer to arrive is kept until a later request's replaces it, so
 * an answer overtaken by a newer one is dropped; another `conversationId` starts over.
 */
export const useFileSearch = (
  connection: Pick<SessionConnection, "files">,
  conversationId: number | undefined,
  query: string | null,
): FileResults => {
  const [held, setHeld] = useState<Held | null>(null);
  const [failed, setFailed] = useState<Asked | null>(null);

  // Requests in the order they were sent, and the latest whose answer is shown.
  const sent = useRef(0);
  const shown = useRef(0);

  const answered = held !== null && held.conversationId === conversationId ? held : null;
  const answeredQuery = answered?.query ?? null;

  useEffect(() => {
    if (query === null || answeredQuery === query) return;

    const timer = setTimeout(() => {
      sent.current += 1;

      const request = sent.current;

      connection.files(query, conversationId).then(
        (answer) => {
          if (request < shown.current) return;

          shown.current = request;
          setHeld({ conversationId, query, paths: answer.paths });
          // A failure of this same query before no longer stands.
          setFailed((before) =>
            before !== null && before.conversationId === conversationId && before.query === query
              ? null
              : before,
          );
        },
        () => {
          setFailed({ conversationId, query });
        },
      );
    }, FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [connection, conversationId, query, answeredQuery]);

  const failedNow =
    failed !== null && failed.conversationId === conversationId && failed.query === query;

  return {
    query: answeredQuery,
    paths: answered?.paths ?? [],
    searching: query !== null && answeredQuery !== query && !failedNow,
    failed: failedNow,
  };
};
