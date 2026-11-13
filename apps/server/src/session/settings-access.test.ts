// The Session's Settings read and its MCP read of the Registry (`./settings-access.ts`, `./settings-mcp-access.ts`): the count
// of MCP servers a failed read leaves out without failing the read, the one answer for an id no Environment has, and who
// a change is recorded as from each author source (a Session's, or the endpoint's, which has no own Environment).
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off preferEffectRecord:off
import { SettingsAccessError } from "@cloudpid/extensions/settings";
import type { McpChangeGuard } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import {
  sessionSettingsAccess,
  settingsReads,
  type SettingsReadsRegistry,
  type SettingsRegistry,
} from "./settings-access.ts";
import { HOLDS_SECRET, SECRETS_CHANGED } from "../registry/via-secrets.ts";
import { sessionSettingsMcpAccess, settingsMcpReads } from "./settings-mcp-access.ts";
import { type AuthorSource, sessionSource } from "./change-author.ts";

/** A Registry that answers one Environment's Settings, and whose count of MCP servers the test makes fail or answer. */
const settingsRegistry = (
  names: Effect.Effect<ReadonlyArray<string> | null, SettingsAccessError>,
): SettingsRegistry => {
  const unused = () => Effect.die("not read");

  const registry = {
    getSettings: unused,
    getSettingsOverrides: () =>
      Effect.succeed({
        settings: { model: "anthropic/claude-opus-5-5" },
        overrides: {},
        global: {},
        problem: undefined,
        instructions: { global: "", environment: "" },
      }),
    getEnvironment: () => Effect.succeed({ id: "env-a", name: "A", repos: [], createdAt: 0 }),
    mcpServerNames: () => names,
    sessionSettings: unused,
    changeSettings: unused,
  };

  // SAFETY: the Settings read of an Environment uses these four methods only; the answers are what each returns.
  return registry as never;
};

describe("a Session's Settings read", () => {
  it("counts the MCP servers of an Environment from its whole set", async () => {
    const access = sessionSettingsAccess({
      registry: settingsRegistry(Effect.succeed(["a", "b", "c"])),
      author: sessionSource(undefined),
    });

    expect(await Effect.runPromise(access.get("env-a"))).toMatchObject({ mcpServers: 3 });
  });

  it("is not failed by a count that cannot be read: the line says it is unavailable", async () => {
    const access = sessionSettingsAccess({
      registry: settingsRegistry(
        Effect.fail(SettingsAccessError.make({ message: "An old Registry has no such method" })),
      ),
      author: sessionSource(undefined),
    });

    const view = await Effect.runPromise(access.get("env-a"));

    expect(view.scope).toBe("env-a");
    expect(view).not.toHaveProperty("mcpServers", expect.anything());
  });
});

/** A host that is not meant to be asked. */
const NO_HOST = {
  requestStart: () => Effect.die("no host"),
  servers: () => Effect.die("no host"),
  apply: () => Effect.die("no host"),
  request: () => Effect.die("no host"),
};

describe("what a Session hands the Registry for an agent's MCP change", () => {
  it("passes the guard of a change to the Registry's transaction, and the ${NAME}s an entry reads to its check", async () => {
    const sent: Array<unknown> = [];

    // SAFETY: the access calls these two methods only, and the test reads what they were given.
    const registry = {
      changeSettings: (input: { readonly guard?: McpChangeGuard | undefined }) =>
        Effect.sync(() => {
          sent.push({ guard: input.guard });

          return { status: "unchanged" as const };
        }),
      mcpChangeCheck: (input: {
        readonly environment: string | undefined;
        readonly name: string;
        readonly reads?: ReadonlyArray<string> | undefined;
      }) =>
        Effect.sync(() => {
          sent.push({ environment: input.environment, name: input.name, reads: input.reads });

          return { environments: [] };
        }),
    } as never;

    const settings = sessionSettingsAccess({ registry, author: sessionSource("s-1") });

    const mcp = sessionSettingsMcpAccess({
      registry,
      author: sessionSource("s-1"),
      host: () => NO_HOST,
    });

    await Effect.runPromise(
      settings.change({
        scope: "*",
        changes: [],
        author: { conversation: 1, tool: "settings_mcp_add", reason: "r" },
        guard: { name: "files", widening: true },
      }),
    );

    await Effect.runPromise(
      mcp.check({ scope: "env-a", name: "files", changes: [], reads: ["TOKEN"] }),
    );

    expect(sent[0]).toMatchObject({ guard: { name: "files", widening: true } });
    expect(sent[1]).toMatchObject({ environment: "env-a", name: "files", reads: ["TOKEN"] });
  });
});

describe("who a Settings change is recorded as", () => {
  const via = { auth: "local" as const, client: { name: "pi" } };
  const request = { id: "req-1", tool: "settings_model_set", digest: "d", attempt: "a" };

  /** The access over a Registry that notes each author it is given and whether the Session's own Environment was read. */
  const opened = (author: AuthorSource) => {
    const authors: Array<unknown> = [];
    const sessionsRead: Array<string> = [];

    // SAFETY: a change and the own Environment use these two methods only.
    const registry = {
      changeSettings: (input: { readonly author: unknown }) =>
        Effect.sync(() => {
          authors.push(input.author);

          return { status: "unchanged" as const };
        }),
      sessionSettings: ({ session }: { readonly session: string }) =>
        Effect.sync(() => {
          sessionsRead.push(session);

          return { environment: "env-a" };
        }),
    } as never;

    return { access: sessionSettingsAccess({ registry, author }), authors, sessionsRead };
  };

  const by = { conversation: 2, tool: "settings_model_set", reason: "r" };

  it.each([
    [
      "a Session's, from its conversation, with its own Environment",
      sessionSource("s-1"),
      { session: "s-1", ...by },
      "env-a",
    ],
    [
      "the endpoint's, as the caller with its claim, with no own Environment",
      { kind: "endpoint", via, request } satisfies AuthorSource,
      { via, tool: by.tool, reason: by.reason, request },
      null,
    ],
  ])("is %s", async (_, source, recorded, own) => {
    const { access, authors } = opened(source);

    await Effect.runPromise(access.change({ scope: "*", changes: [], author: by }));

    expect(authors).toEqual([recorded]);
    expect(await Effect.runPromise(access.own)).toBe(own);
  });

  it("refuses a Session the Registry does not list, asking the Registry nothing", async () => {
    const { access, authors, sessionsRead } = opened(sessionSource(undefined));

    const refused = await Effect.runPromise(
      Effect.flip(access.change({ scope: "*", changes: [], author: by })),
    );

    // A refusal with no code: the Session's own state, which the caller's arguments cannot mend.
    expect(refused).toBeInstanceOf(SettingsAccessError);
    expect(refused.code).toBeUndefined();
    expect(authors).toEqual([]);
    expect(await Effect.runPromise(access.own)).toBeNull();
    expect(sessionsRead).toEqual([]);
  });
});

describe("the Registry's refusal of a Settings change", () => {
  const via = { auth: "local" as const, client: { name: "pi" } };
  const by = { conversation: 2, tool: "settings_model_set", reason: "r" };

  const refusing = (message: string, source: AuthorSource) =>
    sessionSettingsAccess({
      // SAFETY: a change uses this one method, which answers the refusal.
      registry: { changeSettings: () => Effect.succeed({ status: "rejected", message }) } as never,
      author: source,
    });

  it("that heals (the kept Secrets changed meanwhile) is unavailable on the endpoint, so a retry is invited", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        refusing(SECRETS_CHANGED, { kind: "endpoint", via }).change({
          scope: "*",
          changes: [],
          author: by,
        }),
      ),
    );

    expect(failure.code).toBe("unavailable");
    expect(failure.message).toBe(SECRETS_CHANGED);
  });

  it("that holds a kept Secret is invalid_argument on the endpoint, in the Registry's own words", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        refusing(HOLDS_SECRET, { kind: "endpoint", via }).change({
          scope: "*",
          changes: [],
          author: by,
        }),
      ),
    );

    expect(failure.code).toBe("invalid_argument");
    expect(failure.message).toBe(HOLDS_SECRET);
  });

  it.each([
    [
      "the owner's own validation on the endpoint",
      "model: not supported",
      { kind: "endpoint", via } as const,
    ],
    ["the same refusal in a Session", SECRETS_CHANGED, sessionSource("s-1")],
  ])("is left as the Registry's answer for %s", async (_, message, source) => {
    const answer = await Effect.runPromise(
      refusing(message, source).change({ scope: "*", changes: [], author: by }),
    );

    expect(answer).toEqual({ status: "rejected", message });
  });
});

describe("the reads of the Settings and of the MCP servers", () => {
  it("refuse an id no Environment has with the code not_found", async () => {
    // SAFETY: the read asks for the Environment's overrides and the Environment, both of which answer none.
    const registry: SettingsReadsRegistry = {
      getSettingsOverrides: () => Effect.succeed(null),
      getEnvironment: () => Effect.succeed(null),
      mcpServerNames: () => Effect.succeed(null),
    } as never;

    const failure = await Effect.runPromise(Effect.flip(settingsReads(registry).get("nope")));

    expect(failure.code).toBe("not_found");
    expect(failure.message).toContain("No Environment has the id");
  });

  it("give the MCP read from a Registry and the hosts alone, whose refusal of an id is not_found", async () => {
    // SAFETY: the MCP read asks the one method, which answers that no Environment has the id.
    const registry = { mcpSettingsView: () => Effect.succeed(null) } as never;
    const reads = settingsMcpReads(registry, () => NO_HOST);

    const failure = await Effect.runPromise(Effect.flip(reads.view({ scope: "nope" })));

    expect(failure.code).toBe("not_found");
  });
});
