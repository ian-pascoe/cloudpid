// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain function over native arrays, not a combinator.
// What the Browser Pane says while the agent drives an Owner tab (`docs/spec.md` → Browser → Browser Pane): the runs the
// Session says work in Owner tabs (`owner_tab_drivers`), for the Owner tab shown, named as the owner knows each agent:
// "The agent" for the root agent's, a subagent by its ID and role.

/**
 * Who is driving Owner tab `ownerTabId`, as the Pane says it, or null when no run works in it. `agentOf` names the agent
 * whose conversation a run is: undefined for the root agent's (or one the task graph does not list).
 */
export const drivingNote = (
  drivers: ReadonlyArray<{ readonly ownerTabId: string; readonly conversationId: number }>,
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
