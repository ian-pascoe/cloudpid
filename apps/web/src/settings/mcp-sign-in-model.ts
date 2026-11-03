// @effect-diagnostics missingPipeableSignature:off -- builders of plain values, not combinators.

// What the MCP servers section shows of the owner's MCP sign-ins (docs/architecture/mcp-sign-in.md → Settings; the "Signs
// in on its own" row of Client Credentials): the state chip, the last problem, the refused-document-client hint and the
// controls of an HTTP server's row, and the redirect URI and client name the Sign-in (OAuth) disclosure shows. Pure: the
// row, the Sign-ins list and the tests read these. Nothing here holds a token, a secret or a URL beyond a host: what the
// Registry's `mcpSignIns` answers has none.
//
// As built: a row is matched to its sign-in by the key's hash (`mcpSignInKey` of `@cloudpid/config`, the Registry's own
// function over the same resolved entry), so the page and the Registry agree on which sign-in a row is.

import {
  type McpOauth,
  mcpClientGrantRow,
  mcpClientNameFor,
  mcpSignInKey,
  mcpSignInNotApplicable,
  signsInOnItsOwn,
} from "@cloudpid/config";
import {
  type McpLapsedStart,
  type McpSignInsList,
  type McpSignInStageView,
  type McpSignInView,
  readMcpSignInStatus,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { McpRow } from "./mcp-model.ts";

/** What the page knows of the sign-ins: still asking, why it could not read them, or the list. */
export type McpSignInsState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly problem: string }
  | { readonly status: "ready"; readonly list: McpSignInsList };

/** How a chip reads: a sign-in that works, one that wants the owner, one that is broken, or quiet text. */
export type McpSignInTone = "ok" | "attention" | "problem" | "quiet";

/** The controls a row offers: Sign in, Sign in again (a step-up asks for more access), and Sign out. */
export type McpSignInActions = {
  /** The start link's label, or null for none. */
  readonly signIn: "Sign in" | "Sign in again" | null;
  /** The link asks for the wanted scope of a sign-in that is already there. */
  readonly stepUp: boolean;
  /** The sign-in's hash for Sign out, or null when there are no tokens to sign out of. */
  readonly signOut: string | null;
};

/** What an HTTP server's row says of its sign-in. */
export type McpSignInLine = {
  /** The state chip, or null when the row has nothing to say: a server that has not asked for a sign-in. */
  readonly chip: { readonly label: string; readonly tone: McpSignInTone } | null;
  /** The last problem (at most 300 characters, the Registry's), or null. */
  readonly problem: string | null;
  /** Other words under the chip: the scope a step-up wants. */
  readonly notes: ReadonlyArray<string>;
  /** The refused-document-client hint, or null. */
  readonly hint: string | null;
  readonly actions: McpSignInActions;
  /** The sign-in's hash, or null when the key could not be made. */
  readonly hash: string | null;
};

const NO_ACTIONS: McpSignInActions = { signIn: null, stepUp: false, signOut: null };

/** Whether `row` is a server that signs in with OAuth at all: HTTP, and sends no `Authorization` header of its own. */
export const mcpSignInApplies = (row: McpRow): boolean =>
  mcpSignInNotApplicable(row.server) === undefined;

/** The sign-in of `row` in `list`, by the key's hash. */
export const mcpSignInOf = (
  row: McpRow,
  list: McpSignInsList,
): { readonly hash: string; readonly view: McpSignInView | undefined } | undefined => {
  const key = mcpSignInKey(row);

  return key === undefined
    ? undefined
    : {
        hash: key.hash,
        view: Arr.findFirst(list.signIns, ({ hash }) => hash === key.hash).pipe(
          Option.getOrUndefined,
        ),
      };
};

/** The hint under a document client whose start expired without a callback (→ Starting and completing a sign-in, A refused document client). */
export const refusedDocumentHint = (issuerHost: string): string =>
  `If ${issuerHost} showed an error about the client, set Client registration to DCR.`;

const hintFor = (row: McpRow, lapsed: McpLapsedStart | undefined): string | null => {
  const oauth = row.server.type === "http" ? row.server.oauth : undefined;

  // A configured client, or one the entry already registers, is not a document client.
  if (
    lapsed === undefined ||
    oauth?.clientId !== undefined ||
    oauth?.clientRegistration === "dcr"
  ) {
    return null;
  }

  return refusedDocumentHint(lapsed.issuerHost);
};

const withIssuer = (label: string, host: string | null): string =>
  host === null ? label : `${label} · ${host}`;

/**
 * What `row` says of its sign-in, given what the page knows of the sign-ins; null for a row that has none (a stdio server,
 * or one with its own `Authorization` header). A server that signs in on its own has its row from `@cloudpid/config`
 * ("Signs in on its own · <issuer host>", no actions) and the Registry's last problem; any other reads its status from the
 * sign-in list. A server with no sign-in there has not asked for one (OAuth begins with a 401): it shows no chip and no Sign
 * in, unless its host says it is waiting for a sign-in or was refused (`hostState`, at an Environment), and a sign-in is
 * then offered. A row at Global has no host: it shows its sign-in once a host has met a 401 and the Registry has noted it.
 */
export const mcpSignInLine = (
  row: McpRow,
  state: McpSignInsState,
  hostState?: string,
): McpSignInLine | null => {
  if (!mcpSignInApplies(row)) return null;

  const key = mcpSignInKey(row);
  const hash = key?.hash ?? null;
  const oauth: McpOauth | undefined = row.server.type === "http" ? row.server.oauth : undefined;

  const grant =
    signsInOnItsOwn(row.server) && oauth !== undefined ? mcpClientGrantRow(oauth) : null;

  if (state.status === "loading") return null;

  if (state.status === "failed") {
    return {
      chip: { label: "Can't open sign-ins", tone: "problem" },
      problem: state.problem,
      notes: [],
      hint: null,
      actions: NO_ACTIONS,
      hash,
    };
  }

  const { list } = state;
  const found = mcpSignInOf(row, list);
  const view = found?.view;

  if (grant !== null) {
    // The host's `failed` state is the grant's error and the Registry mends it by retrying: nothing to press.
    const problem = view?.lastError ?? null;

    return {
      chip: { label: grant.text, tone: problem === null ? "quiet" : "problem" },
      problem,
      notes: [],
      hint: null,
      actions: NO_ACTIONS,
      hash,
    };
  }

  if (list.sealing !== undefined) {
    return {
      chip: { label: "Can't open sign-ins", tone: "problem" },
      problem: `${list.sealing} Sign-ins stay unavailable until the encryption key is fixed.`,
      notes: [],
      hint: null,
      actions: NO_ACTIONS,
      hash,
    };
  }

  const lapsed =
    hash === null
      ? undefined
      : Arr.findFirst(list.lapsedStarts, (start) => start.hash === hash).pipe(
          Option.getOrUndefined,
        );

  const hint = hintFor(row, lapsed);

  if (view === undefined) {
    const waiting = hostState === "sign_in" || hostState === "rejected";

    return {
      chip: waiting ? { label: "Needs sign-in", tone: "attention" } : null,
      problem: null,
      notes: [],
      hint,
      actions: waiting ? { signIn: "Sign in", stepUp: false, signOut: null } : NO_ACTIONS,
      hash,
    };
  }

  const signOut = view.hasTokens ? view.hash : null;
  const again: McpSignInActions = { signIn: "Sign in again", stepUp: false, signOut };

  switch (readMcpSignInStatus(view.status)) {
    case "ok":
      return {
        chip: { label: withIssuer("Signed in", view.issuerHost), tone: "ok" },
        problem: null,
        notes: [],
        hint,
        actions: again,
        hash,
      };
    case "step_up":
      return {
        chip: { label: "More access requested", tone: "attention" },
        problem: view.lastError,
        notes: view.wantedScope === null ? [] : [`It asks for: ${view.wantedScope}`],
        hint,
        actions: { ...again, stepUp: true },
        hash,
      };
    case "rejected":
      return {
        chip: { label: "Refused its sign-in", tone: "problem" },
        problem: view.lastError,
        notes: [],
        hint,
        actions: again,
        hash,
      };
    case "refresh_failing":
      return {
        chip: {
          label: `Can't refresh: ${view.lastError ?? "the authorization server did not answer"}`,
          tone: "problem",
        },
        problem: null,
        notes: [],
        hint,
        actions: again,
        hash,
      };
    case "required":
      return {
        chip: { label: "Needs sign-in", tone: "attention" },
        problem: view.lastError,
        notes: [],
        hint,
        actions: { signIn: view.hasTokens ? "Sign in again" : "Sign in", stepUp: false, signOut },
        hash,
      };
    case "unknown":
      return {
        chip: { label: "Sign-in state unknown", tone: "quiet" },
        problem: view.lastError,
        notes: [],
        hint,
        actions: again,
        hash,
      };
  }
};

/** The link a row's Sign in (or Sign in again, or a step-up) opens, in a new tab (→ Starting and completing a sign-in, The link). */
export const mcpSignInStartHref = (input: {
  /** The Scope: an Environment's id, or Global's `*`, which the start calls `all`. */
  readonly scope: string;
  readonly global: string;
  readonly server: string;
  readonly stepUp: boolean;
  /** Where Back goes: the section's own path. */
  readonly returnPath: string;
}): string => {
  const query = new URLSearchParams({
    environment: input.scope === input.global ? "all" : input.scope,
    server: input.server,
  });

  if (input.stepUp) query.set("step_up", "1");

  query.set("return", input.returnPath);

  return `/oauth/mcp/start?${query.toString()}`;
};

/**
 * The link a Sign-in request's card opens, in a new tab (`docs/architecture/mcp-sign-in.md` → Sign-in requests): the start
 * link of the request's server in its Environment, naming the Session and the request, so the callback tells the Session
 * which request the sign-in answered, and Back returns to the Session's page.
 */
export const mcpSignInRequestHref = (input: {
  readonly environment: string;
  readonly server: string;
  readonly session: string;
  readonly request: string;
  readonly stepUp: boolean;
  readonly returnPath: string;
}): string => {
  const query = new URLSearchParams({ environment: input.environment, server: input.server });

  query.set("session", input.session);
  query.set("request", input.request);

  if (input.stepUp) query.set("step_up", "1");

  query.set("return", input.returnPath);

  return `/oauth/mcp/start?${query.toString()}`;
};

/** The path of the callback under `origin` (→ The client document and the callback outside Access). */
export const mcpRedirectUri = (origin: string): string => `${origin}/oauth/mcp/callback`;

/** What the disclosure says of the redirect URI and the client name. */
export type McpSignInNames = {
  /** The stage's redirect URI, or null when the page has no origin to say. */
  readonly redirectUri: string | null;
  /** The client name that will be registered; null when no registration happens (a configured client id, or a client grant). */
  readonly clientName: string | null;
};

/**
 * The redirect URI of the stage and the client name that will actually be registered, from what the form holds. A live stage's
 * origin is the Worker's own; under `alchemy dev` it is the page's (`pageOrigin`), which the Worker's redirect URI follows.
 * The client name is cloudpid's own on prod and `cloudpid (<label>)` elsewhere, and a configured name gets the suffix off
 * prod too; none is sent when the entry names its own client id or signs in on its own.
 */
export const mcpSignInNames = (
  stage: McpSignInStageView | undefined,
  pageOrigin: string | undefined,
  fields: { readonly clientId: string; readonly clientName: string; readonly grantType: string },
): McpSignInNames => {
  const origin = stage?.origin ?? pageOrigin;
  const registers = fields.clientId.trim() === "" && fields.grantType !== "client_credentials";

  return {
    redirectUri: origin === undefined ? null : mcpRedirectUri(origin),
    clientName:
      !registers || stage === undefined
        ? null
        : mcpClientNameFor(
            { label: stage.label, local: stage.local },
            fields.clientName.trim() === "" ? undefined : fields.clientName.trim(),
          ),
  };
};
