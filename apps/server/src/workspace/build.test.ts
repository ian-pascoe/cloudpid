// An Environment's Build (docs/architecture/container.md → Builds): the Build's object, its Container a fake shell that answers each step's
// script, its storage and alarm in memory. The scripts themselves run for real in `@cloudpid/sandbox-image`'s tests.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off newPromise:off
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import { describe, expect, it, vi } from "vitest";
import type { HeldSecrets } from "./environment-secrets.ts";
import { type BuildRequest, buildKey, type EnvironmentBuild } from "./build-record.ts";
import {
  BUILD_ATTEMPTS,
  BUILD_REFRESH_MS,
  BuildRunner,
  CHECK_RESUME_MS,
  type StoredBuilds,
} from "./build.ts";
import type { ScriptRun } from "./prepare.ts";
import type { RemoteHeadsAnswer } from "./remote-heads.ts";

const TOKEN = "ghp_build_token";

const DAY = 24 * 60 * 60_000;

const request = (overrides: Partial<BuildRequest> = {}): BuildRequest => ({
  key: "key-1",
  repos: [
    { name: "app", url: "https://github.com/acme/app.git" },
    { name: "api", url: "https://github.com/acme/api.git" },
  ],
  settings: {
    variables: { NODE_ENV: "development" },
    setupScript: "docker pull postgres",
    startScript: "docker compose up -d",
    idleMinutes: 30,
    toolchains: '[tools]\nnode = "22.20.0"\n',
  },
  ...overrides,
});

/** What a step's script is, from what it holds. */
const stepOf = (script: string): string => {
  if (script.includes("core.hooksPath=/dev/null clone")) return "clone";

  if (script.includes("/var/lib/cloudpid/environment/setup.sh")) return "environment-setup";

  const repo = /\/var\/tmp\/cloudpid-build\/([^/']+)\/\.cloudpid\/setup\.sh/.exec(script);

  if (repo !== null) return `setup:${repo[1]}`;

  if (script.includes("rev-parse --quiet --verify HEAD")) return "commits";

  if (script.includes("kill -TERM")) return "cleanup";

  return "other";
};

/** What the fake object holds and saw. */
type Fake = {
  stored: StoredBuilds | undefined;
  now: number;
  wakes: number[];
  handedOver: unknown[];
  steps: string[];
  scripts: string[];
  /** The environment each step ran with, beside the Container's own. */
  envs: Array<Readonly<Record<string, string>> | undefined>;
  /** The Environment's Secrets the object holds. */
  held: HeldSecrets;
  /** Holds the clone until it resolves. */
  gate: Promise<void> | undefined;
  /** What the remotes answer to the daily look; the repos' heads the Build recorded by default. */
  remote: RemoteHeadsAnswer;
  /** The Repos each look asked about. */
  asked: string[][];
  /** What a step answers, by step; anything else exits 0. */
  answers: Partial<Record<string, ScriptRun>>;
  snapshot:
    | {
        ok: true;
        snapshot: { id: string; size: number };
        image: string;
        ignore: string[] | undefined;
      }
    | { ok: false; reason: string };
  snapshots: number;
  stops: number;
  holds: number;
  ids: number;
  infos: string[];
  warnings: string[];
};

const open = (enabled = true) => {
  const fake: Fake = {
    stored: undefined,
    now: 1_000_000,
    wakes: [],
    handedOver: [],
    steps: [],
    scripts: [],
    envs: [],
    held: { ok: true, secrets: [] },
    gate: undefined,
    remote: { ok: true, heads: { app: "aaa", api: "bbb" } },
    asked: [],
    answers: {},
    snapshot: {
      ok: true,
      snapshot: { id: "snap-1", size: 2e9 },
      image: "img-1",
      ignore: ["**/node_modules"],
    },
    snapshots: 0,
    stops: 0,
    holds: 0,
    ids: 0,
    infos: [],
    warnings: [],
  };

  const runner = () =>
    new BuildRunner({
      enabled,
      load: async () => fake.stored,
      save: async (stored) => {
        fake.stored = stored;
      },
      wake: async (at) => {
        fake.wakes.push(at);
      },
      image: () => "img-1",
      handOver: async (overrides) => {
        fake.handedOver.push(overrides);
      },
      heads: async (repos) => {
        fake.steps.push("heads");
        fake.asked.push(repos.map((repo) => repo.name));

        return fake.remote;
      },
      secrets: async () => fake.held,
      run: async (script, _timeout, env) => {
        const step = stepOf(script);

        fake.steps.push(step);
        fake.scripts.push(script);
        fake.envs.push(env);

        if (step === "clone") await fake.gate;

        return fake.answers[step] ?? { exitCode: 0, output: "" };
      },
      snapshot: async () => {
        fake.steps.push("snapshot");
        fake.snapshots++;

        return fake.snapshot;
      },
      stop: async () => {
        fake.steps.push("stop");
        fake.stops++;
      },
      idle: {
        begin: async () => {
          fake.holds++;
        },
        end: async () => {
          fake.holds--;
        },
      },
      redact: (text) => text.replaceAll(TOKEN, "***"),
      newId: () => `run-${++fake.ids}`,
      now: () => fake.now,
      info: (message) => fake.infos.push(message),
      warn: (message) => fake.warnings.push(message),
    });

  const builds = runner();

  /** Run the alarm and wait for the Build it began to end. */
  const build = async (on: BuildRunner = builds) => {
    const before = fake.stored?.attemptedAt ?? null;

    await on.alarm();
    await vi.waitFor(() => {
      expect(fake.stored?.attemptedAt ?? null).not.toBe(before);
    });
  };

  return { fake, builds, runner, build };
};

const GOOD_COMMITS = {
  commits: { exitCode: 0, output: "cloudpid-commit app aaa\ncloudpid-commit api bbb\n" },
};

describe("a Build", () => {
  it("is begun at the next alarm, which it wakes, and shows as building meanwhile", async () => {
    const { fake, builds } = open();

    const state = await builds.request(request());

    expect(fake.wakes).toEqual([fake.now]);
    expect(fake.steps).toEqual([]);
    expect(state).toMatchObject({
      image: "img-1",
      last: null,
      progress: { status: "building", key: "key-1", startedAt: fake.now },
    });
    expect(await builds.alarmAt(fake.now + 60_000)).toBe(fake.now);
  });

  it("hands over the settings without the scripts, the Toolchains its bootstrap installs included, clones, runs the environment's then each repo's Setup Script, reads the commits, cleans up, snapshots and stops", async () => {
    const { fake, builds, build } = open();

    fake.answers = GOOD_COMMITS;
    await builds.request(request());
    fake.now += 5_000;
    await build();

    expect(fake.handedOver).toEqual([
      {
        variables: { NODE_ENV: "development" },
        idleMinutes: 30,
        toolchains: '[tools]\nnode = "22.20.0"\n',
      },
    ]);
    expect(fake.steps).toEqual([
      "clone",
      "environment-setup",
      "setup:app",
      "setup:api",
      "commits",
      "cleanup",
      "snapshot",
      "stop",
    ]);
    // Every step a script runs in carries the run's tag, which the clean-up stops by.
    expect(fake.scripts[0]).toContain("export CLOUDPID_BUILD_RUN='run-1'");
    expect(fake.scripts[1]).toContain(btoa("docker pull postgres"));
    expect(fake.scripts[5]).toContain("CLOUDPID_BUILD_RUN=run-1");

    const last: EnvironmentBuild = {
      key: "key-1",
      snapshot: { id: "snap-1", size: 2e9 },
      image: "img-1",
      ignore: ["**/node_modules"],
      commits: { app: "aaa", api: "bbb" },
      finishedAt: fake.now,
    };

    expect(await builds.state()).toEqual({
      image: "img-1",
      last,
      progress: null,
      attemptedAt: fake.now,
    });
    expect(fake.holds).toBe(0);
    expect(await builds.isBuild()).toBe(true);
  });

  it("gives the Setup Scripts the Secrets marked for the Build, as their Session references, and no step the others", async () => {
    const { fake, builds, build } = open();

    const secret = (name: string, value: string, flag: boolean): KeptSecret => ({
      name,
      value,
      scope: "environment",
      build: flag,
    });

    fake.answers = GOOD_COMMITS;
    fake.held = {
      ok: true,
      secrets: [
        secret("NPM_TOKEN", "npm_0123456789", true),
        secret("API_KEY", "sk-live-0123", false),
      ],
    };
    await builds.request(request());
    await build();

    const byStep = Object.fromEntries(fake.steps.map((step, index) => [step, fake.envs[index]]));
    const forBuild = { ["PI_SECRET_" + "NPM_TOKEN"]: "npm_0123456789" };

    expect(byStep["environment-setup"]).toEqual(forBuild);
    expect(byStep["setup:app"]).toEqual(forBuild);
    expect(byStep["clone"]).toBeUndefined();
    expect(byStep["commits"]).toBeUndefined();
    expect(JSON.stringify(fake.envs)).not.toContain("sk-live-0123");
    // Not in a script's text, nor anything the object stores.
    expect(fake.scripts.join("\n")).not.toContain("npm_0123456789");
    expect(JSON.stringify(fake.stored)).not.toContain("npm_0123456789");
  });

  it("fails, keeping the last good one, while the object cannot show the Environment's Secrets", async () => {
    const { fake, builds, build } = open();

    fake.held = { ok: false, reason: "the Environment's Secrets NPM_TOKEN are not held here" };
    await builds.request(request());
    await build();

    expect(fake.steps).toEqual(["stop"]);
    expect((await builds.state()).progress).toMatchObject({
      status: "failed",
      reason: "the Environment's Secrets NPM_TOKEN are not held here",
    });
  });

  it("fails at once where the Container takes no snapshots (alchemy dev)", async () => {
    const { fake, builds } = open(false);

    expect((await builds.request(request())).progress).toMatchObject({
      status: "failed",
      key: "key-1",
    });
    expect(fake.wakes).toEqual([]);
  });

  it("runs no Environment Setup Script when it has none", async () => {
    const { fake, builds, build } = open();

    await builds.request(request({ settings: {} }));
    await build();

    expect(fake.steps).not.toContain("environment-setup");
  });

  it("fails at the first step that fails, with its output's end and without the token, keeping the last good Build and stopping the Container", async () => {
    const { fake, builds, build } = open();

    fake.answers = GOOD_COMMITS;
    await builds.request(request());
    await build();

    const good = (await builds.state()).last;

    fake.answers = {
      ...GOOD_COMMITS,
      "setup:app": { exitCode: 1, output: `npm ERR! 401 with ${TOKEN}\n` },
    };
    fake.now += DAY;
    await builds.request(request({ key: "key-2" }));
    fake.steps = [];
    await build();

    expect(fake.steps).toEqual(["clone", "environment-setup", "setup:app", "stop"]);

    const state = await builds.state();

    expect(state.last).toEqual(good);
    expect(state.progress).toEqual({
      status: "failed",
      key: "key-2",
      reason: "The Setup Script app/.cloudpid/setup.sh failed (exit 1): npm ERR! 401 with ***",
      at: fake.now,
    });
    expect(fake.warnings.join("\n")).not.toContain(TOKEN);
  });

  it("fails when the snapshot is not taken, saying why", async () => {
    const { fake, builds, build } = open();

    fake.snapshot = { ok: false, reason: "the GitHub token is in /root/.netrc" };
    await builds.request(request());
    await build();

    expect((await builds.state()).progress).toMatchObject({
      status: "failed",
      reason: "The snapshot was not taken: the GitHub token is in /root/.netrc",
    });
    expect(fake.stops).toBe(1);
  });

  it("leaves a Build of the same key alone, and runs another key's once the one under way has ended", async () => {
    const { fake, builds } = open();
    let release: () => void = () => undefined;

    fake.answers = GOOD_COMMITS;
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await builds.request(request());
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.steps).toEqual(["clone"]);
    });

    await builds.request(request());
    expect(fake.wakes).toHaveLength(1);

    await builds.request(request({ key: "key-2" }));
    expect((await builds.state()).progress).toMatchObject({ status: "building", key: "key-2" });

    // One Build at a time: the alarm the request set leaves the one under way alone.
    await builds.alarm();
    expect(fake.steps).toEqual(["clone"]);

    release();
    await vi.waitFor(() => {
      expect(fake.stored?.last?.key).toBe("key-1");
    });
    // Its end keeps the newer request, which shows, and wakes the object for it.
    expect(fake.stored?.progress).toMatchObject({ status: "building", key: "key-2" });
    expect(fake.wakes).toHaveLength(3);

    fake.gate = undefined;
    await vi.waitFor(async () => {
      await builds.alarm();
      expect(fake.stored?.last?.key).toBe("key-2");
    });
    expect(fake.stored?.progress).toBeNull();
    expect(fake.stored?.pending).toBeNull();
  });
});

describe("the daily look at the default branches", () => {
  const built = async () => {
    const opened = open();

    opened.fake.answers = GOOD_COMMITS;
    await opened.builds.request(request());
    await opened.build();
    opened.fake.steps = [];

    return opened;
  };

  it("notes that it looked, and builds nothing, when no default branch moved", async () => {
    const { fake, builds, build } = await built();
    const last = (await builds.state()).last;

    fake.remote = { ok: true, heads: { app: "aaa", api: "bbb" } };
    fake.now += DAY;
    expect((await builds.request(request({ check: true }))).progress).toMatchObject({
      status: "checking",
    });
    await build();

    // Only the remotes were asked: the Container was neither held, started nor stopped.
    expect(fake.steps).toEqual(["heads"]);
    expect(fake.asked).toEqual([["app", "api"]]);
    expect(fake.holds).toBe(0);
    expect(fake.handedOver).toHaveLength(1);
    expect(await builds.state()).toEqual({
      image: "img-1",
      last,
      progress: null,
      attemptedAt: fake.now,
    });
  });

  it("builds again when a default branch moved", async () => {
    const { fake, builds, build } = await built();

    fake.remote = { ok: true, heads: { app: "ccc", api: "bbb" } };
    fake.now += DAY;
    await builds.request(request({ check: true }));
    await build();

    expect(fake.steps[0]).toBe("heads");
    expect(fake.steps).toContain("snapshot");
    expect((await builds.state()).last?.finishedAt).toBe(fake.now);
  });

  it("keeps the Build and tries again at the next look when a remote cannot be asked, with no Container", async () => {
    const { fake, builds, build } = await built();
    const last = (await builds.state()).last;

    fake.remote = { ok: false, reason: "GitHub answered 502 asking for acme/app's default branch" };
    fake.now += DAY;
    await builds.request(request({ check: true }));
    await build();

    expect(fake.steps).toEqual(["heads"]);
    expect(fake.holds).toBe(0);
    expect(fake.warnings).toEqual([expect.stringContaining("answered 502")]);
    expect(await builds.state()).toMatchObject({
      last,
      progress: {
        status: "failed",
        key: "key-1",
        reason: expect.stringContaining("answered 502"),
      },
      attemptedAt: fake.now,
    });
    // The next look is due a day after this attempt, as a failed Build is tried again.
    expect(fake.stored?.pending).toBeNull();
  });

  it("sets an alarm that begins the look again, should the object be evicted before it ends", async () => {
    const { fake, builds, build } = await built();

    fake.wakes = [];
    fake.now += DAY;
    await builds.request(request({ check: true }));
    await build();

    expect(fake.wakes).toEqual([fake.now, fake.now + CHECK_RESUME_MS]);
  });

  it("builds nothing for a Repo with no commits yet that still has none", async () => {
    const { fake, builds, build } = open();

    fake.answers = {
      commits: { exitCode: 0, output: "cloudpid-commit app -\ncloudpid-commit api bbb\n" },
    };
    await builds.request(request());
    await build();
    fake.steps = [];
    fake.remote = { ok: true, heads: { app: null, api: "bbb" } };
    fake.now += DAY;
    await builds.request(request({ check: true }));
    await build();

    expect(fake.steps).toEqual(["heads"]);
  });

  it("builds again without looking when the last Build is old", async () => {
    const { fake, builds, build } = await built();

    fake.now += BUILD_REFRESH_MS + DAY;
    await builds.request(request({ check: true }));
    await build();

    expect(fake.asked).toEqual([]);
    expect(fake.steps[0]).toBe("clone");
  });

  it("does not replace a Build of the key that is under way", async () => {
    const { fake, builds } = open();

    await builds.request(request());
    await builds.request(request({ check: true }));

    expect(fake.stored?.pending?.check).toBeUndefined();
    expect(fake.stored?.progress).toMatchObject({ status: "building" });
  });
});

describe("a Build the platform cut off", () => {
  const lost = {
    exitCode: null,
    output: "Error: WritableStream RPC stub was disposed without calling close()",
    lost: true,
  } as const;

  it("is begun again from the start at the next alarm, which it wakes, and not failed", async () => {
    const { fake, builds } = open();

    fake.answers = { ...GOOD_COMMITS, "setup:app": lost };
    await builds.request(request());
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.wakes).toHaveLength(2);
    });

    expect(fake.stops).toBe(1);
    expect(fake.stored?.progress).toMatchObject({ status: "building", key: "key-1" });
    expect(fake.stored?.pending).toMatchObject({ id: "run-1", attempts: 1 });
    expect(fake.warnings.join("\n")).toContain(
      "The Setup Script app/.cloudpid/setup.sh was cut off by the platform, not by the script",
    );

    // The platform is back: the next alarm begins it again, from the clone.
    fake.answers = GOOD_COMMITS;
    fake.steps = [];
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.stored?.last?.key).toBe("key-1");
    });

    expect(fake.steps[0]).toBe("clone");
    expect(fake.stored?.progress).toBeNull();
  });

  it("fails saying the platform cut it off once its attempts are spent", async () => {
    const { fake, builds } = open();

    fake.answers = { ...GOOD_COMMITS, clone: lost };
    await builds.request(request());

    // Each attempt but the last wakes the object for the next.
    for (let attempt = 1; attempt < BUILD_ATTEMPTS; attempt++) {
      await builds.alarm();
      await vi.waitFor(() => {
        expect(fake.wakes).toHaveLength(attempt + 1);
      });
    }

    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.stored?.progress).toMatchObject({ status: "failed" });
    });
    expect(fake.stops).toBe(BUILD_ATTEMPTS);
    expect(fake.stored?.progress).toMatchObject({
      reason:
        "Cloning the repos was cut off by the platform, not by the script: the connection to the Container broke (Error: WritableStream RPC stub was disposed without calling close())",
    });
    expect(fake.stored?.pending).toBeNull();
  });

  it("fails a Test Build as a script's failure when the script itself did not finish", async () => {
    const { fake, builds } = open();

    fake.answers = {
      ...GOOD_COMMITS,
      "setup:app": { exitCode: null, output: "it ran past 30 minutes" },
    };
    await builds.request(request({ key: "key-test", test: "s-1/7" }));
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.stored?.test?.status).toBe("failed");
    });

    expect(fake.stored?.test).toMatchObject({
      reason:
        "The Setup Script app/.cloudpid/setup.sh failed (it did not finish): it ran past 30 minutes",
    });
  });

  it("begins a Test Build again too, and leaves one cancelled meanwhile cancelled", async () => {
    const { fake, builds } = open();

    fake.answers = { ...GOOD_COMMITS, "setup:app": lost };
    await builds.request(request({ key: "key-test", test: "s-1/7" }));
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.wakes).toHaveLength(2);
    });

    expect(fake.stored?.test?.status).toBe("building");

    await builds.cancel("s-1/7");
    fake.steps = [];
    await builds.alarm();

    expect(fake.steps).toEqual([]);
    expect(fake.stored?.test?.status).toBe("cancelled");
  });
});

describe("a Build cut off by an eviction", () => {
  it("is begun again at the next alarm, a few times at most, then reported as failed", async () => {
    const { fake, builds } = open();

    await builds.request(request());

    // Each object is evicted after its alarm began the Build: the next one finds the request still waiting.
    const stored = fake.stored;
    const pending = stored?.pending;

    if (stored === undefined || pending == null) throw new Error("Expected a waiting request");

    fake.stored = { ...stored, pending: { ...pending, attempts: BUILD_ATTEMPTS } };
    await builds.alarm();

    expect(fake.steps).toEqual([]);
    expect(fake.stored?.pending).toBeNull();
    expect(fake.stored?.progress).toMatchObject({ status: "failed", key: "key-1" });
  });
});

describe("a Test Build", () => {
  const test = (overrides: Partial<BuildRequest> = {}) =>
    request({ key: "key-test", test: "s-1/7", ...overrides });

  /** Run the alarm and wait for the Test Build it began to end. */
  const ended = async (builds: BuildRunner, fake: Fake) => {
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.stored?.test?.status).not.toBe("building");
    });
  };

  it("is made as a Build is, and answers its outcome without recording it as the last good Build", async () => {
    const { fake, builds } = open();

    fake.answers = GOOD_COMMITS;

    const started = await builds.request(test());

    expect(started.test).toEqual({
      id: "s-1/7",
      status: "building",
      key: "key-test",
      startedAt: fake.now,
    });
    expect(started.progress).toBeNull();
    expect(fake.wakes).toEqual([fake.now]);

    const startedAt = fake.now;

    fake.now += 90_000;
    await ended(builds, fake);

    expect(fake.steps).toEqual([
      "clone",
      "environment-setup",
      "setup:app",
      "setup:api",
      "commits",
      "cleanup",
      "stop",
    ]);
    // Its result is never kept, so it takes no snapshot, and no snapshot's scan can fail it.
    expect(fake.snapshots).toBe(0);

    const state = await builds.state();

    expect(state.last).toBeNull();
    expect(state.progress).toBeNull();
    expect(state.test).toEqual({
      id: "s-1/7",
      status: "succeeded",
      key: "key-test",
      startedAt,
      finishedAt: fake.now,
    });
    expect(fake.stored?.pending).toBeNull();
    expect(fake.holds).toBe(0);
  });

  it("fails with the failing script's output, redacted, and leaves the last good Build as it was", async () => {
    const { fake, builds, build } = open();

    fake.answers = GOOD_COMMITS;
    await builds.request(request());
    await build();

    const before = await builds.state();

    fake.answers = {
      ...GOOD_COMMITS,
      "environment-setup": { exitCode: 1, output: `apt: not found ${TOKEN}\n` },
    };
    fake.steps = [];
    await builds.request(test({ settings: { setupScript: "apt install nothing" } }));
    await ended(builds, fake);

    expect(fake.steps).toEqual(["clone", "environment-setup", "stop"]);

    const state = await builds.state();

    expect(state.test).toMatchObject({
      status: "failed",
      reason: "The environment's Setup Script failed (exit 1): apt: not found ***",
    });
    expect(state.last).toEqual(before.last);
    expect(state.progress).toEqual(before.progress);
    expect(state.attemptedAt).toBe(before.attemptedAt);
  });

  it("is found again by a request of the same id, and refuses another while it runs", async () => {
    const { fake, builds } = open();

    fake.gate = new Promise<void>(() => undefined);
    await builds.request(test());
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.steps).toEqual(["clone"]);
    });

    // The rerun of the same call: the same Test Build, not another.
    expect((await builds.request(test())).test).toMatchObject({
      id: "s-1/7",
      status: "building",
    });

    const other = await builds.request(test({ test: "s-2/3", key: "key-other" }));

    expect(other.test).toMatchObject({ id: "s-1/7", status: "building" });
    expect(fake.stored?.pending?.test).toBe("s-1/7");
    expect(fake.wakes).toHaveLength(1);
  });

  it("answers a finished one to the rerun of its call", async () => {
    const { fake, builds } = open();

    fake.answers = GOOD_COMMITS;
    await builds.request(test());
    await ended(builds, fake);
    fake.steps = [];

    expect((await builds.request(test())).test).toMatchObject({
      id: "s-1/7",
      status: "succeeded",
    });
    expect(fake.steps).toEqual([]);
    expect(fake.stored?.pending).toBeNull();
  });

  it("is stopped by a cancel: the Container stops, no step runs after it, and the next one may begin", async () => {
    const { fake, builds } = open();
    let release: () => void = () => undefined;

    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await builds.request(test());
    await builds.alarm();
    await vi.waitFor(() => {
      expect(fake.steps).toEqual(["clone"]);
    });

    const cancelled = await builds.cancel("s-1/7");

    expect(cancelled.test).toMatchObject({ id: "s-1/7", status: "cancelled" });
    expect(fake.steps).toEqual(["clone", "stop"]);

    // The clone answers after the stop: no later step runs.
    release();
    await vi.waitFor(() => {
      expect(fake.holds).toBe(0);
    });
    expect(fake.steps).toEqual(["clone", "stop", "stop"]);
    expect(fake.stored?.test).toMatchObject({ status: "cancelled" });

    fake.gate = undefined;
    fake.steps = [];
    await builds.request(test({ test: "s-1/8" }));
    await ended(builds, fake);
    expect(fake.stored?.test).toMatchObject({ id: "s-1/8", status: "succeeded" });
  });

  it("is cancelled before it begins without a step", async () => {
    const { fake, builds } = open();

    await builds.request(test());
    await builds.cancel("s-1/7");
    await builds.alarm();

    expect(fake.steps).toEqual([]);
    expect(fake.stored?.pending).toBeNull();
    expect(fake.stored?.test).toMatchObject({ status: "cancelled" });
  });

  it("ignores a cancel of another id", async () => {
    const { fake, builds } = open();

    await builds.request(test());
    await builds.cancel("s-2/3");

    expect(fake.stored?.test).toMatchObject({ id: "s-1/7", status: "building" });
    expect(fake.stored?.pending?.test).toBe("s-1/7");
  });

  it("cut off by evictions too often is reported as failed", async () => {
    const { fake, builds } = open();

    await builds.request(test());

    const stored = fake.stored;
    const pending = stored?.pending;

    if (stored === undefined || pending == null) throw new Error("Expected a waiting request");

    fake.stored = { ...stored, pending: { ...pending, attempts: BUILD_ATTEMPTS } };
    await builds.alarm();

    expect(fake.steps).toEqual([]);
    expect(fake.stored?.pending).toBeNull();
    expect(fake.stored?.progress).toBeNull();
    expect(fake.stored?.test).toMatchObject({ status: "failed", id: "s-1/7" });
  });

  it("fails at once where the Container takes no snapshots (alchemy dev)", async () => {
    const { fake, builds } = open(false);

    expect((await builds.request(test())).test).toMatchObject({
      id: "s-1/7",
      status: "failed",
    });
    expect(fake.stored?.progress).toBeNull();
    expect(fake.wakes).toEqual([]);
  });
});

describe("a Build's key", () => {
  const repos = [
    { name: "app", url: "https://github.com/acme/app.git" },
    { name: "api", url: "https://github.com/acme/api.git" },
  ];

  const settings = {
    variables: { A: "1", B: "2" },
    setupScript: "docker pull postgres",
    ignore: ["/data"],
  };

  const key = (overrides: Partial<Parameters<typeof buildKey>[0]> = {}) =>
    buildKey({ repos, settings, image: "img-1", ...overrides });

  it("is the same for the same Repos and variables in another order", async () => {
    expect(
      await key({
        repos: repos.toReversed(),
        settings: { ...settings, variables: { B: "2", A: "1" } },
      }),
    ).toBe(await key());
  });

  it("changes with a Repo, a variable, the Setup Script, the Container-only paths or the image", async () => {
    const base = await key();

    const others = await Promise.all([
      key({ repos: [...repos, { name: "web", url: "https://github.com/acme/web.git" }] }),
      key({
        repos: repos.map((repo) =>
          repo.name === "app" ? { ...repo, url: "https://github.com/acme/other.git" } : repo,
        ),
      }),
      key({ settings: { ...settings, variables: { A: "1", B: "3" } } }),
      key({ settings: { ...settings, setupScript: "" } }),
      key({ settings: { ...settings, ignore: [] } }),
      key({ image: "img-2" }),
    ]);

    for (const other of others) expect(other).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });

  it("changes with the Toolchains, and is the one it was without any", async () => {
    const base = await key();

    expect(await key({ settings: { ...settings, toolchains: "" } })).toBe(base);

    const withToolchains = await key({
      settings: { ...settings, toolchains: '[tools]\nnode = "22"\n' },
    });

    expect(withToolchains).not.toBe(base);
    expect(await key({ settings: { ...settings, toolchains: "[tools]\n" } })).not.toBe(
      withToolchains,
    );
  });

  it("changes with the digest of the Secrets a Build gets, and is the one it was without any", async () => {
    const base = await key();

    expect(await key({ secrets: null })).toBe(base);

    const withSecrets = await key({ secrets: "a".repeat(64) });

    expect(withSecrets).not.toBe(base);
    expect(await key({ secrets: "b".repeat(64) })).not.toBe(withSecrets);
  });

  it("does not change with what a Build does not use: the size, the idle time, the Start Script", async () => {
    expect(
      await key({
        // What a caller may hand over beyond what the key reads.
        settings: Object.assign(
          { instance: "standard-4", idleMinutes: 60, startScript: "x" },
          settings,
        ),
      }),
    ).toBe(await key());
  });
});
