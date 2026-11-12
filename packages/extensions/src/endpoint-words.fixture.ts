// The contract of the words the endpoint's tools answer in (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Names and surfaces): the caller is a Local agent with no Session, whom the owner, not the user,
// answers to. The cores' tests use `expectEndpointWords` on every text they answer or refuse with, so the contract is
// stated once.
import { HARNESS_TOOL_NAMES } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import { expect } from "vite-plus/test";

/** The tools a caller can be sent to: those the endpoint serves, and `session_start`, which `environment_create` names. */
const SERVED: ReadonlyArray<string> = [...HARNESS_TOOL_NAMES, "session_start"];

/**
 * The tool names a text holds. Each must be one the endpoint can serve: a sentence that names another
 * (`container_restart`, `secret_ask`, a Limit tool) sends the caller to a tool it does not have.
 */
const namedTools = (said: string): ReadonlyArray<string> =>
  said.match(/\b(?:container|secret|environment|settings|session)_[a-z_]+\b/g) ?? [];

/** Fails when `said` speaks of a Session the caller has, of the user, or of a tool the endpoint does not serve. */
export const expectEndpointWords = (said: string): void => {
  expect(Arr.filter(namedTools(said), (name) => !SERVED.includes(name))).toEqual([]);
  expect(said).not.toContain("this Session");
  expect(said).not.toMatch(/\buser\b/);
};
