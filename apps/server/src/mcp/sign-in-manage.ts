// What the main Worker answers the client about the owner's MCP sign-ins (`docs/architecture/mcp-sign-in.md` → Settings,
// Sign-out): `mcpSignIns` and `signOutMcpSignIn` of `RegistryRpcs`. The Registry holds the rows and does the revocation;
// this adds what only the Worker knows (the stage: its label, whether it runs under `alchemy dev`, whether the client
// document is in the ladder, and the app origin the redirect URI is under) and, after a sign-out, passes `signed_out` to the
// hosts of the Environments that used the sign-in (`sign-in-carry.ts`), since the Registry never calls out.
//
// Every answer has a fallback: a Registry that fails, or is a version that lacks the method, is `Unavailable`
// (`docs/architecture/mcp.md` → Deploys), whose message never carries the cause.
// @effect-diagnostics missingPipeableSignature:off -- operations over plain values, not combinators.
import {
  McpUnavailable,
  type McpSignInsView,
  type McpSignInStageView,
  type McpSignOutView,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Types from "effect/Types";
import type { RegistryMethods } from "../registry/Registry.ts";
import {
  APP_ORIGIN_VAR,
  LOCAL_MODE_VAR,
  MCP_CLIENT_DOCUMENT_VAR,
  STAGE_LABEL_VAR,
} from "../deployment.ts";
import type { McpSignInCarry } from "./sign-in-carry.ts";
import type { SignInEnv } from "./sign-in-http.ts";

type ManageRegistry = Pick<RegistryMethods, "listMcpSignIns" | "signOutMcpSignIn">;

/** The Registry object and the carry, as the main Worker reaches them. */
export type McpSignInManageObjects = {
  readonly registry: () => ManageRegistry;
  readonly carry: McpSignInCarry;
  readonly stage: McpSignInStageView;
};

/** The client's reads and sign-out of the MCP sign-ins. Each answers a value, never fails. */
export type McpSignInManage = {
  readonly list: () => Effect.Effect<McpSignInsView>;
  readonly signOut: (hash: string) => Effect.Effect<McpSignOutView>;
};

const isOn = (value: string | boolean | undefined): boolean => value === true || value === "true";

/**
 * The stage the form names: its label (absent on `prod`), `alchemy dev`, whether the document is in the ladder, and the
 * app origin a live stage starts sign-ins on. Under `alchemy dev` it has no origin: the page's own is the one (the redirect
 * URI follows the origin the sign-in started on).
 */
export const signInStageView = (env: SignInEnv): McpSignInStageView => {
  const local = isOn(env[LOCAL_MODE_VAR]);
  const label = env[STAGE_LABEL_VAR];
  const origin = env[APP_ORIGIN_VAR];

  const stage: Types.Mutable<McpSignInStageView> = {
    local,
    documentEnabled: !local && isOn(env[MCP_CLIENT_DOCUMENT_VAR]),
  };

  if (label !== undefined && label !== "") stage.label = label;

  if (!local && origin !== undefined && origin !== "") stage.origin = origin;

  return stage;
};

const unavailable = (message: string) => McpUnavailable.make({ message });

/** The sign-in reads and the sign-out over `objects`. */
export const mcpSignInManage = (objects: McpSignInManageObjects): McpSignInManage => ({
  list: () =>
    objects
      .registry()
      .listMcpSignIns()
      .pipe(
        Effect.map((listing): McpSignInsView => ({ ...listing, stage: objects.stage })),
        Effect.catchCause((cause) =>
          Effect.logWarning("The MCP sign-ins could not be listed", cause).pipe(
            Effect.as<McpSignInsView>(unavailable("cloudpid could not reach its store")),
          ),
        ),
      ),
  signOut: (hash) =>
    objects
      .registry()
      .signOutMcpSignIn({ hash })
      .pipe(
        // The hosts that use the sign-in are told after the delete, so they close the server's sessions and end its
        // watches at once; one that is not reached heals at its next `windowOpened`.
        Effect.tap((answer) =>
          Predicate.isTagged(answer, "SignedOut")
            ? objects.carry.carry({
                change: "signed_out",
                server: answer.server,
                environments: answer.environments,
                revision: answer.revision,
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("An MCP sign-out could not be confirmed", cause).pipe(
            Effect.as<McpSignOutView>(
              unavailable("cloudpid could not confirm the sign-out: look at the sign-ins again"),
            ),
          ),
        ),
      ),
});
