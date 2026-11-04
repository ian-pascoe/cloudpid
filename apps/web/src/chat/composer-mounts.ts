// @effect-diagnostics missingPipeableSignature:off -- a hook over an atom, not a combinator.
// How many composers of each conversation are mounted: an App View's message (`ui/message`) is held in a composer the owner
// can see, so one for a conversation with none mounted is refused (`app-view/shown-in.ts`).
import { RegistryContext } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { useContext, useEffect } from "react";
import type { ConversationKey } from "../session/conversation-key.ts";

/** The composers mounted for a conversation. */
export const composerMountsAtom = Atom.family((_key: ConversationKey) =>
  Atom.make(0).pipe(Atom.keepAlive),
);

/** Count the composer that calls this among the conversation's mounted ones, while it is. */
export const useComposerMounted = (key: ConversationKey): void => {
  const registry = useContext(RegistryContext);

  useEffect(() => {
    const mounts = composerMountsAtom(key);

    registry.set(mounts, registry.get(mounts) + 1);

    return () => {
      registry.set(mounts, registry.get(mounts) - 1);
    };
  }, [registry, key.sessionId, key.conversationId]);
};
