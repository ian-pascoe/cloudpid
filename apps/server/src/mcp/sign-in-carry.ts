// The main Worker's carry of an MCP sign-in change to the hosts that use it (`docs/architecture/mcp-sign-in.md` →
// Tokens reach the host object → Reports and pushes; The Environment's MCP host object #382 D6.3): the Registry never
// calls out, so when a callback completes, or after a sign-out or a rebind, the Worker that has the Registry's answer
// passes it to each host whose Environment uses the sign-in as `apply({ kind: "sign_ins", change, servers, revision
// })`. A carry never fails what caused it (the owner's page, a sign-out): a host it did not reach heals at its next
// `windowOpened`, whose pull finds the sign-ins revision moved (`docs/architecture/mcp.md` → Deploys: a loud failure
// that heals). What it logs is the Environment and the result's tag, never a token (there is none here) or the server's
// URL.
import {
  type McpApplyResult,
  type McpResolvedWaiter,
  type McpSignInChange,
  readMcpApplyResult,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { McpHostMethods } from "./host.ts";
import { mcpHostName } from "./name.ts";
import { type McpSignInSessionCarry, noSignInSessionCarry } from "./sign-in-sessions.ts";

/** How long a host is waited for: the owner's page does not wait longer for a host that is slow or gone. */
export const CARRY_TIMEOUT = Duration.seconds(5);

/** The host objects, by name, as the main Worker reaches them. */
export type McpSignInHosts = {
  readonly host: (name: string) => Pick<McpHostMethods, "apply">;
};

/**
 * What a change carries: the server as an entry spells it, the Environments that use the sign-in, and the new revision.
 */
export type McpSignInChangeCarried = {
  readonly change: McpSignInChange;
  readonly server: string;
  readonly environments: ReadonlyArray<{ readonly id: string }>;
  readonly revision: number;
  /**
   * The Sign-in requests this change resolved (`completeMcpSignIn`'s `resolved`), which the Sessions are told of
   * (`mcp/sign-in-sessions.ts`); only a completed sign-in has any.
   */
  readonly resolved?: ReadonlyArray<McpResolvedWaiter>;
};

/**
 * Who sends which change: the callback sends `signed_in` (`serveCallback`), and a sign-out sends `signed_out`
 * (`mcp/sign-in-manage.ts`, from the answer of the Registry's `signOutMcpSignIn`). A rebind only happens as a sign-in
 * completes (the new issuer's tokens replace the old issuer's in that very write), so it is carried as `signed_in`, which
 * makes the host do what `rebound` would; nothing sends `rebound` yet.
 */
export type McpSignInCarry = {
  /** Pass `change` to the host of each Environment that uses the sign-in. Never fails. */
  readonly carry: (change: McpSignInChangeCarried) => Effect.Effect<void>;
};

/** Why a host did not take the change, for the log. */
const failureText = (result: McpApplyResult): string =>
  Predicate.isTagged(result, "HostFailed") || Predicate.isTagged(result, "HostUnsupported")
    ? `${result._tag}: ${result.message}`
    : result._tag;

/** A carry that reaches no host: for a Worker or a test that has none. */
export const noSignInCarry: McpSignInCarry = { carry: () => Effect.void };

/** The carry over `hosts`, and over `sessions` for the Sign-in requests a change resolved. */
export const mcpSignInCarry = (
  hosts: McpSignInHosts & { readonly sessions?: McpSignInSessionCarry },
): McpSignInCarry => ({
  carry: ({ change, server, environments, revision, resolved }) =>
    Effect.andThen(
      Effect.forEach(
        Arr.map(environments, ({ id }) => id),
        (environment) =>
          hosts
            .host(mcpHostName(environment))
            .apply({ kind: "sign_ins", change, servers: [server], revision })
            .pipe(
              // A host that does not answer does not hold the callback page: it heals at its next `windowOpened`.
              Effect.timeout(CARRY_TIMEOUT),
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
      (hosts.sessions ?? noSignInSessionCarry).carry(resolved ?? []),
    ),
});
