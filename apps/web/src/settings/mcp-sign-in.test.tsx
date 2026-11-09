// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off globalJsonInEffect:off globalDate:off globalDateInEffect:off -- in-memory fakes of the Registry over native arrays, and fixtures written as JSON text.

// What the MCP servers section shows and does of the owner's MCP sign-ins (docs/architecture/mcp-sign-in.md → Settings,
// Sign-out): the chips, the Sign in and Sign out controls, the "Signs in on its own" row, the Sign-ins list at Global, the
// Sign out dialog and what a sign-out says, and the Sign-in (OAuth) disclosure of the form. Rendered with
// `react-dom/server` over the fake Registry, whose answers are settled first.

import {
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  mcpSignInKey,
  resolveLeniently,
} from "@cloudpid/config";
import {
  EnvironmentRecord,
  McpServersList,
  McpSignInsListing,
  McpSignedOut,
  type McpSignInView,
  type McpSignOutView,
  McpRepoFiles,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import {
  environmentSecretsAtom,
  environmentSettingsAtom,
  environmentsAtom,
  globalSettingsAtom,
} from "../environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import { settingsAtom, settingsOverridesAtom } from "../settings.ts";
import { McpSection } from "./mcp.tsx";
import { newMcpForm } from "./mcp-form.ts";
import { mcpScopeView } from "./mcp-model.ts";
import { mcpSignInsAtom, mcpSignOutOpenAtom, signOutMcpAtom } from "./mcp-sign-in-state.ts";
import { mcpPanelAtom, mcpServersAtom, mcpRepoFilesQueryAtom } from "./mcp-state.ts";

const WORK: EnvironmentRecord = { id: "work", name: "Work", repos: [], createdAt: 1 };

const DOCUMENT: Schema.Json = {
  mcp: {
    servers: {
      sentry: { url: "https://mcp.sentry.dev/mcp" },
      service: {
        url: "https://mcp.service.dev/mcp",
        oauth: {
          grantType: "client_credentials",
          clientId: "svc",
          clientSecret: "${SVC_SECRET}",
          issuer: "https://auth.service.dev",
        },
      },
      header: { url: "https://mcp.header.dev/mcp", headers: { Authorization: "Bearer ${T}" } },
      files: { command: "npx", args: ["-y", "@mcp/files"] },
    },
  },
};

const GLOBAL_ROWS = mcpScopeView({
  scope: "*",
  global: DOCUMENT,
  globalProblem: undefined,
  overrides: null,
  overridesProblem: undefined,
  offered: [],
  overriddenIn: {},
}).rows;

const hashOf = (name: string): string => {
  const row = GLOBAL_ROWS.find((held) => held.name === name);

  return (row === undefined ? undefined : mcpSignInKey(row)?.hash) ?? "";
};

const view = (name: string, more: Partial<McpSignInView> = {}): McpSignInView => ({
  hash: hashOf(name),
  server: name,
  source: "owner",
  urlHost: `mcp.${name}.dev`,
  issuerHost: "auth.example.com",
  kind: "document",
  status: "ok",
  scope: "read write",
  wantedScope: null,
  expiresAt: null,
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

interface Held {
  readonly signIns?: ReadonlyArray<McpSignInView>;
  /** The state each server's host reports at the Environment. */
  readonly host?: Readonly<Record<string, string>>;
  readonly signOut?: McpSignOutView;
  readonly signedOut?: Array<string>;
  readonly stage?: { readonly local: boolean; readonly origin?: string; readonly label?: string };
}

const handlersFor = (held: Held = {}): Partial<RegistryHandlers> => ({
  listSessions: () => Effect.succeed([]),
  listEnvironments: () => Effect.succeed([WORK]),
  mcpRepoFiles: () => Effect.succeed(McpRepoFiles.make({ files: [] })),
  mcpServers: () =>
    Effect.succeed(
      McpServersList.make({
        version: "1",
        servers: Object.entries(held.host ?? {}).map(([name, state]) => ({
          name,
          source: { kind: "global" },
          state,
          counts: { tools: 0, prompts: 0 },
          resources: false,
          problems: [],
          tools: [],
          prompts: [],
        })),
      }),
    ),
  mcpSignIns: () =>
    Effect.succeed({
      ...McpSignInsListing.make({
        revision: 1,
        // A sign-out the Registry did is gone from the list it answers next.
        signIns: (held.signIns ?? []).filter(({ hash }) => !(held.signedOut ?? []).includes(hash)),
        lapsedStarts: [],
      }),
      stage: { documentEnabled: true, ...(held.stage ?? { local: false }) },
    }),
  signOutMcpSignIn: ({ hash }) =>
    Effect.sync(() => {
      held.signedOut?.push(hash);

      return (
        held.signOut ??
        McpSignedOut.make({
          server: "sentry",
          revision: 2,
          issuerHost: "auth.example.com",
          revocation: { status: "revoked" },
          environments: [{ id: "work", name: "Work" }],
        })
      );
    }),
  listEnvironmentSecrets: () => Effect.succeed([]),
  getSettings: () =>
    Effect.succeed({ settings: DEFAULT_SETTINGS, overrides: DOCUMENT, overriddenIn: {} }),
  getSettingsOverrides: ({ environment }) =>
    Effect.succeed({
      environment,
      settings: DEFAULT_SETTINGS,
      global: { ...DEFAULT_SETTINGS, mcp: resolveLeniently(DOCUMENT).settings.mcp },
      overrides: {},
      instructions: "",
    }),
  getEnvironmentSettings: () =>
    Effect.succeed({
      settings: DEFAULT_CONTAINER_SETTINGS,
      global: DEFAULT_CONTAINER_SETTINGS,
      overrides: {},
    }),
  getGlobalContainerSettings: () =>
    Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
});

const settle = (
  registry: AtomRegistry.AtomRegistry,
  atoms: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>,
) =>
  Effect.forEach(atoms, (atom) => {
    registry.mount(atom);

    return settled(registry, atom);
  });

const settledRegistry = (scope: string, held: Held) =>
  Effect.gen(function* () {
    const registry = registryWith(handlersFor(held));

    yield* settle(registry, [
      environmentsAtom,
      settingsAtom,
      environmentSecretsAtom,
      mcpSignInsAtom,
      ...(scope === "*"
        ? [globalSettingsAtom]
        : [
            settingsOverridesAtom(scope),
            environmentSettingsAtom(scope),
            mcpServersAtom(scope),
            mcpRepoFilesQueryAtom(scope),
          ]),
    ]);

    return registry;
  });

const markupOf = (registry: AtomRegistry.AtomRegistry, scope: string): string =>
  renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <McpSection scope={scope} />
    </RegistryContext.Provider>,
  );

const render = (
  scope: string,
  held: Held = {},
  before?: (registry: AtomRegistry.AtomRegistry) => void,
) =>
  Effect.gen(function* () {
    const registry = yield* settledRegistry(scope, held);

    before?.(registry);

    const markup = markupOf(registry, scope);

    registry.dispose();

    return markup;
  });

const rowOf = (markup: string, name: string): string => {
  const start = markup.indexOf(`id="mcp-server-${name}"`);

  expect(start, `a row for ${name}`).toBeGreaterThan(-1);

  const next = markup.indexOf('<li id="mcp-server-', start + 1);
  const group = markup.indexOf("</section>", start);

  return markup.slice(start, next === -1 ? group : Math.min(next, group));
};

const textOf = (markup: string): string =>
  markup
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .replaceAll(" ,", ",")
    .trim();

describe("a server's row", () => {
  it.effect("shows nothing of sign-in on a server that has not asked for one", () =>
    Effect.gen(function* () {
      const row = rowOf(yield* render("*"), "sentry");

      expect(textOf(row)).not.toContain("Needs sign-in");
      expect(row).not.toContain("/oauth/mcp/start");
    }),
  );

  it.effect(
    "says a sign-in is needed once the Registry has noted it, and links to start it in a new tab",
    () =>
      Effect.gen(function* () {
        const row = rowOf(
          yield* render("*", {
            signIns: [view("sentry", { status: "required", hasTokens: false })],
          }),
          "sentry",
        );

        expect(textOf(row)).toContain("Needs sign-in");
        expect(row).toContain(
          'href="/oauth/mcp/start?environment=all&amp;server=sentry&amp;return=%2Fsettings%2Fall%2Fmcp"',
        );
        expect(row).toContain('target="_blank"');
        expect(row).toContain('rel="noopener"');
        expect(row).toContain('aria-label="Sign in to sentry (opens in a new tab)"');
        expect(row).not.toContain("Sign out of");
      }),
  );

  it.effect("names the issuer on a signed-in server, and offers Sign in again and Sign out", () =>
    Effect.gen(function* () {
      const row = rowOf(yield* render("*", { signIns: [view("sentry")] }), "sentry");

      expect(textOf(row)).toContain("Signed in · auth.example.com");
      expect(row).toContain('aria-label="Sign in again to sentry (opens in a new tab)"');
      expect(row).toContain('aria-label="Sign out of sentry"');
    }),
  );

  it.effect(
    "has no sign-in parts on a server with its own Authorization header or on a stdio one",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", { signIns: [view("sentry")] });

        for (const name of ["header", "files"]) {
          expect(rowOf(markup, name)).not.toContain("Sign in");
        }
      }),
  );

  it.effect(
    "starts a sign-in from an Environment on that Environment, when its host waits for one",
    () =>
      Effect.gen(function* () {
        const row = rowOf(yield* render("work", { host: { sentry: "sign_in" } }), "sentry");

        expect(textOf(row)).toContain("Needs sign-in");
        expect(row).toContain("environment=work");
        expect(row).toContain("return=%2Fsettings%2Fwork%2Fmcp");
      }),
  );
});

describe("the Sign-ins list", () => {
  it.effect(
    "lists each sign-in at Global with who uses it, and Sign out where there is something to sign out of",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", {
          signIns: [
            view("sentry"),
            view("service", { kind: "client_grant" }),
            view("gone", { hash: "orphan", unused: true, environments: [] }),
          ],
        });

        const at = markup.indexOf('id="sign-ins"');

        expect(at).toBeGreaterThan(-1);

        const list = markup.slice(at);

        expect(textOf(list)).toContain("Used by Work");
        expect(textOf(list)).toContain("Unused");
        expect(textOf(list)).toContain("Used by no environment");
        expect(list).toContain("Sign out of sentry (mcp.sentry.dev)");
        expect(list).toContain("Sign out of gone (mcp.gone.dev)");
        // A client grant an entry still uses signs in on its own.
        expect(list).not.toContain("Sign out of service");
      }),
  );

  it.effect("is not at an Environment", () =>
    Effect.gen(function* () {
      expect(yield* render("work", { signIns: [view("sentry")] })).not.toContain('id="sign-ins"');
    }),
  );

  it.effect("says when there are none", () =>
    Effect.gen(function* () {
      expect(textOf(yield* render("*"))).toContain("No MCP sign-ins yet.");
    }),
  );
});

describe("signing out", () => {
  it.effect("asks first, saying who it affects and that the registration stays", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { signIns: [view("sentry")] }, (registry) => {
        registry.set(mcpSignOutOpenAtom("*"), {
          hash: hashOf("sentry"),
          returnTo: "sign-ins-heading",
        });
      });

      expect(textOf(markup)).toContain("Sign out of sentry?");
      expect(textOf(markup)).toContain("Used by Work: their sessions close sentry's connection");
      expect(textOf(markup)).toContain("auth.example.com is asked to revoke the tokens first");
      // The status region is there before the answer, empty, so that the answer is announced when it comes.
      expect(markup).toMatch(/<div role="status"[^>]*><\/div>/);
    }),
  );

  it.effect("asks the Registry for it by the sign-in's hash, and says what the server did", () =>
    Effect.gen(function* () {
      const signedOut: Array<string> = [];
      const registry = yield* settledRegistry("*", { signIns: [view("sentry")], signedOut });

      registry.mount(signOutMcpAtom("*"));
      registry.set(mcpSignOutOpenAtom("*"), {
        hash: hashOf("sentry"),
        returnTo: "sign-ins-heading",
      });
      registry.set(signOutMcpAtom("*"), hashOf("sentry"));
      yield* settled(registry, signOutMcpAtom("*"));

      expect(signedOut).toEqual([hashOf("sentry")]);

      const text = textOf(markupOf(registry, "*"));

      expect(text).toContain("Signed out of sentry.");
      expect(text).toContain("auth.example.com revoked the tokens.");
      registry.dispose();
    }),
  );

  it.effect("says plainly when the server refused or has no revocation", () =>
    Effect.gen(function* () {
      const said = (status: string, note?: string) =>
        Effect.gen(function* () {
          const registry = yield* settledRegistry("*", {
            signIns: [view("sentry")],
            signOut: McpSignedOut.make({
              server: "sentry",
              revision: 2,
              issuerHost: "auth.example.com",
              revocation: note === undefined ? { status } : { status, note },
              environments: [],
            }),
          });

          registry.mount(signOutMcpAtom("*"));
          registry.set(mcpSignOutOpenAtom("*"), {
            hash: hashOf("sentry"),
            returnTo: "sign-ins-heading",
          });
          registry.set(signOutMcpAtom("*"), hashOf("sentry"));
          yield* settled(registry, signOutMcpAtom("*"));

          const text = textOf(markupOf(registry, "*"));

          registry.dispose();

          return text;
        });

      expect(yield* said("no_endpoint")).toContain("does not offer revocation");
      expect(yield* said("failed", "The refresh token was refused (400)")).toContain(
        "The refresh token was refused (400). The sign-out went through, but the grant may still stand there",
      );
      // A status a later build adds reads as a failure: the grant may still stand.
      expect(yield* said("from-a-later-build")).toContain(
        "did not revoke the tokens. The sign-out went through, but the grant may still stand there",
      );
      expect(yield* said("not_attempted", "There were no tokens to revoke")).toContain(
        "There were no tokens to revoke.",
      );
    }),
  );
});

describe("the Sign-in (OAuth) disclosure", () => {
  const ENTRY = { type: "http", url: "https://mcp.sentry.dev/mcp" } satisfies Schema.JsonObject;

  const panel = (oauth: Schema.Json) => newMcpForm("edit", "sentry", { ...ENTRY, oauth });

  const stage = { local: false, origin: "https://pr-9.example", label: "pr-9" };

  it.effect("shows the redirect URI and client name of the stage with Copy", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { stage }, (registry) => {
        registry.set(mcpPanelAtom("*"), newMcpForm("edit", "sentry", ENTRY));
      });

      expect(markup).toContain("Sign-in (OAuth)");
      expect(markup).toContain("https://pr-9.example/oauth/mcp/callback");
      expect(markup).toContain("Copy redirect uri");
      expect(markup).toContain("Copy client name");
    }),
  );

  it.effect(
    "sends no client name while a client id is set, and shows fields as written, never a value",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", { stage }, (registry) => {
          registry.set(
            mcpPanelAtom("*"),
            panel({ clientId: "mine", clientSecret: "${SECRET_NAME}" }),
          );
        });

        expect(markup).toContain("Copy redirect uri");
        expect(markup).not.toContain("Copy client name");
        expect(textOf(markup)).toContain("No client name is sent while a client id is set.");
        expect(markup).toContain('value="mine"');
        expect(markup).toContain('value="${SECRET_NAME}"');
      }),
  );

  it.effect("has no redirect URI for client credentials, which sign in on their own", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { stage }, (registry) => {
        registry.set(
          mcpPanelAtom("*"),
          panel({
            grantType: "client_credentials",
            clientId: "svc",
            clientSecret: "${SVC_SECRET}",
            issuer: "https://auth.service.dev",
          }),
        );
      });

      expect(markup).not.toContain("Copy redirect uri");
      expect(textOf(markup)).toContain("It signs in on its own");
    }),
  );
});
