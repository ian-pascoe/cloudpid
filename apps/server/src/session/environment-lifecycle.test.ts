// The Session's lifecycle operations over a fake Registry: what each asks the Registry, and the upkeep that follows a
// change (the spare Workspace and the Build), as after the owner's RPC.
// @effect-diagnostics asyncFunction:off
import type { AgentChange } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type LifecycleRegistry, sessionLifecycle } from "./environment-lifecycle.ts";

const RECORD = { id: "0000abcd", name: "Other", repos: [], createdAt: 0 };

const CHANGE: AgentChange = {
  id: 3,
  scope: "0000abcd",
  at: 1,
  actor: "agent",
  session: "s-1",
  conversation: 1,
  tool: "t",
  reason: "r",
  field: "name",
  before: "a",
  after: "b",
  reverts: null,
  revertedBy: null,
};

const author = { conversation: 1, tool: "environment_repo_add", reason: "r" };

type Answer = "changed" | "unchanged" | "rejected" | "missing";

/** What the fake Registry is asked, by any of its lifecycle operations. */
type Asked = Parameters<LifecycleRegistry[Exclude<keyof LifecycleRegistry, "getEnvironment">]>[0];

type Options = {
  readonly answer?: Answer;
  /** What the Builds answer to a request for a Build: nothing, or why not. */
  readonly rebuild?: Effect.Effect<"asked" | "underway", string>;
  /** The Session's id; null for a Session the Registry does not list. */
  readonly session?: string | null;
  readonly known?: boolean;
};

const open = ({
  answer = "changed",
  rebuild = Effect.succeed("asked" as const),
  session = "s-1",
  known = true,
}: Options = {}) => {
  const asked: Array<{ op: string; input: Asked }> = [];
  const upkept: string[] = [];

  const said = () => {
    switch (answer) {
      case "changed":
        return { status: "changed" as const, environment: RECORD, change: CHANGE };
      case "unchanged":
        return { status: "unchanged" as const, environment: RECORD };
      case "rejected":
        return { status: "rejected" as const, message: "no" };
      case "missing":
        return { status: "missing" as const };
    }
  };

  const op = (name: string) => (input: Asked) =>
    Effect.sync(() => {
      asked.push({ op: name, input });

      return said();
    });

  // A removal and a Build asked for are never answered "unchanged".
  const changing = (name: string) => (input: Asked) =>
    Effect.map(op(name)(input), (answered) =>
      answered.status === "unchanged" ? { status: "missing" as const } : answered,
    );

  const registry: LifecycleRegistry = {
    agentCreateEnvironment: (input) =>
      Effect.sync(() => {
        asked.push({ op: "create", input });

        return answer === "rejected"
          ? { status: "rejected" as const, message: "no" }
          : {
              status: "created" as const,
              environment: {
                ...RECORD,
                repos: [{ name: "app", url: "https://github.com/o/app.git" }],
              },
              change: CHANGE,
            };
      }),
    agentRenameEnvironment: op("rename"),
    agentAddRepo: op("addRepo"),
    agentRemoveRepo: changing("removeRepo"),
    recordRebuild: changing("recordRebuild"),
    getEnvironment: () => Effect.succeed(known ? RECORD : null),
  };

  const lifecycle = sessionLifecycle({
    registry,
    session: session ?? undefined,
    builds: {
      of: (environment) => Effect.sync(() => void upkept.push(`build:${environment}`)),
      rebuild: (environment) =>
        rebuild.pipe(
          Effect.tap(() => Effect.sync(() => void upkept.push(`rebuild:${environment}`))),
        ),
    },
    spares: { of: (environment) => Effect.sync(() => void upkept.push(`spare:${environment}`)) },
  });

  return { lifecycle, asked, upkept };
};

describe("creating an Environment", () => {
  it("parses the Repos as the owner's are, asks the Registry, and keeps the spare and the Build current", async () => {
    const { lifecycle, asked, upkept } = open();

    const made = await Effect.runPromise(
      lifecycle.create({ name: "N", repos: ["o/app", "https://github.com/o/lib"], author }),
    );

    expect(asked).toEqual([
      {
        op: "create",
        input: {
          name: "N",
          repos: [
            { name: "app", url: "https://github.com/o/app.git" },
            { name: "lib", url: "https://github.com/o/lib" },
          ],
          author: { session: "s-1", ...author },
        },
      },
    ]);
    expect(made).toMatchObject({ status: "made", environment: { id: "0000abcd", name: "Other" } });
    expect(upkept).toEqual(["spare:0000abcd", "build:0000abcd"]);
  });

  it("refuses a Repo the owner's address rules refuse, before the Registry hears of it", async () => {
    const { lifecycle, asked } = open();

    const made = await Effect.runPromise(
      lifecycle.create({ name: "N", repos: ["file:///etc"], author }),
    );

    expect(made.status).toBe("rejected");
    expect(asked).toEqual([]);
  });

  it("starts no upkeep when the Registry refuses the name", async () => {
    const { lifecycle, upkept } = open({ answer: "rejected" });

    expect(
      (await Effect.runPromise(lifecycle.create({ name: "N", repos: [], author }))).status,
    ).toBe("rejected");
    expect(upkept).toEqual([]);
  });

  it("is refused for a Session the Registry does not list", async () => {
    const { lifecycle } = open({ session: null });

    await expect(
      Effect.runPromise(lifecycle.create({ name: "N", repos: [], author })),
    ).rejects.toThrow(/not one the Registry lists/);
  });
});

describe("renaming", () => {
  it("is recorded and starts no upkeep", async () => {
    const { lifecycle, upkept } = open();

    expect(
      (await Effect.runPromise(lifecycle.rename({ environment: "0000abcd", name: "N", author })))
        .status,
    ).toBe("changed");
    expect(upkept).toEqual([]);
  });
});

describe("changing the Repos", () => {
  it("adds one named as the owner's addRepo names it, then keeps the spare and the Build current", async () => {
    const { lifecycle, asked, upkept } = open();

    await Effect.runPromise(
      lifecycle.addRepo({ environment: "0000abcd", source: "o/api", name: "backend", author }),
    );

    expect(asked).toEqual([
      {
        op: "addRepo",
        input: {
          environment: "0000abcd",
          repo: { name: "backend", url: "https://github.com/o/api.git" },
          author: { session: "s-1", ...author },
        },
      },
    ]);
    expect(upkept).toEqual(["spare:0000abcd", "build:0000abcd"]);
  });

  it("refuses an address or directory the owner's rules refuse, asking nothing", async () => {
    const { lifecycle, asked } = open();

    const bad = await Effect.runPromise(
      lifecycle.addRepo({ environment: "0000abcd", source: "o/api", name: "../x", author }),
    );

    const worse = await Effect.runPromise(
      lifecycle.addRepo({ environment: "0000abcd", source: "ftp://x", name: undefined, author }),
    );

    expect(bad.status).toBe("rejected");
    expect(worse.status).toBe("rejected");
    expect(asked).toEqual([]);
  });

  it("removes one and keeps the spare and the Build current", async () => {
    const { lifecycle, upkept } = open();

    await Effect.runPromise(lifecycle.removeRepo({ environment: "0000abcd", name: "app", author }));

    expect(upkept).toEqual(["spare:0000abcd", "build:0000abcd"]);
  });

  it("starts no upkeep when nothing changed or the Registry refused", async () => {
    for (const answer of ["unchanged", "rejected", "missing"] as const) {
      const { lifecycle, upkept } = open({ answer });

      await Effect.runPromise(
        lifecycle.removeRepo({ environment: "0000abcd", name: "app", author }),
      );
      await Effect.runPromise(
        lifecycle.addRepo({ environment: "0000abcd", source: "o/api", name: undefined, author }),
      );
      expect(upkept).toEqual([]);
    }
  });
});

describe("asking for a Build", () => {
  it("asks the Builds, then records it", async () => {
    const { lifecycle, asked, upkept } = open();

    const answer = await Effect.runPromise(lifecycle.rebuild({ environment: "0000abcd", author }));

    expect(answer.status).toBe("changed");
    expect(upkept).toEqual(["rebuild:0000abcd"]);
    expect(asked).toEqual([
      {
        op: "recordRebuild",
        input: { environment: "0000abcd", author: { session: "s-1", ...author } },
      },
    ]);
  });

  it("records nothing when the Build is not asked for, and says why", async () => {
    const { lifecycle, asked } = open({ rebuild: Effect.fail("nothing to build") });

    expect(await Effect.runPromise(lifecycle.rebuild({ environment: "0000abcd", author }))).toEqual(
      {
        status: "rejected",
        message: "nothing to build",
      },
    );
    expect(asked).toEqual([]);
  });

  it("records nothing when a Build of the same key is under way already", async () => {
    const { lifecycle, asked, upkept } = open({ rebuild: Effect.succeed("underway" as const) });

    expect(await Effect.runPromise(lifecycle.rebuild({ environment: "0000abcd", author }))).toEqual(
      { status: "unchanged", environment: { id: "0000abcd", name: "Other" } },
    );
    expect(upkept).toEqual(["rebuild:0000abcd"]);
    expect(asked).toEqual([]);
  });

  it("finds an Environment that is not there missing, asking for nothing", async () => {
    const { lifecycle, upkept } = open({ known: false });

    expect(
      (await Effect.runPromise(lifecycle.rebuild({ environment: "ghost", author }))).status,
    ).toBe("missing");
    expect(upkept).toEqual([]);
  });
});
