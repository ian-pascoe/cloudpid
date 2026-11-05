// The transcript before what a conversation's view holds: its watch's window has the newest entries, and the top of a
// thread offers the earlier ones, a page at a time (`entries`), in front of them.

import { useAtom } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { History } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { settledFailureOf } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "./conversation.ts";
import { scrollerOf } from "./scroller.ts";

/** Load the page of the conversation's transcript before its oldest message into its view; fails with why it could not. */
export const loadEarlierAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn((_: void, get) =>
    get
      .result(sessionClientAtom(key.sessionId))
      .pipe(Effect.flatMap((client) => client.loadEarlier(key.conversationId))),
  ),
);

/**
 * "Show earlier messages" at the top of a thread whose transcript goes back before what it shows (`earlier`, the
 * view's). A page loaded above keeps the messages the owner was reading where they were on the screen.
 */
export const EarlierHistory = ({
  conversation,
  earlier,
  oldest,
}: {
  conversation: ConversationKey;
  /** Whether the transcript goes back before the oldest message the thread holds. */
  earlier: boolean;
  /** The ID of the oldest message the thread holds, which a loaded page changes. */
  oldest: string | undefined;
}) => {
  const [result, load] = useAtom(loadEarlierAtom(conversation));
  const anchor = useRef<HTMLDivElement>(null);
  // How far the scroller's bottom was from its content's top when a page was asked for.
  const fromBottom = useRef<number | null>(null);
  const loading = result.waiting;
  const failure = settledFailureOf(result);

  // A loaded page moves the oldest message: put back what was on the screen, now further down.
  useLayoutEffect(() => {
    const scroller = scrollerOf(anchor.current);
    const distance = fromBottom.current;

    fromBottom.current = null;

    if (scroller !== null && distance !== null) {
      scroller.scrollTop = scroller.scrollHeight - distance;
    }
  }, [oldest]);

  return (
    <div
      ref={anchor}
      hidden={!earlier}
      className="flex flex-col items-center gap-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        disabled={loading || !earlier}
        onClick={() => {
          if (!earlier) return;

          const scroller = scrollerOf(anchor.current);

          fromBottom.current =
            scroller === null ? null : scroller.scrollHeight - scroller.scrollTop;
          load();
        }}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
      >
        <History className="size-3.5" aria-hidden />
        {loading ? "Loading earlier messages…" : "Show earlier messages"}
      </button>
      {failure !== null && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
};
