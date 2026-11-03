// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off -- in-memory fakes of the Registry over native arrays, provided to each test, and fixtures written as JSON text.

// The MCP servers section of the Settings page at a Scope, rendered with `react-dom/server` over the fake Registry: the
// queries a page reads are settled first, so the markup shows what they answered. The changes the owner's actions make
// are run against the same fake, which records what it was asked to save.

import {
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  type McpSettingsProblem,
  resolveLeniently,
  type Settings,
} from "@cloudpid/config";
import {
  type EnvironmentRecord,
  type EnvironmentSecretRecord,
  McpNoEnvironment,
  type McpRepoFileView,
  McpRepoFiles,
  McpServersList,
  McpSignInsListing,
  type McpServerView,
  McpUnavailable,
  type OverridingEnvironment,
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
import {
  fakeRegistryLayer,
  type RegistryHandlers,
  registryWith,
  settled,
} from "../registry.testing.ts";
import { settingsAtom, settingsOverridesAtom } from "../settings.ts";
import { McpSection } from "./mcp.tsx";
import { mcpSignInsAtom } from "./mcp-sign-in-state.ts";
import { emptyMcpFields, mcpCopyForm, newMcpForm, toolsDraftOf } from "./mcp-form.ts";
import { mcpScopeView } from "./mcp-model.ts";
import {
  changeMcpAtom,
  type McpPanel,
  mcpPanelAtom,
  mcpRepoFilesQueryAtom,
  mcpServersAtom,
  reloadMcpRepoAtom,
  writeMcpChange,
} from "./mcp-state.ts";
import {
  mcpRepoRowChanges,
  mcpRepoToolExposure,
  mcpRepoToolsChange,
  mcpRowChanges,
} from "./mcp-write.ts";

const WORK: EnvironmentRecord = { id: "work", name: "Work", repos: [], createdAt: 1 };
const HOME: EnvironmentRecord = { id: "home", name: "Home", repos: [], createdAt: 2 };
const OVERRIDING_WORK: OverridingEnvironment = { id: "work", name: "Work" };

const GLOBAL_DOCUMENT: Schema.Json = {
  mcp: {
    servers: {
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        description: "Issues and projects",
      },
      files: { command: "npx", args: ["-y", "@mcp/files"], enabled: false },
      search: {
        url: "https://search.example.com/mcp",
        exposure: "direct",
        toolExposure: { "delete_*": "hidden" },
      },
    },
  },
};

const WORK_OVERRIDES: Schema.Json = {
  mcp: {
    servers: {
      linear: { enabled: false },
      search: { url: "https://search.work.example.com/mcp" },
      notes: { command: "notes-mcp", description: "The team's notes" },
      gone: { exposure: "hidden" },
    },
  },
};

const settingsOffering = (offered: ReadonlyArray<string>): Settings => ({
  ...DEFAULT_SETTINGS,
  tools: { offered },
});

const SECRETS: ReadonlyArray<EnvironmentSecretRecord> = [
  { environment: null, name: "LINEAR_TOKEN", build: false, updatedAt: 1 },
  { environment: "work", name: "NOTES_KEY", build: false, updatedAt: 1 },
];

const server = (name: string, state: string, more: Partial<McpServerView> = {}): McpServerView => ({
  name,
  source: { kind: "global" },
  state,
  counts: { tools: 2, prompts: 0 },
  resources: false,
  problems: [],
  tools: [
    { name: "search_issues", exposure: "codemode" },
    { name: "delete_issue", exposure: "codemode" },
  ],
  prompts: [],
  ...more,
});

interface Held {
  readonly offered?: ReadonlyArray<string>;
  readonly globalProblem?: string;
  readonly secrets?: ReadonlyArray<EnvironmentSecretRecord>;
  /** What the Registry says of the Environment's saved Overrides that no longer apply. */
  readonly overridesProblem?: {
    readonly text: string;
    readonly mcp: ReadonlyArray<McpSettingsProblem>;
  };
  readonly servers?: ReadonlyArray<McpServerView>;
  /** The Repos' files the Registry holds; the Environment then has a Repo `app`. */
  readonly repoFiles?: ReadonlyArray<McpRepoFileView>;
  /** The Environment's own Variables. */
  readonly variables?: Readonly<Record<string, string>>;
}

/** The Registry's handlers: Global's servers and Work's Overrides, with the fixtures above. */
const handlersFor = (held: Held = {}): Partial<RegistryHandlers> => {
  const settings = settingsOffering(held.offered ?? DEFAULT_SETTINGS.tools.offered);

  return {
    listSessions: () => Effect.succeed([]),
    listEnvironments: () =>
      Effect.succeed([
        held.repoFiles === undefined
          ? WORK
          : { ...WORK, repos: [{ name: "app", url: "https://github.com/acme/app" }] },
        HOME,
      ]),
    mcpRepoFiles: () => Effect.succeed(McpRepoFiles.make({ files: held.repoFiles ?? [] })),
    // No sign-ins: the sign-in parts of a row are `mcp-sign-in.test.tsx`'s.
    mcpSignIns: () =>
      Effect.succeed({
        ...McpSignInsListing.make({ revision: 0, signIns: [], lapsedStarts: [] }),
        stage: { local: false, documentEnabled: true },
      }),
    listEnvironmentSecrets: () => Effect.succeed(held.secrets ?? SECRETS),
    getSettings: () => {
      const state = {
        settings,
        overrides: GLOBAL_DOCUMENT,
        overriddenIn: {
          "mcp.servers.linear.enabled": [OVERRIDING_WORK],
          "mcp.servers.linear.toolExposure": [OVERRIDING_WORK, { id: "home", name: "Home" }],
          "mcp.servers.search": [OVERRIDING_WORK],
        },
      };

      return Effect.succeed(
        held.globalProblem === undefined ? state : { ...state, problem: held.globalProblem },
      );
    },
    getSettingsOverrides: ({ environment }) => {
      const state = {
        environment,
        settings,
        // Global as the Registry resolves its document: the servers a row of this Environment may adjust.
        global: { ...settings, mcp: resolveLeniently(GLOBAL_DOCUMENT).settings.mcp },
        overrides: WORK_OVERRIDES,
        instructions: "",
      };

      return Effect.succeed(
        held.overridesProblem === undefined
          ? state
          : {
              ...state,
              problem: held.overridesProblem.text,
              mcpProblems: held.overridesProblem.mcp,
            },
      );
    },
    getEnvironmentSettings: () =>
      Effect.succeed({
        settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: held.variables ?? {} },
        global: DEFAULT_CONTAINER_SETTINGS,
        overrides: {},
      }),
    getGlobalContainerSettings: () =>
      Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
    mcpServers: () =>
      Effect.succeed(
        McpServersList.make({
          version: "1",
          servers: held.servers ?? [
            server("files", "connected"),
            server("linear", "sign_in"),
            server("notes", "failed", {
              error: "spawn notes-mcp ENOENT",
              source: { kind: "environment" },
            }),
          ],
        }),
      ),
  };
};

/** Settle each of `atoms` in `registry`, keeping it mounted so the render reads its answer. */
const settle = (
  registry: AtomRegistry.AtomRegistry,
  atoms: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>,
) =>
  Effect.forEach(atoms, (atom) => {
    registry.mount(atom);

    return settled(registry, atom);
  });

/** The section at `scope`, once what it reads has answered; `panel` is what the owner has open above the list. */
const render = (
  scope: string,
  {
    panel,
    handlers = {},
    held,
    pending = [],
  }: {
    panel?: McpPanel;
    handlers?: Partial<RegistryHandlers>;
    held?: Held;
    /** Atoms left unanswered, as they are while the page is still asking. */
    pending?: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>;
  } = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({ ...handlersFor(held), ...handlers });

    if (panel !== undefined) registry.set(mcpPanelAtom(scope), panel);

    yield* settle(
      registry,
      [
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
      ].filter((atom) => !pending.includes(atom)),
    );

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <McpSection scope={scope} />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

/** The markup of server `name`'s row. */
const rowOf = (markup: string, name: string): string => {
  const start = markup.indexOf(`id="mcp-server-${name}"`);

  expect(start, `a row for ${name}`).toBeGreaterThan(-1);

  const next = markup.indexOf('<li id="mcp-server-', start + 1);
  const group = markup.indexOf("</section>", start);

  return markup.slice(start, next === -1 ? group : Math.min(next, group));
};

/** The text of `markup`, tags gone, whitespace single. */
const textOf = (markup: string): string =>
  markup
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .replaceAll(" ,", ",")
    .trim();

/** The text under the Problems heading, which is empty where there is none. */
const underProblems = (markup: string): string => {
  const at = markup.indexOf(">Problems<");

  return at === -1 ? "" : textOf(markup.slice(at));
};

/** The names of the rows, in order. */
const rowNames = (markup: string): ReadonlyArray<string> =>
  Array.from(markup.matchAll(/id="mcp-server-([^"]+)"/g), ([, name = ""]) => name);

describe("the MCP servers section at Global", () => {
  it.effect("lists each server by name with its transport, target, source and description", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(markup).toContain(">MCP servers</h1>");
      expect(rowNames(markup)).toEqual(["files", "linear", "search"]);

      const linear = textOf(rowOf(markup, "linear"));

      expect(linear).toContain("linear HTTP Global");
      expect(linear).toContain("https://mcp.linear.app/mcp");
      expect(linear).toContain("Issues and projects");
      expect(textOf(rowOf(markup, "files"))).toContain("files stdio Global npx -y @mcp/files");
    }),
  );

  it.effect("gives each an enabled switch and an Exposure select showing what is in force", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(rowOf(markup, "files")).toMatch(/aria-label="files enabled"(?![^>]*checked)/);
      expect(rowOf(markup, "linear")).toMatch(/aria-label="linear enabled"[^>]*checked/);
      expect(rowOf(markup, "search")).toMatch(/<option value="direct" selected/);
      expect(rowOf(markup, "linear")).toMatch(/<option value="codemode" selected/);
      expect(textOf(rowOf(markup, "search"))).toContain("1 tool exposure key");
    }),
  );

  it.effect("says in how many environments each is overridden, linking to each one's section", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(textOf(rowOf(markup, "linear"))).toContain("Overridden in 2 environments: Work, Home");
      expect(rowOf(markup, "linear")).toContain('href="/settings/work/mcp"');
      expect(textOf(rowOf(markup, "search"))).toContain("Overridden in 1 environment: Work");
      expect(textOf(rowOf(markup, "files"))).not.toContain("Overridden");
    }),
  );

  it.effect("has no inherited or overridden marks, and no status: Global has no host", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(markup).not.toContain("Inherited");
      expect(markup).not.toContain("Reset");
      expect(markup).not.toContain("Connected");
    }),
  );

  it.effect("offers Add and the import", () =>
    Effect.gen(function* () {
      const markup = yield* render("*");

      expect(textOf(markup)).toContain("Add server");
      expect(textOf(markup)).toContain("Import pi JSON…");
    }),
  );

  it.effect("shows a saved entry that no longer applies as a problem naming Global", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", {
        held: {
          globalProblem:
            "These saved overrides no longer apply and are ignored:\nmcp.servers.linear.exposure: Expected one of codemode",
        },
      });

      expect(textOf(rowOf(markup, "linear"))).toContain(
        "Global: is not used and is forgotten by the next save: exposure: Expected one of codemode",
      );
      expect(textOf(rowOf(markup, "linear"))).not.toContain("Issues and projects");
    }),
  );
});

describe("the warning that codemode is not offered", () => {
  it.effect("names the servers with codemode Exposure when the offered tools lack it", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { held: { offered: ["read", "tool_search"] } });
      const text = textOf(markup);

      // `files` is switched off, and `search` has direct Exposure: only `linear` is reached through codemode.
      expect(text).toContain("linear has codemode Exposure");
      expect(text).not.toContain("files has");
      expect(text).not.toContain("search has");
      expect(markup).toContain('href="/settings/all/tools"');
    }),
  );

  it.effect("is not shown when codemode is offered, and is the Scope's own at an Environment", () =>
    Effect.gen(function* () {
      expect(textOf(yield* render("*"))).not.toContain("have codemode Exposure");
      expect(textOf(yield* render("work", { held: { offered: ["read"] } }))).toContain(
        "search, notes have codemode Exposure",
      );
    }),
  );
});

describe("the MCP servers section at an Environment", () => {
  it.effect("lists Global's servers and its own together, by name", () =>
    Effect.gen(function* () {
      expect(rowNames(yield* render("work"))).toEqual(["files", "linear", "notes", "search"]);
    }),
  );

  it.effect("marks a Global server it does not touch as inherited on each of its three keys", () =>
    Effect.gen(function* () {
      const files = rowOf(yield* render("work"), "files");
      const text = textOf(files);

      expect(text).toContain("files stdio From Global");
      expect(text).toContain("Enabled Inherited Exposure Inherited Tool exposure (0) Inherited");
      expect(text).not.toContain("Overridden");
      expect(text).not.toContain("Reset");
      expect(files).toContain(">Tool exposure…</button>");
      expect(files).toContain(">Use its own copy…</button>");
      expect(files).toContain(">Edit at Global</a>");
    }),
  );

  it.effect(
    "marks a Global server it adjusts as overridden on that key, with its Reset, and shows the adjusted value",
    () =>
      Effect.gen(function* () {
        const linear = rowOf(yield* render("work"), "linear");

        expect(textOf(linear)).toContain("Enabled Overridden Reset to Global Exposure Inherited");
        expect(linear).toContain('aria-label="Reset linear enabled to Global"');
        expect(linear).not.toContain('aria-label="Reset linear exposure to Global"');
        expect(linear).toMatch(/aria-label="linear enabled"(?![^>]*checked)/);
      }),
  );

  it.effect("shows its own server as its own: Edit and Remove, no inherited marks", () =>
    Effect.gen(function* () {
      const notes = rowOf(yield* render("work"), "notes");

      expect(textOf(notes)).toContain("notes stdio This environment");
      expect(textOf(notes)).toContain("The team's notes");
      expect(notes).toContain(">Edit</button>");
      expect(notes).toContain('aria-label="Remove notes"');
      expect(notes).not.toContain("Inherited");
      expect(notes).not.toContain("Use its own copy");
    }),
  );

  it.effect("shows its own server that replaces Global's of the name, and says so", () =>
    Effect.gen(function* () {
      const search = rowOf(yield* render("work"), "search");

      expect(textOf(search)).toContain("This environment · replaces Global's");
      expect(textOf(search)).toContain("https://search.work.example.com/mcp");
      expect(textOf(search)).toContain("removing it falls back to Global's");
      expect(search).not.toContain("Overridden in");
    }),
  );

  it.effect("shows the status of each server from the host's answer", () =>
    Effect.gen(function* () {
      const markup = yield* render("work");

      expect(textOf(rowOf(markup, "files"))).toContain("Connected · 2 tools");
      expect(textOf(rowOf(markup, "linear"))).toContain("Needs sign-in");
      expect(textOf(rowOf(markup, "notes"))).toContain("Failed: spawn notes-mcp ENOENT");
      expect(textOf(rowOf(markup, "search"))).not.toContain("Connected");
    }),
  );

  it.effect("says so once when the host did not answer, and shows the rows without status", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        handlers: { mcpServers: () => Effect.succeed(McpUnavailable.make({ message: "no host" })) },
      });

      expect(textOf(markup)).toContain("Connection status is unavailable: no host");
      expect(rowNames(markup)).toHaveLength(4);
    }),
  );

  it.effect("shows no status when the Environment is not listed by the host", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        handlers: { mcpServers: () => Effect.succeed(McpNoEnvironment.make({})) },
      });

      expect(markup).not.toContain("Connected");
      expect(markup).not.toContain("unavailable");
    }),
  );

  it.effect("shows an adjustment with no server as a problem naming its source, with Reset", () =>
    Effect.gen(function* () {
      const markup = yield* render("work");
      const problems = markup.slice(markup.indexOf('<section aria-label="Problems"'));

      expect(textOf(problems)).toContain(
        "gone this environment: adjusts a server that no layer defines any more: reset it Reset",
      );
    }),
  );

  it.effect("shows an adjustment held over the entry bound on its server's row, with Reset", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          overridesProblem: {
            text: "These saved Overrides no longer apply and are ignored, so their fields inherit Global:\nmcp.servers.files.toolExposure: makes the entry over 64 KiB once applied over the server it adjusts",
            mcp: [
              {
                source: "environment",
                name: "files",
                keys: ["toolExposure"],
                message: "makes the entry over 64 KiB once applied over the server it adjusts",
                reset: ["mcp.servers.files.toolExposure"],
              },
            ],
          },
        },
      });

      const files = rowOf(markup, "files");

      expect(textOf(files)).toContain(
        "this environment: is not used and is forgotten by the next save: toolExposure: makes the entry over 64 KiB",
      );
      expect(files).toContain('aria-label="Reset mcp.servers.files.toolExposure"');
    }),
  );

  it.effect(
    "shows a Global server left out for a twin name as Global's, not as a forgotten Override",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          held: {
            overridesProblem: {
              text: 'These saved Overrides no longer apply and are ignored, so their fields inherit Global:\nmcp.servers.gone2: is left out: this Environment\'s own "Gone2" is a name that differs only in case',
              mcp: [
                {
                  source: "global",
                  name: "gone2",
                  keys: [],
                  message:
                    'is left out: this Environment\'s own "Gone2" is a name that differs only in case',
                  reset: [],
                },
              ],
            },
          },
        });

        const problems = textOf(markup.slice(markup.indexOf('<section aria-label="Problems"')));

        expect(problems).toContain("gone2 Global: is left out");
        expect(problems).not.toContain("this environment: is not used and is forgotten");
      }),
  );

  it.effect(
    "puts on a row a ${NAME} the Environment has neither as a Secret nor as a Variable, naming its source",
    () =>
      Effect.gen(function* () {
        const without = yield* render("work", { held: { secrets: [] } });
        const withSecret = yield* render("work");

        expect(textOf(rowOf(without, "linear"))).toContain(
          "Global: headers.Authorization reads ${LINEAR_TOKEN}, which this environment has neither as a Secret nor as a Variable",
        );
        expect(textOf(rowOf(without, "linear"))).not.toContain("Issues and projects");
        expect(textOf(rowOf(withSecret, "linear"))).toContain("Issues and projects");
      }),
  );
});

const MINUTE = 60_000;

/** A Repo's file with two servers: `docs` reads a Variable-or-Secret `NOTES_KEY` (a Secret of Work's), `build` runs a command. */
const REPO_TEXT = JSON.stringify({
  mcpServers: {
    docs: {
      url: "https://docs.example.com/mcp",
      headers: { Authorization: "Bearer ${NOTES_KEY}" },
      description: "The Repo's docs",
    },
    build: { command: "node", args: ["build-mcp.js"], cwd: "tools" },
  },
});

/** What a test changes of the Registry's view of a Repo's file; `undefined` takes the key away. */
type RepoFileChange = { readonly [K in keyof McpRepoFileView]?: McpRepoFileView[K] | undefined };

/** The Registry's view of Repo `app`'s file: read five minutes ago, with the copy held. */
const repoFile = (more: RepoFileChange = {}): McpRepoFileView => {
  const merged = {
    repo: "app",
    slug: "acme/app",
    path: ".pi/mcp.json",
    state: "read",
    blob: "abcdef0123456",
    text: REPO_TEXT,
    readAt: Date.now() - 5 * MINUTE,
    lookedAt: Date.now() - MINUTE,
    ...more,
  };

  // SAFETY: the keys left `undefined` are taken out, which is what an absent key is.
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as McpRepoFileView;
};

/** What most of these tests hold: the Repo's file, and the Variable its server reads. */
const WITH_REPO = { repoFiles: [repoFile()], variables: { NOTES_KEY: "plain" } };

describe("a Repo's .pi/mcp.json at an Environment", () => {
  it.effect("lists the Repo's servers among the rest, read-only, from the Repo", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", { held: WITH_REPO });

      expect(rowNames(markup)).toEqual(["build", "docs", "files", "linear", "notes", "search"]);

      const docs = rowOf(markup, "docs");
      const text = textOf(docs);

      expect(text).toContain("docs HTTP From Repo app");
      expect(text).toContain("https://docs.example.com/mcp");
      expect(text).toContain("The Repo's docs");
      expect(text).toContain("Read-only: from Repo app's .pi/mcp.json on its default branch");
      // No Edit or Remove: the file is the Repo's. The switch and select write this environment's adjustment.
      expect(docs).not.toContain(">Edit</button>");
      expect(docs).not.toContain('aria-label="Remove docs"');
      expect(docs).toContain('aria-label="docs enabled"');
      expect(docs).toContain('aria-label="docs exposure"');
      expect(text).toContain("Enabled Inherited Exposure Inherited Tool exposure (0) Inherited");
      expect(docs).toContain(">Tool exposure…</button>");
      // Neither Global's copy nor its link.
      expect(docs).not.toContain("Use its own copy");
      expect(docs).not.toContain("Edit at Global");
    }),
  );

  it.effect(
    "shows the entry as JSON exactly as the file has it: ${NAME} kept, cwd as written",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", { held: WITH_REPO });

        expect(rowOf(markup, "docs")).toContain("View as JSON");
        expect(textOf(rowOf(markup, "docs"))).toContain('"Authorization": "Bearer ${NOTES_KEY}"');
        expect(textOf(rowOf(markup, "build"))).toContain('"cwd": "tools"');
        expect(textOf(rowOf(markup, "build"))).not.toContain("/workspace/app/tools");
      }),
  );

  it.effect(
    'shows and copies a `sampling: "allow"` as the file has it, not as the set reads it',
    () =>
      Effect.gen(function* () {
        const text = JSON.stringify({
          mcpServers: { chat: { command: "chat", sampling: "allow", cwd: "tools" } },
        });

        const row = repoRowOf("chat", repoFile({ text }));
        const markup = yield* render("work", { held: { repoFiles: [repoFile({ text })] } });

        // The set reads it as `ask`, with a problem saying to copy it to allow it.
        expect(row.server.sampling).toBe("ask");
        expect(textOf(markup)).toContain("copy it into the Settings to allow it");
        expect(textOf(rowOf(markup, "chat"))).toContain('"sampling": "allow"');
        // The copy keeps `allow`, with the one change a copy needs: the directory made absolute.
        expect(row.written).toEqual({
          command: "chat",
          sampling: "allow",
          cwd: "/workspace/app/tools",
        });
        expect(mcpCopyForm(row)).toMatchObject({ fields: { sampling: "allow" } });
      }),
  );

  it.effect("only switches a Repo's server off, and Reset brings back what its file says", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", { held: WITH_REPO });
      const docs = rowOf(markup, "docs");

      // Exposure: what the file has, or hidden; never direct or deferred.
      expect(docs).toMatch(/aria-label="docs exposure"[\s\S]*?<\/select>/);

      const select =
        /<select[^>]*aria-label="docs exposure"[\s\S]*?<\/select>/.exec(docs)?.[0] ?? "";

      expect(select).toContain('value="codemode"');
      expect(select).toContain('value="hidden"');
      expect(select).not.toContain('value="direct"');
      expect(select).not.toContain('value="deferred"');

      const changes = mcpRepoRowChanges(repoRowOf("docs"));

      // Off writes the adjustment; what the file says is a Reset of it.
      expect(changes.enabled(false)).toMatchObject({ kind: "enabled", enabled: false });
      expect(changes.enabled(true)).toEqual({
        kind: "reset",
        fields: ["mcp.servers.docs.enabled"],
      });
      expect(changes.exposure("hidden")).toMatchObject({ kind: "exposure", exposure: "hidden" });
      expect(changes.exposure("codemode")).toEqual({
        kind: "reset",
        fields: ["mcp.servers.docs.exposure"],
      });
    }),
  );

  it.effect("does not switch on a server its file switched off", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({
        mcpServers: { idle: { command: "idle", enabled: false, exposure: "hidden" } },
      });

      const markup = yield* render("work", { held: { repoFiles: [repoFile({ text })] } });
      const idle = rowOf(markup, "idle");

      expect(idle).toMatch(/aria-label="idle enabled"[^>]*disabled/);
      expect(idle).toMatch(/<select[^>]*aria-label="idle exposure"[^>]*disabled/);
    }),
  );

  it.effect("offers Copy to this environment and Copy to Global on each of its servers", () =>
    Effect.gen(function* () {
      const docs = rowOf(yield* render("work", { held: WITH_REPO }), "docs");

      expect(docs).toContain('aria-label="Copy docs to this environment"');
      expect(docs).toContain(">Copy to this environment…</button>");
      expect(docs).toContain('aria-label="Copy docs to Global"');
      expect(docs).toContain(">Copy to Global…</button>");
    }),
  );

  it.effect(
    "marks an adjustment of a Repo's server as overridden, with a Reset to the Repo's",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          held: { repoFiles: [repoFile()] },
          handlers: {
            getSettingsOverrides: ({ environment }) =>
              Effect.succeed({
                environment,
                settings: DEFAULT_SETTINGS,
                global: DEFAULT_SETTINGS,
                overrides: { mcp: { servers: { docs: { enabled: false } } } },
                instructions: "",
              }),
          },
        });

        const docs = rowOf(markup, "docs");

        expect(textOf(docs)).toContain("Enabled Overridden Reset to Repo app");
        expect(docs).toContain('aria-label="Reset docs enabled to Repo app"');
        expect(docs).toMatch(/aria-label="docs enabled"(?![^>]*checked)/);
      }),
  );

  it.effect("lists each file above the servers: its path, blob, when it was read, and Reload", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", { held: WITH_REPO });
      const text = textOf(markup);

      expect(text).toContain("Repo files");
      expect(text).toContain("app .pi/mcp.json acme/app blob abcdef0");
      expect(text).toContain("Read 5 minutes ago.");
      expect(markup).toContain('aria-label="Reload app&#x27;s .pi/mcp.json"');
      expect(markup.indexOf("Repo files")).toBeLessThan(markup.indexOf("mcp-server-build"));
    }),
  );

  it.effect("has no file list at Global, and none for an Environment with no Repos", () =>
    Effect.gen(function* () {
      expect(textOf(yield* render("*"))).not.toContain("Repo files");
      expect(textOf(yield* render("work"))).not.toContain("Repo files");
    }),
  );

  it.effect("reads ${NAME} from Variables only: a Secret of that name says it gets none", () =>
    Effect.gen(function* () {
      const asSecret = rowOf(yield* render("work", { held: { repoFiles: [repoFile()] } }), "docs");

      expect(textOf(asSecret)).toContain(
        "Repo app (.pi/mcp.json): headers.Authorization reads ${NOTES_KEY}, a Secret: a Repo's server gets no Secrets, so it is skipped. Copy it to this environment's Settings",
      );

      const asVariable = rowOf(
        yield* render("work", {
          held: { repoFiles: [repoFile()], variables: { NOTES_KEY: "plain" } },
        }),
        "docs",
      );

      expect(textOf(asVariable)).not.toContain("a Secret");
      expect(textOf(asVariable)).toContain("The Repo's docs");

      const nothing = rowOf(
        yield* render("work", {
          held: {
            repoFiles: [repoFile()],
            secrets: [],
          },
        }),
        "docs",
      );

      expect(textOf(nothing)).toContain(
        "which this environment has no Variable for, so it is skipped",
      );
    }),
  );

  it.effect("keeps an unreadable Repo's last copy, marked with the error and since when", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            repoFile({
              state: "unreadable",
              error: "GitHub answered 502",
              errorSince: Date.now() - 3 * 3_600_000,
            }),
          ],
        },
      });

      const text = textOf(markup);

      expect(rowNames(markup)).toContain("docs");
      expect(text).toContain("Could not be read since 3 hours ago: GitHub answered 502");
      expect(text).toContain("Its servers are those of the copy read 5 minutes ago.");
      expect(markup).not.toContain('role="alert"');
    }),
  );

  it.effect("says the problem on the file's row once the Registry makes it one", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            repoFile({
              state: "unreadable",
              error: "GitHub answered 502",
              errorSince: Date.now() - 30 * 3_600_000,
              problem: "could not be read for over a day, so its servers are those of the copy",
            }),
          ],
        },
      });

      const file = textOf(markup.slice(markup.indexOf('id="mcp-repo-app"')));

      expect(file).toContain(
        "Repo app (.pi/mcp.json): could not be read for over a day, so its servers are those of the copy",
      );
      expect(rowNames(markup)).toContain("docs");
    }),
  );

  it.effect("shows an unreadable Repo with no copy as a problem and no servers", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            repoFile({
              state: "unreadable",
              error: "GitHub has no repo acme/app (install the GitHub App)",
              errorSince: Date.now(),
              problem: "could not be read: GitHub has no repo acme/app (install the GitHub App)",
              text: undefined,
              readAt: undefined,
              blob: undefined,
            }),
          ],
        },
      });

      expect(rowNames(markup)).toEqual(["files", "linear", "notes", "search"]);
      expect(textOf(markup)).toContain("There is no copy of it, so it adds no servers.");
      expect(textOf(markup)).toContain(
        "Repo app (.pi/mcp.json): could not be read: GitHub has no repo acme/app (install the GitHub App)",
      );
    }),
  );

  it.effect("says a Repo without the file has none, with no problem", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            repoFile({ state: "absent", text: undefined, blob: undefined, readAt: undefined }),
          ],
        },
      });

      expect(textOf(markup)).toContain("no .pi/mcp.json on its default branch");
      expect(rowNames(markup)).toEqual(["files", "linear", "notes", "search"]);
      expect(markup).not.toContain('role="alert"');
      expect(underProblems(markup)).not.toContain("Repo app");
    }),
  );

  it.effect(
    "shows a file that is not valid, or has no servers object, as a problem on its row",
    () =>
      Effect.gen(function* () {
        const broken = yield* render("work", {
          held: { repoFiles: [repoFile({ text: '{ "mcpServers": ' })] },
        });

        expect(textOf(broken)).toContain("Repo app (.pi/mcp.json): is not valid JSON");
        expect(rowNames(broken)).toEqual(["files", "linear", "notes", "search"]);
        // On the file's row, not under Problems.
        expect(underProblems(broken)).not.toContain("Repo app");

        const none = yield* render("work", {
          held: { repoFiles: [repoFile({ text: JSON.stringify({ servers: {} }) })] },
        });

        expect(textOf(none)).toContain("Repo app (.pi/mcp.json): has no mcpServers object");
      }),
  );

  it.effect("shows a file over 64 KiB as not read, with the Registry's problem", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            repoFile({
              state: "oversize",
              text: undefined,
              readAt: undefined,
              problem: "is 70 KiB, over 64 KiB, so it is not read",
            }),
          ],
        },
      });

      expect(textOf(markup)).toContain("Not read");
      expect(textOf(markup)).toContain(
        "Repo app (.pi/mcp.json): is 70 KiB, over 64 KiB, so it is not read",
      );
      expect(rowNames(markup)).not.toContain("docs");
    }),
  );

  it.effect("says a Repo that is not on GitHub is not read, with no Reload", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: {
          repoFiles: [
            {
              repo: "app",
              path: ".pi/mcp.json",
              state: "not_github",
              lookedAt: Date.now(),
            },
          ],
        },
      });

      expect(textOf(markup)).toContain("Not on GitHub, so its .pi/mcp.json is not read");
      expect(markup).not.toContain("Reload");
    }),
  );

  it.effect("says a Repo not looked at yet is not read yet", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: { repoFiles: [{ repo: "app", path: ".pi/mcp.json", state: "never" }] },
      });

      expect(textOf(markup)).toContain("Not read yet.");
      expect(markup).toContain('aria-label="Reload app&#x27;s .pi/mcp.json"');
    }),
  );

  it.effect("reads a state it does not know as one, never as a good file", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: { repoFiles: [repoFile({ state: "quarantined", text: undefined })] },
      });

      expect(textOf(markup)).toContain("In a state this page does not know (quarantined).");
      expect(rowNames(markup)).not.toContain("docs");
    }),
  );

  it.effect("shows an owner's server that hides the Repo's of its name, never as a problem", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({
        mcpServers: {
          linear: { url: "https://repo.example.com/mcp" },
          notes: { command: "notes-mcp", description: "The team's notes" },
        },
      });

      const markup = yield* render("work", { held: { repoFiles: [repoFile({ text })] } });

      expect(textOf(rowOf(markup, "linear"))).toContain(
        "Repo app (.pi/mcp.json) has linear, which this server hides (it differs)",
      );
      expect(textOf(rowOf(markup, "notes"))).toContain(
        "Repo app (.pi/mcp.json) has notes, which this server hides",
      );
      expect(markup).not.toContain('role="alert"');
    }),
  );

  it.effect(
    "says it cannot show the Repos' servers when the Registry cannot say, and shows the rest",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          held: { repoFiles: [repoFile()] },
          handlers: { mcpRepoFiles: () => Effect.die("the Registry has no such call") },
        });

        expect(textOf(markup)).toContain("The Repos' .pi/mcp.json are unavailable");
        expect(rowNames(markup)).toEqual(["files", "linear", "notes", "search"]);
      }),
  );

  it.effect("says nothing of the files while they are still being asked", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: WITH_REPO,
        handlers: { mcpRepoFiles: () => Effect.never },
        pending: [mcpRepoFilesQueryAtom("work")],
      });

      expect(rowNames(markup)).toEqual(["files", "linear", "notes", "search"]);
      expect(textOf(markup)).not.toContain("unavailable");
    }),
  );
});

/** The row of Repo server `name` (of Repo `app`'s `file`) as the section shows it at Work. */
const repoRowOf = (name: string, file: McpRepoFileView = repoFile()) => {
  const view = mcpScopeView({
    scope: "work",
    global: GLOBAL_DOCUMENT,
    globalProblem: undefined,
    overrides: WORK_OVERRIDES,
    overridesProblem: undefined,
    offered: DEFAULT_SETTINGS.tools.offered,
    overriddenIn: {},
    repoFiles: [file],
  });

  const found = view.rows.find((row) => row.name === name);

  if (found === undefined) throw new Error(`no row ${name}`);

  return found;
};

describe("Copy of a Repo's server", () => {
  const repoRow = (name: string) => repoRowOf(name);

  it("makes a form of the entry as the file gives it, named for the Repo it comes from", () => {
    const draft = mcpCopyForm(repoRow("build"));

    expect(draft).toMatchObject({
      kind: "form",
      mode: "copy",
      copiedFrom: "app",
      fields: {
        name: "build",
        kind: "stdio",
        command: "node",
        args: ["build-mcp.js"],
        cwd: "/workspace/app/tools",
      },
    });
  });

  it.effect("opens at this environment as a copy that hides the Repo's and keeps what it was", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        held: { repoFiles: [repoFile()] },
        panel: mcpCopyForm(repoRow("docs")),
      });

      const form = textOf(markup.slice(markup.indexOf("<form")));

      expect(markup).toContain('aria-label="Copy docs from Repo app to this environment"');
      expect(form).toContain(
        "hides the Repo's here, stops following its commits and needs its own MCP sign-in",
      );
      // The name stays the Repo's; the entry keeps ${NAME} as written, and a Secret of the Environment is a name it may read.
      expect(markup).toMatch(/id="mcp-name-work"[^>]*disabled/);
      expect(markup).toContain("Bearer ${NOTES_KEY}");
      // A Secret of the Environment is fine in the owner's copy: no problem about it.
      expect(markup).not.toContain("neither as a Secret nor as a Variable");
    }),
  );

  it.effect("opens at Global as a copy kept Global, saying its directory is the Repo's here", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { panel: mcpCopyForm(repoRow("build")) });

      expect(markup).toContain('aria-label="Copy build from Repo app to Global"');
      expect(textOf(markup)).toContain("kept Global and as copied");
      expect(textOf(markup)).toContain("check it fits every environment");
    }),
  );

  it.effect("saves at the Environment as its own entry, which hides the Repo's", () =>
    Effect.gen(function* () {
      const saved: Array<unknown> = [];

      const layer = fakeRegistryLayer({
        ...handlersFor({ repoFiles: [repoFile()] }),
        updateSettingsOverrides: (payload) =>
          Effect.sync(() => {
            saved.push(payload);

            return {
              environment: payload.environment,
              settings: DEFAULT_SETTINGS,
              global: DEFAULT_SETTINGS,
              overrides: {},
              instructions: "",
            };
          }),
      });

      yield* writeMcpChange("work", {
        kind: "put",
        name: "docs",
        entry: repoRow("docs").written,
      }).pipe(Effect.provide(layer));

      expect(saved).toEqual([
        {
          environment: "work",
          set: { mcp: { servers: { docs: JSON.parse(REPO_TEXT).mcpServers.docs } } },
        },
      ]);
    }),
  );

  it.effect("saves at Global as Global's entry", () =>
    Effect.gen(function* () {
      const saved: Array<unknown> = [];

      const layer = fakeRegistryLayer({
        ...handlersFor({ repoFiles: [repoFile()] }),
        updateSettings: (payload) =>
          Effect.sync(() => {
            saved.push(payload);

            return { settings: DEFAULT_SETTINGS, overrides: payload.overrides, overriddenIn: {} };
          }),
      });

      yield* writeMcpChange("*", {
        kind: "put",
        name: "build",
        entry: repoRow("build").written,
      }).pipe(Effect.provide(layer));

      expect(saved).toHaveLength(1);
      expect(JSON.stringify(saved[0])).toContain(
        '"build":{"command":"node","args":["build-mcp.js"],"cwd":"/workspace/app/tools"}',
      );
    }),
  );
});

describe("what the owner's switch writes on a Repo's server", () => {
  const saved = () => {
    const writes: Array<unknown> = [];

    const handlers = (held: Parameters<typeof handlersFor>[0]): Partial<RegistryHandlers> => ({
      ...handlersFor(held),
      updateSettingsOverrides: (payload) =>
        Effect.sync(() => {
          writes.push(payload);

          return {
            environment: payload.environment,
            settings: DEFAULT_SETTINGS,
            global: DEFAULT_SETTINGS,
            overrides: {},
            instructions: "",
          };
        }),
    });

    return { writes, handlers };
  };

  const docsRow = () => repoRowOf("docs");

  it.effect("is an adjustment of this Environment, over the Repo's server", () =>
    Effect.gen(function* () {
      const { writes, handlers } = saved();

      yield* writeMcpChange("work", mcpRowChanges(docsRow()).enabled(false)).pipe(
        Effect.provide(fakeRegistryLayer(handlers({ repoFiles: [repoFile()] }))),
      );

      expect(writes).toEqual([
        { environment: "work", set: { mcp: { servers: { docs: { enabled: false } } } } },
      ]);
    }),
  );

  it.effect("writes nothing when the Repo no longer has the server since the row was shown", () =>
    Effect.gen(function* () {
      const { writes, handlers } = saved();

      const outcome = yield* writeMcpChange("work", mcpRowChanges(docsRow()).enabled(false)).pipe(
        Effect.provide(
          fakeRegistryLayer(
            handlers({ repoFiles: [repoFile({ text: JSON.stringify({ mcpServers: {} }) })] }),
          ),
        ),
        Effect.flip,
      );

      expect(outcome.message).toContain("docs is not one of this Scope's servers any more");
      expect(writes).toEqual([]);
    }),
  );
});

describe("Reload", () => {
  it.effect("asks the Registry to look at the Repo now, and then asks for the files again", () =>
    Effect.gen(function* () {
      const asked: Array<unknown> = [];

      const registry = registryWith({
        ...handlersFor({ repoFiles: [repoFile()] }),
        mcpReloadRepoFiles: (payload) =>
          Effect.sync(() => {
            asked.push(payload);

            return McpRepoFiles.make({ files: [repoFile()] });
          }),
      });

      yield* settle(registry, [mcpRepoFilesQueryAtom("work")]);
      registry.set(reloadMcpRepoAtom("work"), "app");
      yield* settled(registry, reloadMcpRepoAtom("work"));

      expect(asked).toEqual([{ environment: "work", repo: "app" }]);
      registry.dispose();
    }),
  );

  it.effect("fails with why when the Environment is not there", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        ...handlersFor(),
        mcpReloadRepoFiles: () => Effect.succeed(McpNoEnvironment.make({})),
      });

      registry.set(reloadMcpRepoAtom("work"), undefined);
      const result = yield* settled(registry, reloadMcpRepoAtom("work"));

      expect(JSON.stringify(result)).toContain("This environment is not there any more.");
      registry.dispose();
    }),
  );
});

describe("the form of an Add", () => {
  const add = newMcpForm("add", "", null);

  it.effect(
    "offers stdio or HTTP, timeout, description, enabled, Exposure and Model use as Ask, Allow or Off",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", { panel: add });
        const form = markup.slice(markup.indexOf('<form aria-label="Add a server"'));

        expect(form).toContain("HTTP (a URL)");
        expect(form).toContain("stdio (a command)");
        expect(textOf(form)).toContain("Model use");
        expect(form).toMatch(/<option value="ask" selected[^>]*>Ask<\/option>/);
        expect(form).toContain('<option value="allow">Allow</option>');
        expect(form).toContain('<option value="off">Off</option>');
        expect(textOf(form)).toContain("Timeout (seconds)");
        expect(textOf(form)).toContain("Description");
        expect(textOf(form)).toContain("Enabled");
        expect(form).toContain('<option value="hidden">Hidden</option>');
        expect(textOf(form)).toContain("Tool exposure");
        expect(form).toContain('role="tab"');
        expect(textOf(form)).toContain("Form JSON");
      }),
  );

  it.effect("hints ${NAME} with the Scope's Secret and Variable names, only by name", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        panel: newMcpForm("add", "", {
          command: "x",
          env: { A: "1" },
        }),
      });

      const text = textOf(markup.slice(markup.indexOf('<form aria-label="Add a server')));

      expect(text).toContain("Write ${NAME} for a Secret or a Variable of this scope.");
      expect(text).toContain("Secrets: NOTES_KEY, LINEAR_TOKEN.");
      expect(text).toContain("No Variables.");
      expect(markup).toContain('<option value="${LINEAR_TOKEN}"');
    }),
  );

  it.effect(
    "warns of a credential-shaped literal, and holds Save for an entry that does not decode",
    () =>
      Effect.gen(function* () {
        const leaky = yield* render("*", {
          panel: {
            ...newMcpForm("add", "", null),
            fields: {
              ...emptyMcpFields("http"),
              name: "leaky",
              url: "https://a.example.com/mcp",
              headers: [{ key: "Authorization", value: "Bearer abc" }],
            },
          },
        });

        expect(textOf(leaky)).toContain(
          "headers.Authorization holds a literal that looks like a credential: keep it as a Secret and write ${NAME}",
        );
        expect(leaky).not.toMatch(/<button[^>]*disabled=""[^>]*>Save server/);

        const broken = yield* render("*", {
          panel: {
            ...newMcpForm("add", "", null),
            fields: { ...emptyMcpFields("stdio"), name: "bad", command: "~/bin/x" },
          },
        });

        expect(textOf(broken)).toContain("command: starts with ~");
        expect(broken).toMatch(/<button[^>]*disabled=""[^>]*>Save server/);
      }),
  );

  it.effect(
    "only hints, at Global, a ${NAME} that is no Secret or Variable; refuses it at an Environment",
    () =>
      Effect.gen(function* () {
        const fields = {
          ...emptyMcpFields("http"),
          name: "a",
          url: "https://a.example.com/mcp",
          headers: [{ key: "X-Team", value: "${NOPE}" }],
        };

        const global = yield* render("*", { panel: { ...add, fields } });
        const work = yield* render("work", { panel: { ...add, fields } });

        expect(textOf(global)).toContain(
          "which Global keeps neither as a Secret nor as a Variable",
        );
        expect(global).not.toMatch(/<button[^>]*disabled=""[^>]*>Save server/);
        expect(textOf(work)).toContain(
          "headers.X-Team reads ${NOPE}, which this environment has neither as a Secret nor as a Variable",
        );
        expect(work).toMatch(/<button[^>]*disabled=""[^>]*>Save server/);
      }),
  );

  describe("at an Environment while its Secret and Variable names are not known", () => {
    const fields = {
      ...emptyMcpFields("http"),
      name: "a",
      url: "https://a.example.com/mcp",
    };

    const SAVE_HELD = /<button[^>]*disabled=""[^>]*>Save server/;

    it.effect("holds Save and says why while they load", () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          panel: { ...add, fields },
          handlers: { listEnvironmentSecrets: () => Effect.never },
          pending: [environmentSecretsAtom],
        });

        expect(markup).toMatch(SAVE_HELD);
        expect(textOf(markup)).toContain(
          "Loading this environment's Secret and Variable names: Save is held until they are known",
        );
      }),
    );

    it.effect("blocks Save with the error and Try again when loading them failed", () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          panel: { ...add, fields },
          handlers: { listEnvironmentSecrets: () => Effect.die(new Error("secrets are down")) },
        });

        expect(markup).toMatch(SAVE_HELD);
        expect(textOf(markup)).toContain(
          "Could not load this environment's Secret and Variable names, so Save is held",
        );
        expect(markup).toContain(">Try again</button>");
      }),
    );

    it.effect("lets Save through once they are known, and never holds it at Global", () =>
      Effect.gen(function* () {
        const known = yield* render("work", { panel: { ...add, fields } });

        const global = yield* render("*", {
          panel: { ...add, fields },
          handlers: { listEnvironmentSecrets: () => Effect.never },
          pending: [environmentSecretsAtom],
        });

        expect(known).not.toMatch(SAVE_HELD);
        expect(textOf(known)).not.toContain("Save is held");
        expect(global).not.toMatch(SAVE_HELD);
        expect(textOf(global)).not.toContain("Save is held");
      }),
    );

    it.effect("holds the import the same way", () =>
      Effect.gen(function* () {
        const text = JSON.stringify({ mcpServers: { fresh: { command: "fresh-mcp" } } });

        const markup = yield* render("work", {
          panel: { kind: "import", text, choices: {} },
          handlers: { listEnvironmentSecrets: () => Effect.never },
          pending: [environmentSecretsAtom],
        });

        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
        expect(textOf(markup)).toContain("Save is held until they are known");
      }),
    );
  });

  it.effect("edits a server's toolExposure as rows, suggesting the tools its host discovered", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        panel: newMcpForm("edit", "notes", {
          command: "notes-mcp",
          toolExposure: { "delete_*": "hidden" },
        }),
      });

      expect(markup).toContain('aria-label="Tool exposure 1 pattern"');
      expect(markup).toContain('value="delete_*"');
      expect(markup).toContain('aria-label="Tool exposure 1 exposure"');
      expect(markup).toContain("Edit notes");
    }),
  );

  it.effect("shows a raw-JSON tab with the entry as written", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", {
        panel: {
          ...newMcpForm("edit", "files", { command: "npx", args: ["-y"], sampling: "off" }),
          tab: "json",
          json: JSON.stringify({ command: "npx", args: ["-y"], sampling: "off" }, null, 2),
        },
      });

      expect(markup).toContain('aria-selected="true"');
      expect(markup).toContain("&quot;sampling&quot;: &quot;off&quot;");
    }),
  );

  it.effect("keeps the keys it has no field for, naming them under the form", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", {
        panel: newMcpForm("edit", "linear", {
          type: "http",
          url: "https://mcp.linear.app/mcp",
        }),
      });

      expect(textOf(markup)).toContain("Kept as they are, and editable in the JSON tab: type.");
    }),
  );

  it.effect("copies a Global server as the Environment's own, saying what that does", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        panel: newMcpForm("replace", "files", { command: "npx" }),
      });

      expect(textOf(markup)).toContain("Use files in this environment on its own");
      expect(textOf(markup)).toContain("stops following its changes");
    }),
  );
});

describe("the tool exposure editor of a Global server at an Environment", () => {
  it.effect("saves a server Global still has", () =>
    Effect.gen(function* () {
      const markup = yield* render("work", {
        panel: { kind: "tools", name: "files", rows: [], fixed: [] },
      });

      expect(textOf(markup)).toContain("Tool exposure of files");
      expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Save tool exposure/);
      expect(textOf(markup)).not.toContain("is not one of Global's servers");
    }),
  );

  it.effect(
    "refuses to save when the server is no longer one of Global's in this environment",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          panel: { kind: "tools", name: "vanished", rows: [], fixed: [] },
        });

        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save tool exposure/);
        expect(textOf(markup)).toContain(
          "vanished is not one of Global's servers in this environment any more",
        );
      }),
  );
});

describe("the import", () => {
  const text = JSON.stringify({
    autoEnableCodemode: true,
    mcpServers: {
      linear: { url: "https://mcp.linear.app/mcp" },
      fresh: { command: "fresh-mcp" },
      bad: { command: "x", url: "https://x.example.com" },
    },
  });

  it.effect(
    "lists each entry with its problems before saving, and offers Replace or Skip for a name Global has",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("*", { panel: { kind: "import", text, choices: {} } });
        const entries = markup.slice(markup.indexOf('aria-label="Entries to import"'));

        expect(textOf(entries)).toContain("linear Already here");
        expect(textOf(entries)).toContain("fresh New");
        expect(textOf(entries)).toContain("bad Not imported");
        expect(textOf(entries)).toContain("has both a command and a url");
        expect(entries).toContain(">Skip</label>");
        expect(entries).toContain(">Replace</label>");
        expect(entries).toMatch(/name="mcp-import-\*-linear" checked=""[^>]*\/>Skip/);
        expect(textOf(markup)).toContain("Import 1 server");
      }),
  );

  it.effect("counts what Replace adds, and ignores autoEnableCodemode with a hint", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", {
        panel: { kind: "import", text, choices: { linear: "replace" } },
      });

      expect(textOf(markup)).toContain("Import 2 servers");
      expect(textOf(markup)).toContain("autoEnableCodemode is ignored");
      expect(markup).toContain('href="/settings/all/tools"');
    }),
  );

  it.effect(
    "at an Environment, Global's name is no conflict, an adjusted name is replaced, and its own name asks Replace or Skip",
    () =>
      Effect.gen(function* () {
        const pasted = JSON.stringify({
          mcpServers: {
            files: { command: "files-v2" },
            linear: { url: "https://mcp.linear.app/v2" },
            notes: { command: "notes-v2" },
            fresh: { command: "fresh-mcp" },
          },
        });

        const markup = yield* render("work", {
          panel: { kind: "import", text: pasted, choices: {} },
        });

        const entries = markup.slice(markup.indexOf('aria-label="Entries to import"'));
        const text = textOf(entries);

        // `files` is Global's, which the Environment does not touch: no conflict, its own entry replaces Global's here.
        expect(text).toContain("files New here, replaces Global's");
        expect(entries).not.toContain('name="mcp-import-work-files"');
        // `linear` is Global's with an adjustment of this Environment's: it is replaced by the own entry.
        expect(text).toContain("linear New here, replaces Global's");
        expect(entries).not.toContain('name="mcp-import-work-linear"');
        // `notes` is the Environment's own: Replace or Skip, Skip until chosen.
        expect(text).toContain("notes Already here");
        expect(entries).toMatch(/name="mcp-import-work-notes" checked=""[^>]*\/>Skip/);
        expect(text).toContain("fresh New");
        expect(text).toContain("Import 3 servers");
      }),
  );

  it.effect("at an Environment, Replace on its own name adds it to what is imported", () =>
    Effect.gen(function* () {
      const pasted = JSON.stringify({ mcpServers: { notes: { command: "notes-v2" } } });

      const markup = yield* render("work", {
        panel: { kind: "import", text: pasted, choices: { notes: "replace" } },
      });

      expect(textOf(markup)).toContain("Import 1 server");
    }),
  );

  it.effect("holds the import while the text is not pi's JSON", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", { panel: { kind: "import", text: "{", choices: {} } });

      expect(textOf(markup)).toContain("Not JSON");
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/);
    }),
  );
});

describe("what the owner's actions write", () => {
  /** The row the section shows for server `name` at `scope`: its switch and select make the changes it builds. */
  const rowAt = (scope: string, name: string) => {
    const view = mcpScopeView({
      scope,
      global: GLOBAL_DOCUMENT,
      globalProblem: undefined,
      overrides: scope === "*" ? null : WORK_OVERRIDES,
      overridesProblem: undefined,
      offered: DEFAULT_SETTINGS.tools.offered,
      overriddenIn: {},
    });

    const found = view.rows.find((row) => row.name === name);

    if (found === undefined) throw new Error(`no row ${name} at ${scope}`);

    return found;
  };

  /** What the fake Registry was asked to save, newest last. */
  const recorded = () => {
    const saved: Array<{ readonly rpc: string; readonly payload: unknown }> = [];

    const handlers: Partial<RegistryHandlers> = {
      ...handlersFor(),
      updateSettings: (payload) =>
        Effect.sync(() => {
          saved.push({ rpc: "updateSettings", payload });

          return {
            settings: DEFAULT_SETTINGS,
            overrides: payload.overrides,
            overriddenIn: {},
          };
        }),
      updateSettingsOverrides: (payload) =>
        Effect.sync(() => {
          saved.push({ rpc: "updateSettingsOverrides", payload });

          return {
            environment: payload.environment,
            settings: DEFAULT_SETTINGS,
            global: DEFAULT_SETTINGS,
            overrides: {},
            instructions: "",
          };
        }),
    };

    return { saved, layer: fakeRegistryLayer(handlers) };
  };

  it.effect(
    "an Environment's switch on a Global server writes an adjustment of that Environment",
    () =>
      Effect.gen(function* () {
        const { saved, layer } = recorded();

        yield* writeMcpChange("work", mcpRowChanges(rowAt("work", "files")).enabled(true)).pipe(
          Effect.provide(layer),
        );

        expect(saved).toEqual([
          {
            rpc: "updateSettingsOverrides",
            payload: {
              environment: "work",
              set: { mcp: { servers: { files: { enabled: true } } } },
            },
          },
        ]);
      }),
  );

  it.effect(
    "an Environment's select on a Global server writes its Exposure adjustment, an Override even when equal to Global's",
    () =>
      Effect.gen(function* () {
        const { saved, layer } = recorded();

        yield* writeMcpChange(
          "work",
          mcpRowChanges(rowAt("work", "files")).exposure("codemode"),
        ).pipe(Effect.provide(layer));

        expect(saved[0]?.payload).toEqual({
          environment: "work",
          set: { mcp: { servers: { files: { exposure: "codemode" } } } },
        });
      }),
  );

  it.effect("an Environment's switch on its own server writes the key inside its entry", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      yield* writeMcpChange("work", mcpRowChanges(rowAt("work", "notes")).enabled(false)).pipe(
        Effect.provide(layer),
      );

      expect(saved[0]?.payload).toEqual({
        environment: "work",
        set: {
          mcp: {
            servers: {
              notes: { command: "notes-mcp", description: "The team's notes", enabled: false },
            },
          },
        },
      });
    }),
  );

  it.effect("Reset resets the adjustment key, so it inherits Global's again", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      yield* writeMcpChange("work", {
        kind: "reset",
        fields: ["mcp.servers.linear.enabled"],
      }).pipe(Effect.provide(layer));

      expect(saved[0]?.payload).toEqual({
        environment: "work",
        reset: ["mcp.servers.linear.enabled"],
      });
    }),
  );

  it.effect("Add at an Environment writes an Override of its own entry", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      yield* writeMcpChange("work", {
        kind: "put",
        name: "wiki",
        entry: { url: "https://wiki.example.com/mcp" },
      }).pipe(Effect.provide(layer));

      expect(saved[0]?.payload).toEqual({
        environment: "work",
        set: { mcp: { servers: { wiki: { url: "https://wiki.example.com/mcp" } } } },
      });
    }),
  );

  it.effect("a Global switch writes Global's document with the entry's key changed", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      yield* writeMcpChange("*", mcpRowChanges(rowAt("*", "files")).enabled(true)).pipe(
        Effect.provide(layer),
      );

      expect(saved).toEqual([
        {
          rpc: "updateSettings",
          payload: {
            overrides: {
              mcp: {
                servers: {
                  linear: {
                    url: "https://mcp.linear.app/mcp",
                    headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
                    description: "Issues and projects",
                  },
                  files: { command: "npx", args: ["-y", "@mcp/files"], enabled: true },
                  search: {
                    url: "https://search.example.com/mcp",
                    exposure: "direct",
                    toolExposure: { "delete_*": "hidden" },
                  },
                },
              },
            },
          },
        },
      ]);
    }),
  );

  it.effect("an import saves each valid entry in one write, as the Environment's own", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      yield* writeMcpChange("work", {
        kind: "import",
        entries: [
          { name: "notes", entry: { command: "notes-v2" } },
          { name: "fresh", entry: { command: "fresh-mcp" } },
        ],
      }).pipe(Effect.provide(layer));

      expect(saved).toHaveLength(1);
      expect(saved[0]?.payload).toEqual({
        environment: "work",
        set: {
          mcp: { servers: { notes: { command: "notes-v2" }, fresh: { command: "fresh-mcp" } } },
        },
      });
    }),
  );

  it.effect(
    "a switch on a Global server that Global has removed since the row was shown fails, and adds no orphan adjustment",
    () =>
      Effect.gen(function* () {
        const saved: Array<unknown> = [];
        const change = mcpRowChanges(rowAt("work", "files")).enabled(true);

        const layer = fakeRegistryLayer({
          ...handlersFor(),
          getSettingsOverrides: ({ environment }) =>
            Effect.succeed({
              environment,
              settings: DEFAULT_SETTINGS,
              global: DEFAULT_SETTINGS,
              overrides: WORK_OVERRIDES,
              instructions: "",
            }),
          updateSettingsOverrides: (payload) =>
            Effect.sync(() => {
              saved.push(payload);

              return {
                environment: payload.environment,
                settings: DEFAULT_SETTINGS,
                global: DEFAULT_SETTINGS,
                overrides: {},
                instructions: "",
              };
            }),
        });

        const failure = yield* writeMcpChange("work", change).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(change).toMatchObject({ kind: "enabled", name: "files", target: "adjustment" });
        expect(failure.message).toContain("files");
        expect(saved).toEqual([]);
      }),
  );

  it.effect("a change to a server Global no longer has fails, saving nothing", () =>
    Effect.gen(function* () {
      const { saved, layer } = recorded();

      const failure = yield* writeMcpChange("*", {
        kind: "enabled",
        name: "vanished",
        target: "own",
        enabled: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(failure.message).toContain("vanished");
      expect(saved).toEqual([]);
    }),
  );

  it.effect(
    "a switch on an Environment's own server that is gone by the write fails, and does not adjust Global's of the name",
    () =>
      Effect.gen(function* () {
        const saved: Array<unknown> = [];

        // The page showed `search` as the Environment's own, which replaces Global's `search`; the agent then removed it.
        const change = mcpRowChanges(rowAt("work", "search")).enabled(false);

        const layer = fakeRegistryLayer({
          ...handlersFor(),
          getSettingsOverrides: ({ environment }) =>
            Effect.succeed({
              environment,
              settings: DEFAULT_SETTINGS,
              global: DEFAULT_SETTINGS,
              overrides: { mcp: { servers: { linear: { enabled: false } } } },
              instructions: "",
            }),
          updateSettingsOverrides: (payload) =>
            Effect.sync(() => {
              saved.push(payload);

              return {
                environment: payload.environment,
                settings: DEFAULT_SETTINGS,
                global: DEFAULT_SETTINGS,
                overrides: {},
                instructions: "",
              };
            }),
        });

        const failure = yield* writeMcpChange("work", change).pipe(
          Effect.provide(layer),
          Effect.flip,
        );

        expect(change).toMatchObject({ kind: "enabled", name: "search", target: "own" });
        expect(failure.message).toContain("changed since the page read it");
        expect(saved).toEqual([]);
      }),
  );

  it.effect("goes through the section's atom, which closes nothing and saves once", () =>
    Effect.gen(function* () {
      const saved: Array<unknown> = [];

      const registry = registryWith({
        ...handlersFor(),
        updateSettingsOverrides: (payload) =>
          Effect.sync(() => {
            saved.push(payload);

            return {
              environment: payload.environment,
              settings: DEFAULT_SETTINGS,
              global: DEFAULT_SETTINGS,
              overrides: {},
              instructions: "",
            };
          }),
      });

      registry.mount(changeMcpAtom("work"));
      registry.set(changeMcpAtom("work"), mcpRowChanges(rowAt("work", "files")).enabled(true));
      yield* settled(registry, changeMcpAtom("work"));

      expect(saved).toEqual([
        { environment: "work", set: { mcp: { servers: { files: { enabled: true } } } } },
      ]);
      registry.dispose();
    }),
  );
});

describe("the tool exposure editor of a Repo's server", () => {
  const TOOLS_FILE = repoFile({
    text: JSON.stringify({
      mcpServers: {
        shell: {
          command: "shell",
          toolExposure: { "read_*": "direct", delete_all: "hidden" },
        },
      },
    }),
  });

  it("keeps the file's rows apart, read-only, and starts the owner's rows empty", () => {
    expect(toolsDraftOf(repoRowOf("shell", TOOLS_FILE))).toEqual({
      kind: "tools",
      name: "shell",
      rows: [],
      fixed: [
        { pattern: "read_*", exposure: "direct" },
        { pattern: "delete_all", exposure: "hidden" },
      ],
    });
  });

  it("shows only what is added beyond the file's rows as the owner's, once saved", () => {
    const base = { "read_*": "direct", delete_all: "hidden" } as const;
    const saved = mcpRepoToolExposure(base, [{ pattern: "drop_*", exposure: "hidden" }]);

    const row = repoRowOf("shell", TOOLS_FILE);
    const adjusted = { ...row, server: { ...row.server, toolExposure: saved } };

    expect(toolsDraftOf(adjusted).rows).toEqual([{ pattern: "drop_*", exposure: "hidden" }]);
    expect(toolsDraftOf(adjusted).fixed).toHaveLength(2);
  });

  it("can only hide more: what is added is hidden, ahead of the file's rows, which are all kept", () => {
    const base = { "read_*": "direct", delete_all: "hidden", "list_*": "deferred" } as const;

    // Whatever Exposure a row was typed with, it is hidden; the file's rows keep theirs, and cannot be left out.
    const saved = mcpRepoToolExposure(base, [
      { pattern: "drop_*", exposure: "direct" },
      { pattern: "", exposure: "hidden" },
      { pattern: "list_*", exposure: "codemode" },
    ]);

    expect(Object.entries(saved)).toEqual([
      ["drop_*", "hidden"],
      ["list_*", "hidden"],
      ["read_*", "direct"],
      ["delete_all", "hidden"],
    ]);
    expect(Object.keys(mcpRepoToolExposure(base, []))).toEqual(Object.keys(base));
    expect(mcpRepoToolExposure(base, [])).toEqual(base);
  });

  it("saves the added rows as the adjustment, or resets it when none is left", () => {
    const row = repoRowOf("shell", TOOLS_FILE);

    expect(mcpRepoToolsChange(row, [{ pattern: "drop_*", exposure: "hidden" }])).toEqual({
      kind: "toolExposure",
      name: "shell",
      target: "adjustment",
      toolExposure: { "drop_*": "hidden", "read_*": "direct", delete_all: "hidden" },
    });

    expect(mcpRepoToolsChange(row, [])).toEqual({
      kind: "reset",
      fields: ["mcp.servers.shell.toolExposure"],
    });
  });

  it.effect(
    "lists the file's rows without a way to change them, and offers only hidden for the rest",
    () =>
      Effect.gen(function* () {
        const markup = yield* render("work", {
          held: { repoFiles: [TOOLS_FILE] },
          panel: toolsDraftOf(repoRowOf("shell", TOOLS_FILE)),
        });

        const text = textOf(markup);

        expect(text).toContain("read_* Direct (from the Repo's file; not changed here)");
        expect(text).toContain("A Repo's server can only have tools hidden here");
        // The file's rows have no inputs: the only inputs are the owner's rows, of which there are none yet.
        expect(markup).not.toContain('aria-label="Tool exposure 1 pattern"');
      }),
  );
});
