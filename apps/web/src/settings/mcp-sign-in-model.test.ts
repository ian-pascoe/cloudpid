// @effect-diagnostics preferEffectArray:off -- fixtures looked up in native arrays.

// What a server's row says of its MCP sign-in (docs/architecture/mcp-sign-in.md → Settings; Client Credentials): the chip for
// each status, the controls, the "Signs in on its own" row, the refused-document-client hint, the start link, and the
// redirect URI and client name the disclosure shows.
import { mcpSignInKey } from "@cloudpid/config";
import {
  McpSignInsListing,
  type McpLapsedStart,
  type McpSignInsList,
  type McpSignInView,
} from "@cloudpid/protocol";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  mcpSignInApplies,
  mcpSignInLine,
  mcpSignInNames,
  mcpSignInStartHref,
  type McpSignInsState,
  refusedDocumentHint,
} from "./mcp-sign-in-model.ts";
import { type McpRow, mcpScopeView } from "./mcp-model.ts";

const DOCUMENT: Schema.Json = {
  mcp: {
    servers: {
      sentry: { url: "https://mcp.sentry.dev/mcp" },
      pinned: {
        url: "https://mcp.pinned.dev/mcp",
        oauth: { clientId: "mine", clientRegistration: "dcr" },
      },
      service: {
        url: "https://mcp.service.dev/mcp",
        oauth: {
          grantType: "client_credentials",
          clientId: "svc",
          clientSecret: "${SVC_SECRET}",
          issuer: "https://auth.service.dev",
        },
      },
      bare: {
        url: "https://mcp.bare.dev/mcp",
        oauth: {
          grantType: "client_credentials",
          clientId: "svc",
          clientSecret: "${SVC_SECRET}",
          authServerMetadataUrl: "https://auth.bare.dev/.well-known/oauth-authorization-server",
        },
      },
      header: { url: "https://mcp.header.dev/mcp", headers: { authorization: "Bearer ${T}" } },
      files: { command: "npx", args: ["-y", "@mcp/files"] },
    },
  },
};

const rows = mcpScopeView({
  scope: "*",
  global: DOCUMENT,
  globalProblem: undefined,
  overrides: null,
  overridesProblem: undefined,
  offered: [],
  overriddenIn: {},
}).rows;

const rowOf = (name: string): McpRow => {
  const found = rows.find((row) => row.name === name);

  if (found === undefined) throw new Error(`No row ${name}`);

  return found;
};

const hashOf = (name: string): string => mcpSignInKey(rowOf(name))?.hash ?? "";

const view = (name: string, more: Partial<McpSignInView> = {}): McpSignInView => ({
  hash: hashOf(name),
  server: name,
  source: "owner",
  urlHost: "mcp.example.dev",
  issuerHost: "auth.example.com",
  kind: "document",
  status: "ok",
  scope: "read",
  wantedScope: null,
  expiresAt: 5_000,
  createdAt: 1_000,
  refreshedAt: null,
  usedAt: 2_000,
  lastError: null,
  lastErrorAt: null,
  hasTokens: true,
  environments: [{ id: "work", name: "Work" }],
  unused: false,
  ...more,
});

const ready = (
  signIns: ReadonlyArray<McpSignInView>,
  more: { sealing?: string; lapsedStarts?: ReadonlyArray<McpLapsedStart> } = {},
): McpSignInsState => {
  const listing = McpSignInsListing.make({
    revision: 3,
    signIns,
    lapsedStarts: more.lapsedStarts ?? [],
  });

  const list: McpSignInsList = {
    ...(more.sealing === undefined ? listing : { ...listing, sealing: more.sealing }),
    stage: { local: false, documentEnabled: true, label: "pr-9", origin: "https://pr-9.example" },
  };

  return { status: "ready", list };
};

describe("which rows have a sign-in", () => {
  it("is every HTTP server without its own Authorization header, whatever the case of the header", () => {
    expect(mcpSignInApplies(rowOf("sentry"))).toBe(true);
    expect(mcpSignInApplies(rowOf("service"))).toBe(true);
    expect(mcpSignInApplies(rowOf("header"))).toBe(false);
    expect(mcpSignInApplies(rowOf("files"))).toBe(false);
    expect(mcpSignInLine(rowOf("files"), ready([]))).toBeNull();
    expect(mcpSignInLine(rowOf("header"), ready([]))).toBeNull();
  });

  it("says nothing while the sign-ins are still being asked", () => {
    expect(mcpSignInLine(rowOf("sentry"), { status: "loading" })).toBeNull();
  });
});

describe("a row's state chip", () => {
  const line = (more: Partial<McpSignInView>, name = "sentry") =>
    mcpSignInLine(rowOf(name), ready([view(name, more)]));

  it("says nothing of a server that has not asked for a sign-in: OAuth begins with a 401", () => {
    expect(mcpSignInLine(rowOf("sentry"), ready([]))).toMatchObject({
      chip: null,
      problem: null,
      actions: { signIn: null, stepUp: false, signOut: null },
      hash: hashOf("sentry"),
    });
    expect(mcpSignInLine(rowOf("sentry"), ready([]), "connected")?.chip).toBeNull();
    expect(mcpSignInLine(rowOf("sentry"), ready([]), "failed")?.actions.signIn).toBeNull();
  });

  it("needs a sign-in when its host is waiting for one or was refused, with Sign in and nothing to sign out of", () => {
    for (const waiting of ["sign_in", "rejected"]) {
      expect(mcpSignInLine(rowOf("sentry"), ready([]), waiting)).toMatchObject({
        chip: { label: "Needs sign-in", tone: "attention" },
        problem: null,
        actions: { signIn: "Sign in", stepUp: false, signOut: null },
        hash: hashOf("sentry"),
      });
    }
  });

  it("is signed in at the issuer's host, with Sign in again and Sign out", () => {
    expect(line({})).toMatchObject({
      chip: { label: "Signed in · auth.example.com", tone: "ok" },
      actions: { signIn: "Sign in again", stepUp: false, signOut: hashOf("sentry") },
    });
    expect(line({ issuerHost: null })?.chip?.label).toBe("Signed in");
  });

  it("says more access was requested, and signs in again for the wanted scope", () => {
    expect(line({ status: "step_up", wantedScope: "read write" })).toMatchObject({
      chip: { label: "More access requested", tone: "attention" },
      notes: ["It asks for: read write"],
      actions: { signIn: "Sign in again", stepUp: true, signOut: hashOf("sentry") },
    });
  });

  it("says the server refused its sign-in, with the last problem", () => {
    expect(line({ status: "rejected", lastError: "invalid_token (expired)" })).toMatchObject({
      chip: { label: "Refused its sign-in", tone: "problem" },
      problem: "invalid_token (expired)",
    });
  });

  it("says why it can't refresh", () => {
    expect(line({ status: "refresh_failing", lastError: "HTTP 503" })?.chip).toEqual({
      label: "Can't refresh: HTTP 503",
      tone: "problem",
    });
  });

  it("needs a sign-in again when its tokens were dropped, with the reason, and nothing to sign out of", () => {
    expect(
      line({ status: "required", hasTokens: false, lastError: "invalid_grant" }),
    ).toMatchObject({
      chip: { label: "Needs sign-in", tone: "attention" },
      problem: "invalid_grant",
      actions: { signIn: "Sign in", signOut: null },
    });
  });

  it("reads a status it does not know as one, with Sign in again", () => {
    expect(line({ status: "from-a-later-build" })).toMatchObject({
      chip: { label: "Sign-in state unknown", tone: "quiet" },
      actions: { signIn: "Sign in again" },
    });
  });

  it("can't open sign-ins when the Registry could not be read, or cannot open its tokens, and offers no start", () => {
    expect(
      mcpSignInLine(rowOf("sentry"), {
        status: "failed",
        problem: "cloudpid could not reach its store",
      }),
    ).toMatchObject({
      chip: { label: "Can't open sign-ins", tone: "problem" },
      problem: "cloudpid could not reach its store",
      actions: { signIn: null, signOut: null },
    });
    expect(
      mcpSignInLine(rowOf("sentry"), ready([view("sentry")], { sealing: "The key is malformed." })),
    ).toMatchObject({
      chip: { label: "Can't open sign-ins" },
      actions: { signIn: null, signOut: null },
    });
  });
});

describe("a server that signs in on its own", () => {
  it("says so with the issuer's host and has nothing to press, before it has a sign-in", () => {
    expect(mcpSignInLine(rowOf("service"), ready([]))).toMatchObject({
      chip: { label: "Signs in on its own · auth.service.dev", tone: "quiet" },
      problem: null,
      actions: { signIn: null, stepUp: false, signOut: null },
    });
  });

  it("takes the host from the metadata URL when the entry pins that, and has no host without a pin's", () => {
    expect(mcpSignInLine(rowOf("bare"), ready([]))?.chip?.label).toBe(
      "Signs in on its own · auth.bare.dev",
    );
  });

  it("shows the Registry's last problem and still offers no Sign in, Sign in again or Sign out", () => {
    const grant = mcpSignInLine(
      rowOf("service"),
      ready([
        view("service", {
          kind: "client_grant",
          status: "ok",
          lastError: "invalid_client (no such client)",
        }),
      ]),
    );

    expect(grant).toMatchObject({
      chip: { tone: "problem" },
      problem: "invalid_client (no such client)",
      actions: { signIn: null, signOut: null },
    });
    expect(grant?.chip?.label).toBe("Signs in on its own · auth.service.dev");
  });

  it("has no row of its own while the sign-ins cannot be read, but says why", () => {
    expect(
      mcpSignInLine(rowOf("service"), { status: "failed", problem: "down" })?.chip?.label,
    ).toBe("Can't open sign-ins");
  });
});

describe("the refused document client", () => {
  const lapsed: McpLapsedStart = {
    hash: "",
    issuerHost: "auth.example.com",
    at: 1,
  };

  it("is said when a document start expired without a callback", () => {
    const state = ready([], { lapsedStarts: [{ ...lapsed, hash: hashOf("sentry") }] });

    expect(mcpSignInLine(rowOf("sentry"), state)?.hint).toBe(
      "If auth.example.com showed an error about the client, set Client registration to DCR.",
    );
    expect(refusedDocumentHint("auth.example.com")).toContain("set Client registration to DCR");
  });

  it("is not said for another server, nor once the entry registers (DCR) or names its own client", () => {
    const state = ready([], {
      lapsedStarts: [
        { ...lapsed, hash: hashOf("sentry") },
        { ...lapsed, hash: hashOf("pinned") },
      ],
    });

    expect(mcpSignInLine(rowOf("pinned"), state)?.hint).toBeNull();
    expect(mcpSignInLine(rowOf("sentry"), ready([], { lapsedStarts: [] }))?.hint).toBeNull();
  });
});

describe("the start link", () => {
  it("names the Environment and the server, and comes back to the section", () => {
    expect(
      mcpSignInStartHref({
        scope: "work",
        global: "*",
        server: "sentry",
        stepUp: false,
        returnPath: "/settings/work/mcp",
      }),
    ).toBe("/oauth/mcp/start?environment=work&server=sentry&return=%2Fsettings%2Fwork%2Fmcp");
  });

  it("calls Global `all`, and asks for a step-up", () => {
    expect(
      mcpSignInStartHref({
        scope: "*",
        global: "*",
        server: "sentry",
        stepUp: true,
        returnPath: "/settings/all/mcp",
      }),
    ).toBe(
      "/oauth/mcp/start?environment=all&server=sentry&step_up=1&return=%2Fsettings%2Fall%2Fmcp",
    );
  });
});

describe("the redirect URI and client name", () => {
  const stage = {
    local: false,
    documentEnabled: true,
    label: "pr-9",
    origin: "https://pr-9.example",
  };

  const none = { clientId: "", clientName: "", grantType: "authorization_code" };

  it("gives a live stage's redirect URI and the name it registers as", () => {
    expect(mcpSignInNames(stage, "http://localhost:5173", none)).toEqual({
      redirectUri: "https://pr-9.example/oauth/mcp/callback",
      clientName: "cloudpid (pr-9)",
    });
  });

  it("is plain `cloudpid` on prod, and adds the label to a configured name off prod", () => {
    expect(
      mcpSignInNames({ local: false, documentEnabled: true }, "https://pi.ianpascoe.dev", none)
        .clientName,
    ).toBe("cloudpid");
    expect(mcpSignInNames(stage, undefined, { ...none, clientName: "Acme Agent" }).clientName).toBe(
      "Acme Agent (pr-9)",
    );
  });

  it("follows the page's origin under alchemy dev, with `local` in the name", () => {
    expect(
      mcpSignInNames(
        { local: true, documentEnabled: false, label: "dev_ian" },
        "http://localhost:5173",
        none,
      ),
    ).toEqual({
      redirectUri: "http://localhost:5173/oauth/mcp/callback",
      clientName: "cloudpid (dev_ian, local)",
    });
  });

  it("sends no name when the entry names its own client, or signs in on its own", () => {
    expect(mcpSignInNames(stage, undefined, { ...none, clientId: "mine" }).clientName).toBeNull();
    expect(
      mcpSignInNames(stage, undefined, { ...none, grantType: "client_credentials" }).clientName,
    ).toBeNull();
  });

  it("has no redirect URI while it knows no origin", () => {
    expect(mcpSignInNames(undefined, undefined, none)).toEqual({
      redirectUri: null,
      clientName: null,
    });
  });
});

describe("the start link of a Sign-in request's card", () => {
  it("names the Session and the request, and comes back to the Session", () => {
    expect(
      mcpSignInStartHref({
        scope: "work",
        global: "*",
        server: "sentry",
        stepUp: false,
        returnPath: "/sessions/s1",
        requester: { session: "s1", request: "signin-2" },
      }),
    ).toBe(
      "/oauth/mcp/start?environment=work&server=sentry&session=s1&request=signin-2&return=%2Fsessions%2Fs1",
    );
  });

  it("asks for a step-up", () => {
    expect(
      mcpSignInStartHref({
        scope: "work",
        global: "*",
        server: "sentry",
        stepUp: true,
        returnPath: "/sessions/s1",
        requester: { session: "s1", request: "signin-2" },
      }),
    ).toContain("&step_up=1&return=");
  });
});
