// What the owner does with the MCP sign-ins from Settings (`docs/architecture/mcp-sign-in.md` → Sign-out, Settings): the
// list the server rows' chips and the Sign-ins list are made from (`listMcpSignIns`), and Sign out (`signOutMcpSignIn`):
// RFC 7009 revocation of the refresh token then the access token (best effort, 5 s each, a failure is reported), then the
// row and its pending start are deleted, keeping the registration and the binding. The Registry never calls out to a host:
// the answer names the Environments that used the sign-in and the new revision, and the main Worker carries `signed_out` to
// their hosts (`mcp/sign-in-carry.ts`).
//
// No answer holds a token, a client secret or a URL but its host: a row is named by its key's hash, its server's normalized
// name, its source and its URL's host. A revocation's note says the kind of token and a status, an OAuth code or the kind
// of failure, never a token.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import type { McpResolvedServer } from "@cloudpid/config";
import { revokeTokens } from "@cloudpid/mcp/oauth";
import { MCP_SIGN_IN_GLOBAL, type McpSignInEnvironment } from "@cloudpid/mcp/types";
import {
  type McpLapsedStart,
  McpNoSignIn,
  type McpRevocationView,
  McpSignedOut,
  McpSignInsListing,
  type McpSignInView,
  McpSignOutChanged,
  McpSignOutNotApplicable,
  type McpSignOutView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { outcomeOf, sameSealed } from "./mcp-sign-in-backoff.ts";
import {
  clientInformation,
  decodeContext,
  type FlowDeps,
  hostOf,
  metadataOf,
  serversOf,
  usesSignIn,
} from "./mcp-sign-in-flow.ts";
import { clip, signInTargetOf, told } from "./mcp-sign-in-registry.ts";
import { openTokens } from "./mcp-sign-in-seal.ts";
import type { McpSignInRecord } from "./mcp-sign-ins.ts";

type Kind = "owner" | "client_grant";

/** Who uses a sign-in, by the kind of entry (a row's own kind is the one that counts for it). */
type Users = {
  readonly owner: ReadonlyArray<McpSignInEnvironment>;
  readonly client_grant: ReadonlyArray<McpSignInEnvironment>;
  /** Global's own layers use it (a start at Global), whichever Environment follows them. */
  readonly global: Record<Kind, boolean>;
};

/** Every sign-in's users, in one pass over the sets (Global's and each Environment's). */
const usersOfAll = (deps: FlowDeps): ReadonlyMap<string, Users> => {
  const collected = new Map<
    string,
    {
      owner: Array<McpSignInEnvironment>;
      client_grant: Array<McpSignInEnvironment>;
      global: Record<Kind, boolean>;
    }
  >();

  const entryOf = (hash: string) => {
    const held = collected.get(hash) ?? {
      owner: [],
      client_grant: [],
      global: { owner: false, client_grant: false },
    };

    collected.set(hash, held);

    return held;
  };

  const visit = (
    servers: ReadonlyArray<McpResolvedServer> | null,
    use: (hash: string, kind: Kind) => void,
  ) => {
    for (const resolved of servers ?? []) {
      const target = signInTargetOf(resolved);

      if (target.status === "target") use(target.key.hash, "owner");

      if (target.status === "client_grant") use(target.key.hash, "client_grant");
    }
  };

  visit(serversOf(deps.store, MCP_SIGN_IN_GLOBAL), (hash, kind) => {
    entryOf(hash).global[kind] = true;
  });

  for (const { id, name } of deps.store.listEnvironments()) {
    const seen = new Set<string>();

    visit(serversOf(deps.store, id), (hash, kind) => {
      const key = `${hash}:${kind}`;

      if (seen.has(key)) return;

      seen.add(key);
      entryOf(hash)[kind].push({ id, name });
    });
  }

  return collected;
};

const NO_USERS: Users = {
  owner: [],
  client_grant: [],
  global: { owner: false, client_grant: false },
};

/** The kind of entry a sign-in row is used as: a client grant's row by entries that sign in on their own, any other by the owner's. */
const kindOf = (record: McpSignInRecord): Kind =>
  record.client?.kind === "client_grant" ? "client_grant" : "owner";

const viewOf = (record: McpSignInRecord, users: Users): McpSignInView => {
  const kind = kindOf(record);
  const environments = users[kind];

  return {
    hash: record.key.hash,
    server: record.key.name,
    source: record.key.source,
    urlHost: hostOf(record.key.url),
    issuerHost: record.issuer === null ? null : hostOf(record.issuer),
    kind: record.client?.kind ?? null,
    status: record.status,
    scope: record.scope,
    wantedScope: record.wantedScope,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    refreshedAt: record.refreshedAt,
    usedAt: record.usedAt,
    lastError: record.lastError,
    lastErrorAt: record.lastErrorAt,
    hasTokens: record.hasTokens,
    environments,
    unused: environments.length === 0 && !users.global[kind],
  };
};

/**
 * The document-client starts that expired without a callback (→ Settings, a refused document client): the authorization
 * server shows a refusal on its own page and cannot redirect back, so only the lapse says it. A start still waiting for the
 * owner's Continue on the issuer interstitial never reached the authorization server and is not one.
 */
const lapsedStarts = (deps: FlowDeps, now: number): ReadonlyArray<McpLapsedStart> =>
  Arr.filterMap(deps.signIns.listPending(), (pending) => {
    const context = decodeContext(pending.client);

    return pending.expiresAt <= now &&
      !pending.awaitingConfirmation &&
      Option.exists(context, ({ client }) => client.kind === "document")
      ? Result.succeed({
          hash: pending.keyHash,
          issuerHost: hostOf(pending.issuer),
          at: pending.createdAt,
        })
      : Result.failVoid;
  });

/**
 * Every sign-in with who uses it, the most recently used first, and the document starts that lapsed. `sealing` says why
 * the tokens cannot be opened (a malformed `SECRETS_ENCRYPTION_KEY`), which also refuses new starts.
 */
export const listMcpSignIns = (deps: FlowDeps, now: number): Effect.Effect<McpSignInsListing> =>
  Effect.gen(function* () {
    const users = usersOfAll(deps);
    const vault = yield* deps.vault.pipe(Effect.result);

    const listing = McpSignInsListing.make({
      revision: deps.signIns.revision(),
      signIns: Arr.map(deps.signIns.list(), (record) =>
        viewOf(record, users.get(record.key.hash) ?? NO_USERS),
      ),
      lapsedStarts: lapsedStarts(deps, now),
    });

    return Result.isFailure(vault) ? { ...listing, sealing: told(vault.failure.message) } : listing;
  });

/** What revoking came to, as the owner is told it. */
type Revoked = { readonly view: McpRevocationView; readonly outcome: string };

const notRevoked = (note: string): Revoked => ({
  view: { status: "not_attempted", note },
  outcome: "not_revoked",
});

/**
 * The entry that uses sign-in `hash` as an owner's (an Environment's first, else Global's own), for the secret of a
 * configured client to be read from the entry as it is now.
 */
const userOf = (
  deps: FlowDeps,
  hash: string,
): { readonly environment: string; readonly server: string } | undefined => {
  for (const id of [
    MCP_SIGN_IN_GLOBAL,
    ...Arr.map(deps.store.listEnvironments(), ({ id: each }) => each),
  ]) {
    const found = Arr.findFirst(serversOf(deps.store, id) ?? [], (resolved) =>
      usesSignIn(resolved, hash, "owner"),
    );

    if (Option.isSome(found)) return { environment: id, server: found.value.name };
  }

  return undefined;
};

/** RFC 7009 for the owner's row `row`: the refresh token, then the access token, at the endpoint its metadata recorded. */
const revokeRow = (
  deps: FlowDeps,
  row: NonNullable<ReturnType<FlowDeps["signIns"]["get"]>>,
): Effect.Effect<Revoked> =>
  Effect.gen(function* () {
    const { client, sealed } = row;
    const hash = row.key.hash;

    if (sealed === null || client === null) return notRevoked("There were no tokens to revoke");

    const vault = yield* deps.vault.pipe(Effect.result);

    if (Result.isFailure(vault)) {
      return notRevoked("The tokens could not be opened, so they were not revoked");
    }

    const opened = yield* openTokens(vault.success, hash, sealed).pipe(Effect.result);
    const metadata = row.metadata === null ? Option.none() : metadataOf(row.metadata);

    if (Result.isFailure(opened) || Option.isNone(metadata)) {
      return notRevoked(
        "The tokens or the authorization server's metadata could not be read, so they were not revoked",
      );
    }

    yield* Effect.annotateCurrentSpan({ "mcp.issuer_host": hostOf(metadata.value.issuer) });

    // The client as it signed in; a confidential one whose secret does not resolve revokes as a public client, which the
    // server may refuse (and the note then says so).
    const user = userOf(deps, hash);

    const info =
      user === undefined
        ? { client_id: client.id }
        : yield* clientInformation(deps, vault.success, user.environment, {
            server: user.server,
            client,
          }).pipe(Effect.orElseSucceed(() => ({ client_id: client.id })));

    const revoked = yield* Effect.promise(() =>
      revokeTokens({
        metadata: metadata.value,
        client: info,
        refreshToken: opened.success.refresh_token,
        accessToken: opened.success.access_token,
        fetch: deps.fetch,
      }),
    );

    if (revoked === undefined)
      return { view: { status: "no_endpoint" }, outcome: "no_revocation_endpoint" };

    const failed = Arr.filter(revoked, (each) => each.status === "failed");

    if (failed.length === 0) return { view: { status: "revoked" }, outcome: "revoked" };

    return {
      view: {
        status: "failed",
        note: told(
          `The authorization server did not revoke its ${Arr.join(
            Arr.map(
              failed,
              (each) =>
                `${each.token.replace("_", " ")} (${each.status === "failed" ? clip(each.reason, 80) : ""})`,
            ),
            " and ",
          )}`,
        ),
      },
      outcome: "revocation_failed",
    };
  });

/**
 * Sign out of the sign-in `hash` (→ Sign-out): the server's revocation, then the delete. A client grant that an entry still
 * uses has nothing to sign out of (`NotApplicable`: its host's `failed` state is its error and the Registry mends it by
 * retrying); an unused one is only deleted, its short-lived token not revoked. A sign-in made while the revocation was in
 * flight is kept (`Changed`), as a refresh's write is guarded.
 */
export const signOutMcpSignIn = (
  deps: FlowDeps,
  hash: string,
  now: number,
): Effect.Effect<McpSignOutView> =>
  Effect.gen(function* () {
    const row = deps.signIns.get(hash);

    if (row === null) return McpNoSignIn.make({});

    const kind = kindOf(row);
    const users = usersOfAll(deps).get(hash) ?? NO_USERS;

    if (kind === "client_grant" && users.client_grant.length > 0) {
      return McpSignOutNotApplicable.make({
        message:
          "This server signs in on its own with client credentials: there is no sign-in to sign out of",
      });
    }

    const environments = users[kind];

    yield* Effect.annotateCurrentSpan({
      "mcp.server": row.key.name,
      "mcp.source_kind": row.key.source.startsWith("repo:") ? "repo" : "owner",
      "mcp.client_kind": row.client?.kind ?? "none",
      "mcp.trigger": "sign_out",
    });

    const revoked =
      kind === "client_grant"
        ? notRevoked("A client grant's short-lived token is not revoked")
        : yield* revokeRow(deps, row);

    yield* outcomeOf(revoked.outcome);

    // Nothing is awaited between this check and the delete.
    const now2 = deps.signIns.get(hash);

    if (now2 === null) return McpNoSignIn.make({});

    if (!sameSealed(now2.sealed, row.sealed) || now2.grantId !== row.grantId) {
      return McpSignOutChanged.make({
        message:
          "A new sign-in was made while this one was being signed out of: it was kept. Sign out again if you meant it.",
      });
    }

    deps.signIns.delete(hash, now);

    return McpSignedOut.make({
      server: row.key.name,
      revision: deps.signIns.revision(),
      revocation: revoked.view,
      environments,
    });
  }).pipe(Effect.withSpan("mcp.oauth.revoke"));
