// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain function over native arrays, not a combinator.
// What the Browser Pane says while the agent drives an Owner tab (`docs/architecture/browser.md` → Browser Pane): the
// `browser` calls the Session says work in Owner tabs (`owner_tab_drivers`), for one Owner tab, named as the owner knows
// each agent: "The agent" for the root agent's, a subagent by its ID and role.

import type { OwnerTabDriver } from "@cloudpid/protocol";

/**
 * Who is driving Owner tab `ownerTabId`, as the Pane says it, or null when no call works in it. `agentOf` names the
 * agent whose conversation a call is: undefined for the root agent's (or one the task graph does not list).
 */
export const drivingNote = (
  drivers: ReadonlyArray<OwnerTabDriver>,
  ownerTabId: string | null,
  agentOf: (conversationId: number) => string | undefined,
): string | null => {
  if (ownerTabId === null) return null;

  const names = [
    ...new Set(
      drivers.flatMap((driver) =>
        driver.ownerTabId === ownerTabId ? [agentOf(driver.conversationId) ?? "The agent"] : [],
      ),
    ),
  ];

  if (names.length === 0) return null;

  const who =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

  return `${who} ${names.length === 1 ? "is" : "are"} driving this tab`;
};
