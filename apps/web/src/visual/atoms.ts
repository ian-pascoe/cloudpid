// @effect-diagnostics missingPipeableSignature:off -- keys built from strings, not combinators.
// docs/architecture/visuals.md → The frame, The copy. The atoms behind a Visual's card: its page, loaded when the card first
// comes near the viewport and kept with the card; which Visuals of a thread are superseded; and the heights this device
// remembers.
import type { VisualPageAnswer, VisualRecord, VisualStub } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import type { ConversationKey } from "../chat/conversation.ts";
import { appRuntime } from "../runtime.ts";
import { isSandboxOrigin } from "../sandbox-frame/frame-url.ts";
import { sessionClientAtom, sessionViewAtom, threadAtom, visualsAtom } from "../session/atoms.ts";
import type { SessionClient } from "../session/client.ts";
import { rememberedHeight, withHeight, type RememberedHeights } from "./height.ts";
import { NO_SUPERSEDED, sameSuperseded, supersededIn, visualEntries } from "./visuals.ts";

/** The key of one Visual: the Session it was shown in, and its call. */
export const visualKey = (sessionId: string, callId: string): string => `${sessionId}\0${callId}`;

const unkey = (key: string) => {
  const [sessionId = "", callId = ""] = key.split("\0");

  return { sessionId, callId };
};

/** What loading a card's page comes to. */
export type VisualLoad =
  /** Its record, and the origin it is served at: the frame mounts. */
  | { readonly status: "page"; readonly record: VisualRecord; readonly origin: string }
  /** It was evicted since the list said it was kept: the evicted card. */
  | { readonly status: "evicted"; readonly stub: VisualStub }
  /** The Session has no Visual of the call. */
  | { readonly status: "none" }
  /** It could not load: "Visual couldn't start: <why>", with Retry. */
  | { readonly status: "failed"; readonly reason: string };

/** The Session's answer, checked: a page is framed only at an App sandbox origin, never at whatever origin it was handed. */
export const loadOf = (answer: VisualPageAnswer, pageOrigin: string): VisualLoad => {
  switch (answer.status) {
    case "page": {
      if (!("record" in answer)) return { status: "none" };

      const origin = "origin" in answer ? answer.origin : undefined;

      if (origin === undefined) {
        return { status: "failed", reason: "This Session serves no Visual origin" };
      }

      if (!isSandboxOrigin(origin, pageOrigin)) {
        return { status: "failed", reason: `${origin} is not an App sandbox origin` };
      }

      return { status: "page", record: answer.record, origin };
    }

    case "evicted":
      return "stub" in answer ? { status: "evicted", stub: answer.stub } : { status: "none" };
    default:
      return { status: "none" };
  }
};

/** Load a Visual's page through the Session's client; the socket down is a failure with its reason. */
export const loadVisual = (
  client: Pick<SessionClient, "visualPage">,
  callId: string,
  pageOrigin: string,
): Effect.Effect<VisualLoad> =>
  client.visualPage(callId).pipe(
    Effect.map((answer) => loadOf(answer, pageOrigin)),
    Effect.catch((error) =>
      Effect.succeed<VisualLoad>({ status: "failed", reason: error.message }),
    ),
  );

/** What a card or Pane reads while it wants no page: nothing is loaded. */
export const NO_LOAD = Atom.make(AsyncResult.initial<VisualLoad>());

/**
 * Visual `key`'s page (`visualKey`), loaded: it loads when something reads it and again when read after nothing did, and
 * a refresh of it is Retry.
 */
export const visualLoadAtom = Atom.family((key: string) =>
  appRuntime.atom((get) => {
    const { sessionId, callId } = unkey(key);

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => loadVisual(client, callId, window.location.origin)));
  }),
);

/**
 * The Visuals of the thread `key` that a newer one of the same file supersedes (`supersededIn`): the root thread's, or a
 * subagent's. A thread with no Visual is the same empty map each time, and one whose answer is unchanged keeps the map it
 * had, so a transcript's every token redraws no card.
 */
export const visualSupersededAtom = Atom.family((key: ConversationKey) => {
  let last: ReadonlyMap<string, string> = NO_SUPERSEDED;

  return Atom.make((get): ReadonlyMap<string, string> => {
    const entries = visualEntries(get(visualsAtom(key.sessionId)));

    if (entries.length < 2) return (last = NO_SUPERSEDED);

    const view =
      key.conversationId === undefined
        ? get(sessionViewAtom(key.sessionId))
        : get(threadAtom({ sessionId: key.sessionId, conversationId: key.conversationId }))?.view;

    if (view === undefined) return (last = NO_SUPERSEDED);

    const messages = view.live === null ? view.messages : [...view.messages, view.live];
    const next = supersededIn(messages, entries);

    if (!sameSuperseded(next, last)) last = next;

    return last;
  });
});

/** Every Visual height this device remembers, the Visual shown last first. */
const heightsAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:visual-heights",
  schema: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
  defaultValue: (): RememberedHeights => [],
}).pipe(Atom.keepAlive);

/** The height this device remembers for Visual `callId`; writing it remembers another. */
export const visualHeightAtom = Atom.family((callId: string) =>
  Atom.writable(
    (get): number | undefined => rememberedHeight(get(heightsAtom), callId),
    (ctx, height: number) => {
      const heights = ctx.get(heightsAtom);
      const next = withHeight(heights, callId, height);

      if (next !== heights) ctx.set(heightsAtom, next);
    },
  ),
);
