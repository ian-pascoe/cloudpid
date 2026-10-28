// The variables kept Global as the Registry reads and saves them (docs/architecture/container.md → Container settings):
// reading is lenient and writing strict, no Environment may be left with more variables than a Workspace takes, and a
// Workspace is handed an Environment's overrides with the variables kept Global under its own.
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { GLOBAL_DOCUMENT, readGlobal, workspaceOverridesOf, writeGlobal } from "./global.ts";
import type { RegistryStore } from "./store.ts";

/** An in-memory document table, and Environments with their saved overrides, as the Registry store has them. */
const store = (
  environments: Record<string, { readonly name: string; readonly overrides: Schema.Json }> = {},
  documents: Record<string, string> = {},
) => {
  const text = new Map(Record.toEntries(documents));

  return {
    text,
    getDocument: (name: string) => text.get(name) ?? null,
    putDocument: (name: string, body: string) => void text.set(name, body),
    listEnvironments: () =>
      Arr.map(Record.toEntries(environments), ([id, { name }]) => ({
        id,
        name,
        repos: [],
        createdAt: 0,
      })),
    getEnvironmentSettings: (id: string) => environments[id]?.overrides ?? null,
  } satisfies Pick<
    RegistryStore,
    "getDocument" | "putDocument" | "listEnvironments" | "getEnvironmentSettings"
  > & { text: Map<string, string> };
};

const variables = (count: number, prefix = "V"): Record<string, string> =>
  Record.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "x"]));

describe("reading the variables kept Global", () => {
  it("gives none and no overrides before anything is saved", () => {
    expect(readGlobal(store())).toEqual({
      settings: { variables: {} },
      overrides: {},
    });
  });

  it("gives what was saved", () => {
    const documents = store({}, { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { A: "1" } }) });

    expect(readGlobal(documents)).toEqual({
      settings: { variables: { A: "1" } },
      overrides: { variables: { A: "1" } },
    });
  });

  it("gives the defaults and says why for text that is not JSON, or overrides that no longer resolve", () => {
    const notJson = readGlobal(store({}, { [GLOBAL_DOCUMENT]: "{" }));

    expect(notJson).toMatchObject({ settings: { variables: {} }, overrides: {} });
    expect(notJson.problem).toContain("not valid JSON");

    const stale = readGlobal(
      store({}, { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { PATH: "/bin" } }) }),
    );

    expect(stale.settings).toEqual({ variables: {} });
    expect(stale.problem).toContain("variables");
  });
});

describe("saving the variables kept Global", () => {
  it("keeps only what differs from the defaults, in the document of its name", () => {
    const documents = store();

    expect(Result.getOrThrow(writeGlobal(documents, { variables: { A: "1" } }, 1))).toEqual({
      settings: { variables: { A: "1" } },
      overrides: { variables: { A: "1" } },
    });
    expect(documents.text.get(GLOBAL_DOCUMENT)).toBe('{"variables":{"A":"1"}}');

    Result.getOrThrow(writeGlobal(documents, { variables: {} }, 2));

    expect(documents.text.get(GLOBAL_DOCUMENT)).toBe("{}");
  });

  it("refuses overrides that do not resolve, one problem per line, saving nothing", () => {
    const documents = store();

    const refused = writeGlobal(
      documents,
      { variables: { PATH: "/bin", CLOUDPID_X: "1" }, idleMinutes: 5 },
      1,
    );

    expect(Result.isFailure(refused) ? refused.failure.split("\n").length : 0).toBeGreaterThan(1);
    expect(documents.text.size).toBe(0);
  });

  it("refuses a save that would leave an Environment with more than 50 variables, naming it, and saves nothing", () => {
    const documents = store({
      "0000abcd": { name: "Web", overrides: { variables: variables(46, "W") } },
      "0000beef": { name: "Api", overrides: { variables: variables(10, "A") } },
      "0000cafe": { name: "Full", overrides: { variables: variables(50, "V") } },
    });

    const refused = writeGlobal(documents, { variables: variables(7, "E") }, 1);

    expect(refused).toEqual(
      Result.fail(
        Arr.join(
          [
            'variables: environment "Web" (0000abcd) with the 7 variables at Global it does not override, it would have 53: at most 50; unset some there or here',
            'variables: environment "Full" (0000cafe) with the 7 variables at Global it does not override, it would have 57: at most 50; unset some there or here',
          ],
          "\n",
        ),
      ),
    );
    expect(documents.text.size).toBe(0);
  });

  it("takes a name an Environment overrides without counting it twice", () => {
    const documents = store({
      "0000abcd": { name: "Web", overrides: { variables: variables(50) } },
    });

    expect(Result.isSuccess(writeGlobal(documents, { variables: { V0: "e" } }, 1))).toBe(true);
  });
});

describe("the overrides a Workspace is handed", () => {
  it("are the Environment's own when no variables are kept Global", () => {
    const documents = store({ "0000abcd": { name: "Web", overrides: { idleMinutes: 30 } } });

    expect(workspaceOverridesOf(documents, "0000abcd")).toEqual({
      overrides: { idleMinutes: 30 },
    });
  });

  it("put the variables kept Global under the Environment's own", () => {
    const documents = store(
      {
        "0000abcd": {
          name: "Web",
          overrides: { idleMinutes: 30, variables: { A: "own", B: "own" } },
        },
      },
      { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { A: "every", C: "every" } }) },
    );

    expect(workspaceOverridesOf(documents, "0000abcd")).toEqual({
      overrides: { idleMinutes: 30, variables: { A: "own", B: "own", C: "every" } },
    });
  });

  it("are none for an Environment that is not registered", () => {
    expect(workspaceOverridesOf(store(), "0000abcd")).toBeNull();
  });

  it("are cut at 50 variables and say so, for a set no save would have made", () => {
    const documents = store(
      { "0000abcd": { name: "Web", overrides: { variables: variables(48, "W") } } },
      { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: variables(5, "E") }) },
    );

    const handed = workspaceOverridesOf(documents, "0000abcd");

    // SAFETY: the Environment's overrides hold variables.
    const kept = (handed?.overrides as { variables: Record<string, string> } | undefined)
      ?.variables;

    expect(Record.size(kept ?? {})).toBe(50);
    expect(handed?.problem).toContain("it would have 53");
  });
});
