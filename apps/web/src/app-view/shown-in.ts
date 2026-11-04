// @effect-diagnostics missingPipeableSignature:off -- plain readers of the Session's atoms, not combinators.
// `docs/architecture/mcp-apps.md` → App messages and App context. Where an App View is shown now: the conversation whose
// thread holds its call. A View kept across a move of the active branch is of a call made in another conversation than the
// one it is shown in, so its context and its messages go to the conversation shown, not the one that made the call.
import type { SessionView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { holdAppMessage, type AppMessageChipState } from "../chat/attachments-state.ts";
import { composerMountsAtom } from "../chat/composer-mounts.ts";
import { appEntryOf } from "../session/apps.ts";
import { activeBranchAtom, mcpAppsAtom, sessionStateAtom } from "../session/atoms.ts";
import { type ConversationKey, conversationKey } from "../session/conversation-key.ts";
import { unkey } from "./atoms.ts";

/** The conversation a View is shown in: its composer's key, and the conversation's ID as the Session knows it. */
export interface ShownIn {
  readonly key: ConversationKey;
  readonly conversation: number;
}

/** Whether `view`'s History, as loaded, holds the model's tool call `call`. */
const holds = (view: SessionView, call: string): boolean =>
  Arr.some(
    [...view.earlier, ...view.messages, ...(view.live === null ? [] : [view.live])],
    (message) =>
      message.role === "assistant" &&
      Arr.some(message.parts, (part) => part.type === "tool-call" && part.id === call),
  );

/**
 * Where the View of call `key` (`appKey`) is shown: the root's thread when it holds the call, else the thread of a watched
 * subagent that does; undefined when no loaded thread does (the call is out of the History loaded). A call nested in
 * `codemode` is the script's call in a thread.
 */
export const shownInAtom = Atom.family((key: string) =>
  Atom.make((get): ShownIn | undefined => {
    const { sessionId, callId } = unkey(key);
    const entry = appEntryOf(get(mcpAppsAtom(sessionId)), callId);
    const call = entry?.parentCall ?? callId;
    const state = get(sessionStateAtom(sessionId));
    const root = get(activeBranchAtom(sessionId));

    if (root !== null && holds(state.view, call)) {
      return { key: conversationKey(sessionId, undefined), conversation: root };
    }

    return Arr.findFirst(Record.toEntries(state.threads), ([, thread]) =>
      holds(thread.view, call),
    ).pipe(
      Option.map(([id]): ShownIn => ({
        key: conversationKey(sessionId, Number(id)),
        conversation: Number(id),
      })),
      Option.getOrUndefined,
    );
  }),
);

/**
 * Hold a View's message (`ui/message`) in the composer of the conversation it is shown in, read now: `held`, or `refused`
 * when it is shown in no thread, no composer of that conversation is mounted (a subagent's call in the root's thread, an App
 * Pane with no composer), or the composer has no room.
 */
export const holdWhereShown = (
  registry: AtomRegistry.AtomRegistry,
  appKey: string,
  chip: AppMessageChipState,
): Promise<"held" | "refused"> => {
  const shown = registry.get(shownInAtom(appKey));

  if (shown === undefined || registry.get(composerMountsAtom(shown.key)) === 0) {
    return Promise.resolve("refused");
  }

  return holdAppMessage(registry, shown.key, chip);
};
