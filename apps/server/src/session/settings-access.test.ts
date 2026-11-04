// The Session's Settings read and its MCP read of the Registry (`./settings-access.ts`, `./settings-mcp-access.ts`): the count
// of MCP servers a failed read leaves out without failing the read, and the one answer for an id no Environment has.
// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
import { SettingsAccessError } from "@cloudpid/extensions/settings";
import type { McpChangeGuard } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { sessionSettingsAccess, type SettingsRegistry } from "./settings-access.ts";
import { sessionSettingsMcpAccess } from "./settings-mcp-access.ts";

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
      session: undefined,
    });

    expect(await Effect.runPromise(access.get("env-a"))).toMatchObject({ mcpServers: 3 });
  });

  it("is not failed by a count that cannot be read: the line says it is unavailable", async () => {
    const access = sessionSettingsAccess({
      registry: settingsRegistry(
        Effect.fail(SettingsAccessError.make({ message: "An old Registry has no such method" })),
      ),
      session: undefined,
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

describe("a Session's MCP read", () => {
  it("fails for an id no Environment has, in the words the Settings read uses", async () => {
    // SAFETY: the read asks the one method, which answers that no Environment has the id.
    const registry = { mcpSettingsView: () => Effect.succeed(null) } as never;

    const access = sessionSettingsMcpAccess({
      registry,
      session: undefined,
      host: () => NO_HOST,
    });

    const exit = await Effect.runPromiseExit(access.view({ scope: "nope" }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("No Environment has the id");
  });

  it("gives the host of whichever Environment is asked for", () => {
    const asked: Array<string> = [];

    const access = sessionSettingsMcpAccess({
      // SAFETY: only `host` is used.
      registry: {} as never,
      session: undefined,
      host: (environment) => {
        asked.push(environment);

        return NO_HOST;
      },
    });

    access.host("env-a");
    access.host("env-b");

    expect(asked).toEqual(["env-a", "env-b"]);
  });
});

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

    const settings = sessionSettingsAccess({ registry, session: "s-1" });
    const mcp = sessionSettingsMcpAccess({ registry, session: "s-1", host: () => NO_HOST });

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
