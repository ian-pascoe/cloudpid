// The Session's lifecycle operations over a fake Registry: what each asks the Registry, and the upkeep that follows a
// change (the spare Workspace and the Build), as after the owner's RPC; from either author source (a Session's, or the
// endpoint's, whose changes carry the caller and its claim, and which has no Test Build of its own yet).
// @effect-diagnostics asyncFunction:off
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import type { ProposedBuild } from "../registry/builds.ts";
import type { TestBuildState } from "../workspace/build-record.ts";
import { type AuthorSource, sessionSource } from "./change-author.ts";
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
  /** Who makes the changes: Session s-1 unless given (a Session the Registry does not list has no id). */
  readonly source?: AuthorSource;
  readonly known?: boolean;
  /** Whether the Repos' after-steps are given (the endpoint's), noted in `upkept` as `after:<environment>:<repo>:<look>`. */
  readonly afterRepos?: boolean;
};

/** The Test Builds asked for, what each state read answers next (the last repeats), and the ids cancelled. */
type FakeTestBuilds = {
  started: Array<{ environment: string; id: string; proposed: ProposedBuild }>;
  states: Array<TestBuildState | null>;
  reads: number;
  cancelled: string[];
};

const open = ({
  answer = "changed",
  rebuild = Effect.succeed("asked" as const),
  source = sessionSource("s-1"),
  known = true,
  afterRepos = false,
}: Options = {}) => {
  const asked: Array<{ op: string; input: Asked }> = [];
  const upkept: string[] = [];

  const tests: FakeTestBuilds = { started: [], states: [], reads: 0, cancelled: [] };

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
    author: source,
    builds: {
      of: (environment) => Effect.sync(() => void upkept.push(`build:${environment}`)),
      rebuild: (environment) =>
        rebuild.pipe(
          Effect.tap(() => Effect.sync(() => void upkept.push(`rebuild:${environment}`))),
        ),
      test: {
        start: (input) =>
          Effect.sync(() => {
            tests.started.push({ ...input });

            return { id: input.id, key: "k", startedAt: 5, status: "building" as const };
          }),
        state: () =>
          Effect.sync(() => tests.states[Math.min(tests.reads++, tests.states.length - 1)] ?? null),
        cancel: ({ id }) => Effect.sync(() => void tests.cancelled.push(id)),
      },
    },
    spares: { of: (environment) => Effect.sync(() => void upkept.push(`spare:${environment}`)) },
    afterRepos: afterRepos
      ? ({ environment, repo, look }) =>
          Effect.sync(() => void upkept.push(`after:${environment}:${repo ?? ""}:${String(look)}`))
      : undefined,
    rounds: { roundMs: 30, pollMs: 10 },
  });

  return { lifecycle, asked, upkept, tests };
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

  it("starts no upkeep when the Registry refuses the name", async () => {
    const { lifecycle, upkept } = open({ answer: "rejected" });

    expect(
      (await Effect.runPromise(lifecycle.create({ name: "N", repos: [], author }))).status,
    ).toBe("rejected");
    expect(upkept).toEqual([]);
  });

  it("is refused for a Session the Registry does not list", async () => {
    const { lifecycle } = open({ source: sessionSource(undefined) });

    const refused = await Effect.runPromise(
      lifecycle.create({ name: "N", repos: [], author }).pipe(Effect.flip),
    );

    // A refusal with no code: the Session's own state, which the caller's arguments cannot mend.
    expect(refused).toBeInstanceOf(EnvironmentsError);
    expect(refused.code).toBeUndefined();
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

describe("the Repos' after-steps", () => {
  it("run after the upkeep for each change of the Repos: a look at the Repo added, none for one taken out, and one for a new Environment's Repos", async () => {
    const { lifecycle, upkept } = open({ afterRepos: true });

    await Effect.runPromise(
      lifecycle.addRepo({ environment: "0000abcd", source: "o/api", name: "backend", author }),
    );
    await Effect.runPromise(lifecycle.removeRepo({ environment: "0000abcd", name: "app", author }));
    await Effect.runPromise(lifecycle.create({ name: "N", repos: ["o/app"], author }));

    expect(upkept).toEqual([
      "spare:0000abcd",
      "build:0000abcd",
      "after:0000abcd:backend:true",
      "spare:0000abcd",
      "build:0000abcd",
      "after:0000abcd::false",
      "spare:0000abcd",
      "build:0000abcd",
      "after:0000abcd::true",
    ]);
  });

  it("do not run for a new Environment with no Repos, or when nothing changed", async () => {
    const { lifecycle, upkept } = open({ afterRepos: true });

    await Effect.runPromise(lifecycle.create({ name: "N", repos: [], author }));

    expect(Arr.filter(upkept, (step) => step.startsWith("after:"))).toEqual([]);

    for (const answer of ["unchanged", "rejected"] as const) {
      const none = open({ afterRepos: true, answer });

      await Effect.runPromise(
        none.lifecycle.addRepo({
          environment: "0000abcd",
          source: "o/api",
          name: undefined,
          author,
        }),
      );

      expect(none.upkept).toEqual([]);
    }
  });
});

describe("a Test Build", () => {
  it("parses the proposed Repos as the owner's are and asks the Builds, by the Session's id and the call's", async () => {
    const { lifecycle, asked, upkept, tests } = open();

    const started = await Effect.runPromise(
      lifecycle.startTestBuild({
        environment: "0000abcd",
        call: "7",
        proposed: {
          repos: [{ url: "o/app" }, { url: "o/api", name: "backend" }],
          setupScript: "x",
        },
      }),
    );

    expect(started).toEqual({
      status: "started",
      environment: { id: "0000abcd", name: "Other" },
      progress: { status: "building", startedAt: 5 },
    });
    expect(tests.started).toEqual([
      {
        environment: "0000abcd",
        id: "s-1/7",
        proposed: {
          repos: [
            { name: "app", url: "https://github.com/o/app.git" },
            { name: "backend", url: "https://github.com/o/api.git" },
          ],
          setupScript: "x",
        },
      },
    ]);
    // Nothing is recorded, and no upkeep runs: nothing changed.
    expect(asked).toEqual([]);
    expect(upkept).toEqual([]);
  });

  it("refuses a Repo the owner's rules refuse, and two in one directory, asking nothing", async () => {
    const { lifecycle, tests } = open();

    for (const repos of [[{ url: "ftp://x" }], [{ url: "o/app" }, { url: "p/app" }]]) {
      expect(
        (
          await Effect.runPromise(
            lifecycle.startTestBuild({ environment: "0000abcd", call: "7", proposed: { repos } }),
          )
        ).status,
      ).toBe("rejected");
    }

    expect(tests.started).toEqual([]);
  });

  it("passes on why the Builds refuse it, and finds an Environment that is not there missing", async () => {
    expect(
      (
        await Effect.runPromise(
          open({ known: false }).lifecycle.startTestBuild({
            environment: "ghost",
            call: "7",
            proposed: {},
          }),
        )
      ).status,
    ).toBe("missing");
  });

  it("waits a round, answering as soon as it ended, or how it stands at the round's end", async () => {
    const { lifecycle, tests } = open();
    const building = { id: "s-1/7", key: "k", startedAt: 5, status: "building" as const };

    tests.states = [building, { ...building, status: "succeeded", finishedAt: 9 }];

    expect(
      await Effect.runPromise(lifecycle.testBuildRound({ environment: "0000abcd", call: "7" })),
    ).toEqual({ status: "succeeded", startedAt: 5, finishedAt: 9 });

    tests.states = [building];
    tests.reads = 0;

    expect(
      await Effect.runPromise(lifecycle.testBuildRound({ environment: "0000abcd", call: "7" })),
    ).toEqual({ status: "building", startedAt: 5 });
    expect(tests.reads).toBeGreaterThan(1);

    tests.states = [null];
    tests.reads = 0;

    expect(
      await Effect.runPromise(lifecycle.testBuildRound({ environment: "0000abcd", call: "7" })),
    ).toEqual({ status: "gone" });
  });

  it("cancels by the Session's id and the call's", async () => {
    const { lifecycle, tests } = open();

    await Effect.runPromise(lifecycle.cancelTestBuild({ environment: "0000abcd", call: "7" }));

    expect(tests.cancelled).toEqual(["s-1/7"]);
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

describe("from the endpoint", () => {
  const via = { auth: "oauth" as const, client: { name: "pi" }, clientId: "c-1" };
  const request = { id: "req-1", tool: "environment_repo_add", digest: "d", attempt: "a" };
  const endpoint: AuthorSource = { kind: "endpoint", via, request };

  it("records a change as the caller, with its claim and no Session, and keeps the spare and the Build current", async () => {
    const { lifecycle, asked, upkept } = open({ source: endpoint });

    await Effect.runPromise(
      lifecycle.addRepo({
        environment: "0000abcd",
        source: "o/api",
        name: "backend",
        author: { tool: author.tool, reason: author.reason },
      }),
    );

    expect(asked).toEqual([
      {
        op: "addRepo",
        input: {
          environment: "0000abcd",
          repo: { name: "backend", url: "https://github.com/o/api.git" },
          author: { via, tool: author.tool, reason: author.reason, request },
        },
      },
    ]);
    expect(upkept).toEqual(["spare:0000abcd", "build:0000abcd"]);
  });

  it("starts no Test Build, which is a Session's only so far", async () => {
    const { lifecycle, tests } = open({ source: endpoint });

    expect(
      await Effect.runPromise(
        lifecycle
          .startTestBuild({ environment: "0000abcd", call: "7", proposed: {} })
          .pipe(Effect.flip),
      ),
    ).toMatchObject({ code: "invalid_argument" });
    expect(tests.started).toEqual([]);
  });
});
