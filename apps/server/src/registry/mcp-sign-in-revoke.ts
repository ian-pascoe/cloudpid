// RFC 7009 for an owner's sign-in whose tokens are being dropped (`docs/architecture/mcp-sign-in.md` → Sign-out; Client
// Credentials, a switch from an authorization code): the refresh token, then the access token, at the endpoint the row's
// metadata recorded, as the client the sign-in was made with. Best effort and told, never failing what dropped the tokens.
// Both callers (Sign out in Settings, and an entry that starts signing in on its own) share it, so they revoke alike.
//
// Nothing here holds a token in an answer: what failed is the kind of token and a status, an OAuth code or the kind of failure.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { revokeTokens } from "@cloudpid/mcp/oauth";
import type { KeptVault } from "@cloudpid/extensions/secrets/core";
import { MCP_SIGN_IN_GLOBAL } from "@cloudpid/mcp/types";
import type { McpRevocationView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { clientInformation, type FlowDeps, hostOf, metadataOf } from "./mcp-sign-in-flow.ts";
import { clip, told } from "./mcp-sign-in-registry.ts";
import { openTokens } from "./mcp-sign-in-seal.ts";
import type { McpSignInRow } from "./mcp-sign-ins.ts";

/** What revoking came to: as the owner is told it, the outcome for the span, and the tokens the server refused. */
export type Revoked = {
  readonly view: McpRevocationView;
  readonly outcome: "revoked" | "no_revocation_endpoint" | "revocation_failed" | "not_revoked";
  /** "refresh token (invalid_client) and access token (…)": what the server refused, when it did. */
  readonly refused: string | undefined;
};

/** Why nothing was asked of the authorization server. */
export const notRevoked = (note: string): Revoked => ({
  view: { status: "not_attempted", note },
  outcome: "not_revoked",
  refused: undefined,
});

/** The entry that uses the sign-in as an owner's: its Environment (or Global's own) and name, which a configured client's secret is read through. */
export type RevokeUser = { readonly environment: string; readonly server: string };

/**
 * The client as it signed in, and whether it had to be asked as a public client for want of its secret:
 *  - a registered (DCR) client has its secret in the registration;
 *  - a configured client reads its secret from the entry as it is now, and, with no entry left (the sign-in is unused),
 *    from the Secret or Variable the row recorded (`secretRef`), read in the Environment it resolved in (Global's for a row
 *    from before that was recorded); a literal secret (a Repo's file) is not recorded, so it is asked as a public client;
 *  - a document client has none.
 * A secret that cannot be resolved is a public client, which the server may refuse.
 */
const informationOf = (
  deps: FlowDeps,
  vault: KeptVault,
  row: McpSignInRow & { readonly client: NonNullable<McpSignInRow["client"]> },
  user: RevokeUser | undefined,
): Effect.Effect<{
  readonly info: { readonly client_id: string; readonly client_secret?: string };
  readonly asPublic: boolean;
}> =>
  Effect.gen(function* () {
    const { client } = row;
    const publicClient = { info: { client_id: client.id }, asPublic: true };

    if (client.kind === "configured" && user === undefined) {
      const ref = client.secretRef;

      if (ref === null) return publicClient;

      const sources = yield* deps
        .sources(ref.environment ?? MCP_SIGN_IN_GLOBAL, ref.scope === "secret")
        .pipe(Effect.result);

      const value = Result.isFailure(sources)
        ? Option.none<string>()
        : Record.get(
            ref.scope === "secret" ? sources.success.secrets : sources.success.variables,
            ref.name,
          );

      return Option.isSome(value)
        ? { info: { client_id: client.id, client_secret: value.value }, asPublic: false }
        : publicClient;
    }

    const found = yield* clientInformation(deps, vault, user?.environment ?? MCP_SIGN_IN_GLOBAL, {
      server: user?.server ?? row.key.name,
      client,
    }).pipe(Effect.result);

    return Result.isSuccess(found) ? { info: found.success, asPublic: false } : publicClient;
  });

/** RFC 7009 for the owner's row `row` (the refresh token, then the access token): see the header. */
export const revokeOwnerRow = (
  deps: FlowDeps,
  row: McpSignInRow,
  user: RevokeUser | undefined,
): Effect.Effect<Revoked> =>
  Effect.gen(function* () {
    const { client, sealed } = row;

    if (sealed === null || client === null) return notRevoked("There were no tokens to revoke");

    const vault = yield* deps.vault.pipe(Effect.result);

    if (Result.isFailure(vault)) {
      return notRevoked("The tokens could not be opened, so they were not revoked");
    }

    const opened = yield* openTokens(vault.success, row.key.hash, sealed).pipe(Effect.result);
    const metadata = row.metadata === null ? Option.none() : metadataOf(row.metadata);

    if (Result.isFailure(opened) || Option.isNone(metadata)) {
      return notRevoked(
        "The tokens or the authorization server's metadata could not be read, so they were not revoked",
      );
    }

    yield* Effect.annotateCurrentSpan({ "mcp.issuer_host": hostOf(metadata.value.issuer) });

    const { info, asPublic } = yield* informationOf(deps, vault.success, { ...row, client }, user);

    const revoked = yield* Effect.promise(() =>
      revokeTokens({
        metadata: metadata.value,
        client: info,
        refreshToken: opened.success.refresh_token,
        accessToken: opened.success.access_token,
        fetch: deps.fetch,
      }),
    );

    if (revoked === undefined) {
      return {
        view: { status: "no_endpoint" },
        outcome: "no_revocation_endpoint",
        refused: undefined,
      };
    }

    const failed = Arr.filter(revoked, (each) => each.status === "failed");

    if (failed.length === 0)
      return { view: { status: "revoked" }, outcome: "revoked", refused: undefined };

    const refused = Arr.join(
      Arr.map(
        failed,
        (each) =>
          `${each.token.replace("_", " ")} (${each.status === "failed" ? clip(each.reason, 80) : ""})`,
      ),
      " and ",
    );

    return {
      view: {
        status: "failed",
        note: told(
          `The authorization server did not revoke its ${refused}${
            asPublic
              ? "; it was asked as a public client (no secret of the client's could be read), which the server may refuse"
              : ""
          }`,
        ),
      },
      outcome: "revocation_failed",
      refused,
    };
  });
