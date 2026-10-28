// The Container settings at Global as the Registry reads and saves them (docs/architecture/container.md → Container
// settings): reading is lenient and writing strict, no Environment that inherits them may be left above its size limit or with
// more variables than a Workspace takes, and a Workspace is handed an Environment's Overrides over Global's.
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_DOCUMENT,
  overriddenIn,
  patchGlobal,
  readGlobal,
  workspaceOverridesOf,
  writeGlobal,
} from "./global.ts";
import type { RegistryStore } from "./store.ts";

/** An in-memory document table, and Environments with their saved Overrides, as the Registry store has them. */
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

describe("reading the Container settings at Global", () => {
  it("gives the defaults and no overrides before anything is saved", () => {
    expect(readGlobal(store())).toEqual({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} });
  });

  it("reads the document that held only the variables kept Global as it is", () => {
    const documents = store({}, { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { A: "1" } }) });

    expect(readGlobal(documents)).toEqual({
      settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "1" } },
      overrides: { variables: { A: "1" } },
    });
  });

  it("gives the defaults and says why for text that is not JSON, or overrides that no longer resolve", () => {
    const notJson = readGlobal(store({}, { [GLOBAL_DOCUMENT]: "{" }));

    expect(notJson).toMatchObject({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} });
    expect(notJson.problem).toContain("not valid JSON");

    const stale = readGlobal(
      store(
        {},
        {
          [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { PATH: "/bin" }, idleMinutes: 9 }),
        },
      ),
    );

    expect(stale.settings).toEqual({ ...DEFAULT_CONTAINER_SETTINGS, idleMinutes: 9 });
    expect(stale.problem).toContain("variables");
  });
});

describe("saving the Container settings at Global", () => {
  it("keeps only what differs from the defaults, in the document of its name", () => {
    const documents = store();

    expect(
      Result.getOrThrow(writeGlobal(documents, { variables: { A: "1" }, idleMinutes: 9 }, 1)),
    ).toEqual({
      settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: { A: "1" }, idleMinutes: 9 },
      overrides: { idleMinutes: 9, variables: { A: "1" } },
    });
    expect(JSON.parse(documents.text.get(GLOBAL_DOCUMENT) ?? "")).toEqual({
      idleMinutes: 9,
      variables: { A: "1" },
    });

    Result.getOrThrow(writeGlobal(documents, { idleMinutes: 2 }, 2));

    expect(documents.text.get(GLOBAL_DOCUMENT)).toBe("{}");
  });

  it("patches field by field: a set merges over what is saved, a reset goes back to the default", () => {
    const documents = store(
      {},
      { [GLOBAL_DOCUMENT]: JSON.stringify({ variables: { A: "1" }, idleMinutes: 9 }) },
    );

    expect(
      Result.getOrThrow(
        patchGlobal(
          documents,
          { set: { variables: { B: "2" }, setupScript: "make" }, reset: ["idleMinutes"] },
          1,
        ),
      ).overrides,
    ).toEqual({ variables: { A: "1", B: "2" }, setupScript: "make" });
  });

  it("refuses overrides that do not resolve, one problem per line, saving nothing", () => {
    const documents = store();

    const refused = writeGlobal(
      documents,
      { variables: { PATH: "/bin", CLOUDPID_X: "1" }, idleMinutes: "5" },
      1,
    );

    expect(Result.isFailure(refused) ? refused.failure.split("\n").length : 0).toBeGreaterThan(1);
    expect(documents.text.size).toBe(0);
  });

  it("refuses a size above its own size limit", () => {
    expect(writeGlobal(store(), { instance: "standard-3" }, 1)).toEqual(
      Result.fail(expect.stringMatching(/standard-3 is larger than the size limit cpu-2/)),
    );
  });

  it("refuses a limit that would leave an Environment that inherits it below its own size, naming it", () => {
    const documents = store(
      {
        "0000abcd": { name: "Web", overrides: { instance: "cpu-2" } },
        "0000beef": { name: "Api", overrides: { instance: "cpu-2", maxInstance: "cpu-2" } },
      },
      { [GLOBAL_DOCUMENT]: JSON.stringify({ maxInstance: "cpu-3" }) },
    );

    const refused = writeGlobal(documents, { maxInstance: "cpu-1" }, 1);

    expect(Result.isFailure(refused) ? refused.failure : "").toMatch(
      /^instance: environment "Web" \(0000abcd\): .*cpu-2.*cpu-1/,
    );
    expect(Result.isFailure(refused) ? refused.failure : "").not.toContain("Api");
  });

  it("refuses a size that would leave an Environment that inherits it above its own size limit", () => {
    const documents = store(
      { "0000abcd": { name: "Web", overrides: { maxInstance: "cpu-1" } } },
      { [GLOBAL_DOCUMENT]: JSON.stringify({ maxInstance: "cpu-3" }) },
    );

    expect(
      Result.isFailure(writeGlobal(documents, { instance: "cpu-2", maxInstance: "cpu-3" }, 1)),
    ).toBe(true);
  });

  it("refuses a limit below the size of an Environment that inherits it, whatever its limit was", () => {
    // The limit at Global was the Environment's own size: lowering it is refused as lowering it from above is.
    const documents = store({ "0000abcd": { name: "Web", overrides: { instance: "cpu-2" } } });

    expect(writeGlobal(documents, { maxInstance: "cpu-1" }, 1)).toEqual(
      Result.fail(
        expect.stringMatching(/^instance: environment "Web" \(0000abcd\): .*cpu-2.*cpu-1/),
      ),
    );
  });

  it("leaves alone an Environment saved larger before it had a limit, unless the save changes the limit it inherits", () => {
    // Its size raised the limit it inherits as it was read: a save of another field keeps it as it ran, and a new
    // limit at Global is checked against its size, as any Environment's.
    const documents = store({ "0000abcd": { name: "Old", overrides: { instance: "standard-3" } } });

    expect(Result.isSuccess(writeGlobal(documents, { idleMinutes: 30 }, 1))).toBe(true);
    expect(writeGlobal(documents, { maxInstance: "cpu-1" }, 2)).toEqual(
      Result.fail(expect.stringContaining('environment "Old" (0000abcd)')),
    );
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

describe("where the Container settings at Global are overridden", () => {
  it("lists the Environments that override each field, by its path", () => {
    const documents = store({
      "0000abcd": { name: "Web", overrides: { idleMinutes: 5, variables: { A: "own" } } },
      "0000beef": { name: "Api", overrides: { idleMinutes: 2 } },
      "0000cafe": { name: "Bare", overrides: {} },
    });

    expect(overriddenIn(documents)).toEqual({
      idleMinutes: [
        { id: "0000abcd", name: "Web" },
        { id: "0000beef", name: "Api" },
      ],
      "variables.A": [{ id: "0000abcd", name: "Web" }],
    });
  });
});

describe("the overrides a Workspace is handed", () => {
  it("are the Environment's own when nothing is kept Global", () => {
    const documents = store({ "0000abcd": { name: "Web", overrides: { idleMinutes: 30 } } });

    expect(workspaceOverridesOf(documents, "0000abcd")).toEqual({
      overrides: { idleMinutes: 30 },
    });
  });

  it("put Global's settings under the Environment's Overrides, the variables by name", () => {
    const documents = store(
      {
        "0000abcd": {
          name: "Web",
          overrides: { idleMinutes: 30, variables: { A: "own", B: "own" } },
        },
      },
      {
        [GLOBAL_DOCUMENT]: JSON.stringify({
          idleMinutes: 9,
          setupScript: "make",
          variables: { A: "every", C: "every" },
        }),
      },
    );

    expect(workspaceOverridesOf(documents, "0000abcd")).toEqual({
      overrides: {
        idleMinutes: 30,
        setupScript: "make",
        variables: { A: "own", B: "own", C: "every" },
      },
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

    expect(Record.size(handed?.overrides.variables ?? {})).toBe(50);
    expect(handed?.problem).toContain("it would have 53");
  });
});
