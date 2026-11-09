// A cloudpid report over the Registry's real SQLite and a fake GitHub (`cloudpid-reports.ts`, `../github/issues.ts`;
// `docs/architecture/agent-capabilities.md` → cloudpid reports, ADR-0051): the claim and its exactly-once states, the caps,
// the label's precheck, GitHub's refusals, the second call for a dropped label, a post with no answer, `retry-after`, the
// pacing of posts, and the pruning of old rows. Never GitHub itself.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off newPromise:off globalTimers:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHubNotInstalled } from "../github/app.ts";
import {
  type AgentCloudpidReportInput,
  openCloudpidReports,
  REPORT_FOOTER_SEPARATOR,
} from "./cloudpid-reports.ts";
import type { RealRegistry } from "./registry.fixture.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;

/** 2026-11-09, 12:00 UTC. */
const NOON = Date.UTC(2026, 10, 9, 12);

type Seen = { readonly method: string; readonly path: string; readonly body: unknown };

/** What the fake answers each call with; a function of the call's number among its kind. */
type Script = {
  label: () => Response;
  create: (body: { readonly title: string; readonly body: string }) => Response | "hang" | "never";
  addLabels: () => Response;
};

const created = (number: number, labels: ReadonlyArray<string>) =>
  Response.json(
    {
      number,
      html_url: `https://github.com/ian-pascoe/cloudpid/issues/${String(number)}`,
      labels: labels.map((name) => ({ name })),
    },
    { status: 201 },
  );

/** GitHub's issues API for cloudpid's repo, as scripted, recording each call. */
const fakeGitHub = () => {
  const seen: Seen[] = [];
  let issues = 0;

  const script: Script = {
    label: () => Response.json({ name: "cloudpid-report" }),
    create: () => {
      issues += 1;

      return created(issues, ["cloudpid-report", "needs-triage"]);
    },
    addLabels: () => Response.json([{ name: "cloudpid-report" }, { name: "needs-triage" }]),
  };

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const text = init.body === undefined ? "" : await new Response(init.body).text();
    const body: unknown = text === "" ? undefined : JSON.parse(text);

    seen.push({ method, path, body });

    if (method === "GET" && path === "/repos/ian-pascoe/cloudpid/labels/cloudpid-report") {
      return script.label();
    }

    if (method === "POST" && path === "/repos/ian-pascoe/cloudpid/issues") {
      // SAFETY: the Registry posts the issue as JSON with a title and a body.
      const answer = script.create(body as { title: string; body: string });

      if (answer === "hang") throw new Error("The operation was aborted due to timeout");

      // The object is cut off while it waits: an eviction mid-post.
      if (answer === "never") return new Promise<Response>(() => {});

      return answer;
    }

    if (method === "POST" && /^\/repos\/ian-pascoe\/cloudpid\/issues\/\d+\/labels$/.test(path)) {
      return script.addLabels();
    }

    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return { fetch, seen, script };
};

const BODY =
  "Calling bash with a timeout of 30 s never returned; @someone said it ends at the timeout. `@decorator` stays.";

/** A report of Session `session`'s call `task`. */
const report = (
  session: string,
  task: number,
  title = `report ${session} ${String(task)}`,
): AgentCloudpidReportInput => ({
  session,
  conversation: 1,
  task,
  title,
  body: BODY,
  kind: "bug",
  tool: "bash",
  footer: {
    stage: "pr-731",
    version: "v-1234",
    model: "anthropic/claude-opus-4-5",
    thinking: "high",
    agent: "agent-1",
  },
});

/** Run `body` over a fresh Registry's store and reports, with a clock the test moves and the waits the reports asked for. */
const inRegistry = <A>(
  body: (registry: {
    readonly reports: ReturnType<typeof openCloudpidReports>;
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly github: ReturnType<typeof fakeGitHub>;
    readonly clock: { now: number };
    readonly waits: number[];
    readonly installed: { value: boolean };
    /** The tokens the reports dropped as refused. */
    readonly invalidated: string[];
    readonly reopen: () => ReturnType<typeof openCloudpidReports>;
  }) => Promise<A>,
  options: { readonly dailyCap?: number } = {},
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);
    const github = fakeGitHub();
    const clock = { now: NOON };
    const waits: number[] = [];
    const installed = { value: true };
    const invalidated: string[] = [];

    const reopen = () =>
      openCloudpidReports({
        storage: state.storage,
        store,
        tokens: {
          token: async () => {
            if (!installed.value) throw new GitHubNotInstalled("ian-pascoe");

            return "ghs_report";
          },
          invalidate: (token) => {
            invalidated.push(token);
          },
        },
        fetch: github.fetch,
        dailyCap: options.dailyCap ?? 10,
        origin: "https://cloudpid-server-pr-731.example.workers.dev",
        now: () => clock.now,
        sleep: async (ms) => {
          waits.push(ms);
          clock.now += ms;
        },
      });

    return body({
      reports: reopen(),
      store,
      github,
      clock,
      waits,
      installed,
      invalidated,
      reopen,
    });
  });

/** The calls of `method` to `path`. */
const calls = (seen: ReadonlyArray<Seen>, method: string, suffix: string) =>
  seen.filter((call) => call.method === method && call.path.endsWith(suffix));

describe("a cloudpid report", () => {
  it("is posted once as an issue with both labels and cloudpid's footer, and a rerun of its call gets the same issue", async () => {
    const { first, again, seen } = await inRegistry(async ({ reports, github }) => {
      const first = await reports.file(report("s1", 7));
      const again = await reports.file(report("s1", 7));

      return { first, again, seen: github.seen };
    });

    const filed = {
      status: "filed",
      number: 1,
      url: "https://github.com/ian-pascoe/cloudpid/issues/1",
      labelled: true,
    };

    expect(first).toEqual(filed);
    expect(again).toEqual(filed);

    const posts = calls(seen, "POST", "/issues");

    expect(posts).toHaveLength(1);
    // SAFETY: the issue's JSON, as the fake read it.
    const issue = posts[0]?.body as { title: string; body: string; labels: string[] };

    expect(issue.labels).toEqual(["cloudpid-report", "needs-triage"]);
    expect(issue.title).toBe("report s1 7");
    // The body is posted defused, with the footer after it (their cases are in `cloudpid-reports.test.ts`).
    expect(issue.body).toContain("@\u200bsomeone");
    expect(issue.body.split(REPORT_FOOTER_SEPARATOR)[1]).toContain(
      "https://cloudpid-server-pr-731.example.workers.dev/sessions/s1",
    );
  });

  it("answers a rerun of a call cut off while it posted that it may have been filed, and posts nothing more", async () => {
    const { again, seen } = await inRegistry(async ({ reports, github, reopen }) => {
      github.script.create = () => "never";

      void reports.file(report("s1", 1));

      while (calls(github.seen, "POST", "/issues").length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      github.script.create = () => created(2, ["cloudpid-report", "needs-triage"]);

      // The object after the eviction finds the call claimed.
      return { again: await reopen().file(report("s1", 1)), seen: github.seen };
    });

    expect(again).toEqual({ status: "unknown" });
    expect(calls(seen, "POST", "/issues")).toHaveLength(1);
  });

  it("is refused, posting nothing and counting no cap, when it names the owner's Repos", async () => {
    const { answer, seen, after } = await inRegistry(async ({ reports, store, github }) => {
      store.createEnvironment("env-acme", "Acme", 0);
      store.addRepo("env-acme", {
        name: "acme-portal",
        url: "https://github.com/spiritledsoftware/acme-portal.git",
      });

      const answer = await reports.file({
        ...report("s1", 1),
        body: `${BODY} It happened in /workspace/acme-portal.`,
      });

      const after = [
        await reports.file(report("s1", 2)),
        await reports.file(report("s1", 3)),
        await reports.file(report("s1", 4)),
      ];

      return { answer, seen: github.seen, after };
    });

    expect(answer).toMatchObject({ status: "refused", code: "names" });
    expect(answer.status === "refused" ? answer.message : "").toContain("/workspace/acme-portal");
    expect(after.map(({ status }) => status)).toEqual(["filed", "filed", "filed"]);
    expect(calls(seen, "POST", "/issues")).toHaveLength(3);
  });

  it("counts at most 3 per Session, children's included, and a call with no answer among them", async () => {
    const answers = await inRegistry(async ({ reports, github }) => {
      github.script.create = () => "hang";
      const lost = await reports.file(report("s1", 1));
      const lostAgain = await reports.file(report("s1", 1));

      github.script.create = () => created(9, ["cloudpid-report", "needs-triage"]);

      return [
        lost,
        lostAgain,
        await reports.file(report("s1", 2)),
        await reports.file(report("s1", 3)),
        await reports.file(report("s1", 4)),
        await reports.file(report("s2", 1)),
      ];
    });

    expect(answers.map((answer) => answer.status)).toEqual([
      "unknown",
      "unknown",
      "filed",
      "filed",
      "refused",
      "filed",
    ]);
    expect(answers[4]).toMatchObject({ code: "session_cap" });
  });

  it("counts the stage's cap per UTC day", async () => {
    const answers = await inRegistry(
      async ({ reports, clock }) => {
        const today = [
          await reports.file(report("a", 1)),
          await reports.file(report("b", 1)),
          await reports.file(report("c", 1)),
          await reports.file(report("d", 1)),
        ];

        clock.now = Date.UTC(2026, 10, 10, 0, 0, 1);

        return [...today, await reports.file(report("d", 2))];
      },
      { dailyCap: 3 },
    );

    expect(answers.map((answer) => answer.status)).toEqual([
      "filed",
      "filed",
      "filed",
      "refused",
      "filed",
    ]);
    expect(answers[3]).toMatchObject({ code: "daily_cap" });
  });

  it("refuses a title the Session filed already, however it is cased or spaced", async () => {
    const answers = await inRegistry(async ({ reports }) => [
      await reports.file(report("s1", 1, "bash ignores its timeout")),
      await reports.file(report("s1", 2, "  Bash ignores   its TIMEOUT ")),
      await reports.file(report("s2", 1, "bash ignores its timeout")),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual(["filed", "refused", "filed"]);
    expect(answers[1]).toMatchObject({ code: "repeated" });
  });

  it("is refused before posting while the label is missing, asking GitHub again only after 5 minutes, and once it exists never again", async () => {
    const { answers, seen } = await inRegistry(async ({ reports, github, clock }) => {
      github.script.label = () => Response.json({ message: "Not Found" }, { status: 404 });

      const missing = await reports.file(report("s1", 1));
      const stillMissing = await reports.file(report("s1", 2));

      github.script.label = () => Response.json({ name: "cloudpid-report" });
      clock.now += 5 * 60_000;

      return {
        answers: [
          missing,
          stillMissing,
          await reports.file(report("s1", 3)),
          await reports.file(report("s1", 4)),
          await reports.file(report("s1", 5)),
        ],
        seen: github.seen,
      };
    });

    expect(answers.map((answer) => answer.status)).toEqual([
      "refused",
      "refused",
      "filed",
      "filed",
      "filed",
    ]);
    expect(answers[0]).toMatchObject({ code: "label_missing" });
    // Refused without a cap: the three after it are the Session's three.
    expect(calls(seen, "GET", "/labels/cloudpid-report")).toHaveLength(2);
    expect(calls(seen, "POST", "/issues")).toHaveLength(3);
  });

  it("fails with GitHub's words on a 422, never asking again, and counts no cap", async () => {
    const { answers, seen } = await inRegistry(async ({ reports, github }) => {
      github.script.create = () =>
        Response.json(
          {
            message: "Validation Failed",
            errors: [{ resource: "Issue", code: "custom", message: "title is too long" }],
          },
          { status: 422 },
        );

      const refused = await reports.file(report("s1", 1));
      const rerun = await reports.file(report("s1", 1));

      github.script.create = () => created(5, ["cloudpid-report", "needs-triage"]);

      return {
        answers: [
          refused,
          rerun,
          await reports.file(report("s1", 2)),
          await reports.file(report("s1", 3)),
          await reports.file(report("s1", 4)),
        ],
        seen: github.seen,
      };
    });

    expect(answers[0]).toMatchObject({ status: "failed" });
    expect(answers[0]?.status === "failed" ? answers[0].message : "").toContain(
      "title is too long",
    );
    expect(answers[1]).toMatchObject({ status: "failed" });
    expect(answers.slice(2).map((answer) => answer.status)).toEqual(["filed", "filed", "filed"]);
    expect(calls(seen, "POST", "/issues")).toHaveLength(4);
  });

  it.each<[string, () => Response, boolean]>([
    [
      "adds a label GitHub dropped with one more call",
      () => Response.json([{ name: "cloudpid-report" }, { name: "needs-triage" }]),
      true,
    ],
    [
      "still answers the issue, unlabelled, when that call fails too",
      () => Response.json({ message: "Server Error" }, { status: 502 }),
      false,
    ],
  ])("%s", async (_, addLabels, labelled) => {
    const { answer, again, seen } = await inRegistry(async ({ reports, github }) => {
      github.script.create = () => created(3, []);
      github.script.addLabels = addLabels;

      return {
        answer: await reports.file(report("s1", 1)),
        again: await reports.file(report("s1", 1)),
        seen: github.seen,
      };
    });

    const filed = {
      status: "filed",
      number: 3,
      url: "https://github.com/ian-pascoe/cloudpid/issues/3",
      labelled,
    };

    expect(answer).toEqual(filed);
    // A rerun of the call answers the same, labelled or not.
    expect(again).toEqual(filed);
    expect(calls(seen, "POST", "/issues")).toHaveLength(1);
    expect(calls(seen, "POST", "/issues/3/labels").map(({ body }) => body)).toEqual([
      { labels: ["cloudpid-report", "needs-triage"] },
    ]);
  });

  it("asks for no label when GitHub kept both", async () => {
    const seen = await inRegistry(async ({ reports, github }) => {
      await reports.file(report("s1", 1));

      return github.seen;
    });

    expect(calls(seen, "POST", "/labels")).toEqual([]);
  });

  it("waits out GitHub's retry-after, refusing every call until then, and counts no cap", async () => {
    const { answers, seen } = await inRegistry(async ({ reports, github, clock }) => {
      github.script.create = () =>
        new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 403,
          headers: { "retry-after": "60" },
        });

      const limited = await reports.file(report("s1", 1));

      github.script.create = () => created(4, ["cloudpid-report", "needs-triage"]);
      clock.now += 30_000;

      const waiting = await reports.file(report("s1", 2));

      clock.now += 31_000;

      return {
        answers: [
          limited,
          waiting,
          await reports.file(report("s1", 3)),
          await reports.file(report("s1", 4)),
          await reports.file(report("s1", 5)),
        ],
        seen: github.seen,
      };
    });

    expect(answers.map((answer) => answer.status)).toEqual([
      "failed",
      "refused",
      "filed",
      "filed",
      "filed",
    ]);
    expect(answers[1]).toMatchObject({ code: "rate_limited" });
    expect(calls(seen, "POST", "/issues")).toHaveLength(4);
  });

  it("keeps a retry-after for the next instance of the object", async () => {
    const answer = await inRegistry(async ({ reports, github, reopen }) => {
      github.script.create = () =>
        new Response("{}", { status: 429, headers: { "retry-after": "60" } });

      await reports.file(report("s1", 1));

      return reopen().file(report("s1", 2));
    });

    expect(answer).toMatchObject({ status: "refused", code: "rate_limited" });
  });

  it("fails, counting no cap, when GitHub fails with a 5xx", async () => {
    const answers = await inRegistry(async ({ reports, github }) => {
      github.script.create = () => Response.json({ message: "Server Error" }, { status: 503 });

      const failed = await reports.file(report("s1", 1));

      github.script.create = () => created(1, ["cloudpid-report", "needs-triage"]);

      return [
        failed,
        await reports.file(report("s1", 2)),
        await reports.file(report("s1", 3)),
        await reports.file(report("s1", 4)),
      ];
    });

    expect(answers.map((answer) => answer.status)).toEqual(["failed", "filed", "filed", "filed"]);
  });

  it("fails with a warning to install the GitHub App when it is not installed on cloudpid's owner", async () => {
    const { answer, seen } = await inRegistry(async ({ reports, github, installed }) => {
      installed.value = false;

      return { answer: await reports.file(report("s1", 1)), seen: github.seen };
    });

    expect(answer).toMatchObject({ status: "failed" });
    expect(answer.status === "failed" ? answer.warning : undefined).toBeDefined();
    expect(seen).toEqual([]);
  });

  it("drops a token GitHub refused, and fails counting no cap", async () => {
    const { answer, invalidated } = await inRegistry(async ({ reports, github, invalidated }) => {
      github.script.label = () => Response.json({ message: "Bad credentials" }, { status: 401 });

      return { answer: await reports.file(report("s1", 1)), invalidated };
    });

    expect(answer).toMatchObject({ status: "failed" });
    expect(invalidated).toEqual(["ghs_report"]);
  });

  it("posts at least a second after the last post", async () => {
    const waits = await inRegistry(async ({ reports, clock, waits }) => {
      await reports.file(report("s1", 1));
      clock.now += 200;
      await reports.file(report("s1", 2));

      return waits;
    });

    expect(waits).toEqual([800]);
  });

  it("forgets reports after 30 days, so they count no more", async () => {
    const answers = await inRegistry(async ({ reports, clock }) => {
      await reports.file(report("s1", 1));
      await reports.file(report("s1", 2));
      await reports.file(report("s1", 3));

      clock.now += 30 * DAY + 1;

      return [await reports.file(report("s1", 4)), await reports.file(report("s1", 1))];
    });

    expect(answers.map((answer) => answer.status)).toEqual(["filed", "filed"]);
  });
});

describe("the Registry's agentFileReport", () => {
  it("refuses a report naming an Environment's Repo before it reaches GitHub", async () => {
    const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

    const answer = await runInDurableObject(stub, async (registry: RealRegistry) => {
      const made = await registry.call("createEnvironment", { name: "Acme" });

      if (made.status !== "named") throw new Error("no Environment");

      await registry.call("addRepo", {
        environment: made.environment.id,
        name: "acme-portal",
        url: "https://github.com/spiritledsoftware/acme-portal.git",
      });

      return registry.call("agentFileReport", {
        ...report("s1", 1),
        title: "acme-portal's tests hang in bash",
      });
    });

    expect(answer).toMatchObject({ status: "refused", code: "names" });
  });
});
