// @effect-diagnostics preferEffectArray:off preferEffectRecord:off strictEffectProvide:off preferSchemaOverJson:off -- in-memory fakes of the Registry over native arrays, provided to each test, and fixtures written as JSON text.

// The MCP servers section of the Settings page at a Scope, rendered with `react-dom/server` over the fake Registry: the
// queries a page reads are settled first, so the markup shows what they answered. The changes the owner's actions make
// are run against the same fake, which records what it was asked to save.

import { DEFAULT_CONTAINER_SETTINGS, DEFAULT_SETTINGS, type Settings } from "@cloudpid/config";
import {
  type EnvironmentRecord,
  type EnvironmentSecretRecord,
  McpNoEnvironment,
  McpServersList,
  type McpServerView,
  type McpSettingsProblem,
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
import { emptyMcpFields, newMcpForm } from "./mcp-form.ts";
import { mcpScopeView } from "./mcp-model.ts";
import {
  changeMcpAtom,
  type McpPanel,
  mcpPanelAtom,
  mcpServersAtom,
  writeMcpChange,
} from "./mcp-state.ts";
import { mcpRowChanges } from "./mcp-write.ts";

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
}

/** The Registry's handlers: Global's servers and Work's Overrides, with the fixtures above. */
const handlersFor = (held: Held = {}): Partial<RegistryHandlers> => {
  const settings = settingsOffering(held.offered ?? DEFAULT_SETTINGS.tools.offered);

  return {
    listSessions: () => Effect.succeed([]),
    listEnvironments: () => Effect.succeed([WORK, HOME]),
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
        global: settings,
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
        settings: DEFAULT_CONTAINER_SETTINGS,
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
        ...(scope === "*"
          ? [globalSettingsAtom]
          : [settingsOverridesAtom(scope), environmentSettingsAtom(scope), mcpServersAtom(scope)]),
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

  const next = markup.indexOf('id="mcp-server-', start + 1);
  const group = markup.indexOf("</ul>", start);

  return markup.slice(start, next === -1 ? group : Math.min(next, group + 5));
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

  it.effect("keeps a server's oauth as it was, naming it under the form", () =>
    Effect.gen(function* () {
      const markup = yield* render("*", {
        panel: newMcpForm("edit", "linear", {
          url: "https://mcp.linear.app/mcp",
          oauth: { clientId: "abc" },
        }),
      });

      expect(textOf(markup)).toContain("Kept as they are, and editable in the JSON tab: oauth.");
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
