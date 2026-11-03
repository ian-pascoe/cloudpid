// The main Worker's carry of an MCP sign-in change to the hosts that use it (`docs/architecture/mcp-sign-in.md` → Tokens reach
// the host object → Reports and pushes; The Environment's MCP host object #382 D6.3): the Registry never calls out, so when a
// callback completes, or after a sign-out or a rebind, the Worker that has the Registry's answer passes it to each host whose
// Environment uses the sign-in as `apply({ kind: "sign_ins", change, servers, revision })`. A carry never fails what caused
// it (the owner's page, a sign-out): a host it did not reach heals at its next `windowOpened`, whose pull finds the sign-ins
// revision moved (`docs/architecture/mcp.md` → Deploys: a loud failure that heals). What it logs is the Environment and the
// result's tag, never a token (there is none here) or the server's URL.
import { type McpApplyResult, type McpSignInChange, readMcpApplyResult } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { McpHostMethods } from "./host.ts";
import { mcpHostName } from "./name.ts";

/** The host objects, by name, as the main Worker reaches them. */
export type McpSignInHosts = {
  readonly host: (name: string) => Pick<McpHostMethods, "apply">;
};

/** What a change carries: the server as an entry spells it, the Environments that use the sign-in, and the new revision. */
export type McpSignInChangeFor = {
  readonly change: McpSignInChange;
  readonly server: string;
  readonly environments: ReadonlyArray<{ readonly id: string }>;
  readonly revision: number;
};

export type McpSignInCarry = {
  /** Pass `change` to the host of each Environment that uses the sign-in. Never fails. */
  readonly carry: (change: McpSignInChangeFor) => Effect.Effect<void>;
};

/** Why a host did not take the change, for the log. */
const failureText = (result: McpApplyResult): string =>
  Predicate.isTagged(result, "HostFailed") || Predicate.isTagged(result, "HostUnsupported")
    ? `${result._tag}: ${result.message}`
    : result._tag;

/** A carry that reaches no host: for a Worker or a test that has none. */
export const noSignInCarry: McpSignInCarry = { carry: () => Effect.void };

/** The carry over `hosts`. */
export const mcpSignInCarry = (hosts: McpSignInHosts): McpSignInCarry => ({
  carry: ({ change, server, environments, revision }) =>
    Effect.forEach(
      Arr.map(environments, ({ id }) => id),
      (environment) =>
        hosts
          .host(mcpHostName(environment))
          .apply({ kind: "sign_ins", change, servers: [server], revision })
          .pipe(
            Effect.map(readMcpApplyResult),
            Effect.flatMap((result) =>
              Predicate.isTagged(result, "SignInsTaken")
                ? Effect.void
                : Effect.logWarning(
                    `Environment ${environment}'s MCP host did not take a sign-in change (${failureText(result)})`,
                  ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Environment ${environment}'s MCP sign-in change was not sent`,
                cause,
              ),
            ),
          ),
      { discard: true, concurrency: "unbounded" },
    ),
});
