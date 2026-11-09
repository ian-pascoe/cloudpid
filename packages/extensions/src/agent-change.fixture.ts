// @effect-diagnostics missingPipeableSignature:off
// An Agent change as the Registry records it, for tests of the tools that make them.
import type { AgentChange } from "@cloudpid/protocol";

/** An Agent change made by `tool`, approved, with `fields` over a plain one. */
export const recordedChange = (tool: string, fields: Partial<AgentChange> = {}): AgentChange => ({
  id: 7,
  scope: "settings",
  at: 1_000,
  actor: "agent",
  session: "s-1",
  conversation: 0,
  tool,
  reason: "The reason.",
  field: "",
  before: null,
  after: null,
  reverts: null,
  revertedBy: null,
  approved: true,
  ...fields,
});
