// @effect-diagnostics missingPipeableSignature:off -- a React hook, not a combinator.
// Who drives an Owner tab, as the Browser Pane says it (`./driving.ts`), with each subagent named from the Session's task
// graph: the Pane's note over the screen and the tab strip's mark say the same. The task graph is watched only while a
// component that asks is mounted, which is while a `browser` call drives the tab.

import type { OwnerTabDriver } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { agentLabel } from "../session/agents.ts";
import { taskGraphAtom } from "../session/atoms.ts";
import { drivingNote } from "./driving.ts";

/** Who is driving Owner tab `ownerTabId` of Session `sessionId` among `drivers`, or null when no call works in it. */
export const useDrivingNote = (
  sessionId: string,
  drivers: ReadonlyArray<OwnerTabDriver>,
  ownerTabId: string,
): string | null => {
  const graph = useAtomValue(taskGraphAtom(sessionId));

  return drivingNote(drivers, ownerTabId, (conversationId) => agentLabel(graph, conversationId));
};
