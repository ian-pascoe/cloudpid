// The History a conversation's snapshot leaves out: the Context Windows before a Rollover or a compaction. The top of a
// thread offers it, a page at a time (`history`), and the thread shows it before the active window.

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

/** Load the page of the conversation's History before entry `before` into its view; fails with why it could not. */
export const loadEarlierAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn((before: number, get) =>
    get
      .result(sessionClientAtom(key.sessionId))
      .pipe(Effect.flatMap((client) => client.loadEarlier(before, key.conversationId))),
  ),
);

/**
 * "Show earlier messages" at the top of a thread whose History goes back before what it shows (`before`, the view's).
 * A page loaded above keeps the messages the owner was reading where they were on the screen.
 */
export const EarlierHistory = ({
  conversation,
  before,
}: {
  conversation: ConversationKey;
  /** The entry the History the thread does not hold ends before, or null when it holds all of it. */
  before: number | null;
}) => {
  const [result, load] = useAtom(loadEarlierAtom(conversation));
  const anchor = useRef<HTMLDivElement>(null);
  // How far the scroller's bottom was from its content's top when a page was asked for.
  const fromBottom = useRef<number | null>(null);
  const loading = result.waiting;
  const failure = settledFailureOf(result);

  // A loaded page moves `before`: put back what was on the screen, now further down.
  useLayoutEffect(() => {
    const scroller = scrollerOf(anchor.current);
    const distance = fromBottom.current;

    fromBottom.current = null;

    if (scroller !== null && distance !== null) {
      scroller.scrollTop = scroller.scrollHeight - distance;
    }
  }, [before]);

  return (
    <div
      ref={anchor}
      hidden={before === null}
      className="flex flex-col items-center gap-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        disabled={loading || before === null}
        onClick={() => {
          if (before === null) return;

          const scroller = scrollerOf(anchor.current);

          fromBottom.current =
            scroller === null ? null : scroller.scrollHeight - scroller.scrollTop;
          load(before);
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
