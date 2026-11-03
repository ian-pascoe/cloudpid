/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- a fake backend is cut down to what a case reads. */
// docs/architecture/mcp-endpoint.md → The `api` target, Limits and errors: the service over a fake Registry and Sessions.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off missedPipeableOpportunity:off
import {
  apiFailure,
  DEFAULT_ENVIRONMENT,
  type EnvironmentRecord,
  type SessionRecord,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import type { SessionRefusal } from "../registry/store.ts";
import {
  MCP_CALLS_PERIOD_S,
  identityOf,
  mcpApiService,
  type McpApiContext,
  type McpBackend,
} from "./api.ts";

const ORIGIN = "https://cloudpid.test";
const ID = "0190f0a8-1b2c-7d3e-8f40-123456789abc";
const OTHER_ID = "0190f0a8-1b2c-7d3e-8f40-123456789abd";

const environment = (id: string, name: string): EnvironmentRecord => ({
  id,
  name,
  repos: [{ name: "app", url: "https://github.com/a/app" }],
  createdAt: 1,
});

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: ID,
  title: "Fix the thing",
  titleSource: "owner",
  environment: DEFAULT_ENVIRONMENT,
  workspace: "abcd1234",
  status: "idle",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  archivedAt: null,
  ...overrides,
});

const backend = (overrides: Partial<McpBackend> = {}): McpBackend => ({
  environments: Effect.succeed([
    environment(DEFAULT_ENVIRONMENT, "Default"),
    environment("e2", "Docs"),
  ]),
  allSessions: Effect.succeed([record({ status: "running" }), record({ id: OTHER_ID })]),
  sessions: () => Effect.succeed({ sessions: [record()] }),
  session: () => Effect.succeed(record()),
  workspace: () =>
    Effect.succeed({
      id: "abcd1234",
      environment: DEFAULT_ENVIRONMENT,
      branch: "cloudpid/abcd1234",
      base: null,
      repos: ["app"],
      directory: "/workspace/app",
      createdAt: 1,
    }),
  defaultModel: Effect.succeed("anthropic/claude-opus"),
  status: () =>
    Effect.succeed({
      ok: true as const,
      value: {
        status: "waiting_for_owner" as const,
        waiting: [
          {
            kind: "approval" as const,
            request_id: "r1",
            agent_id: "root",
            summary: "Which one?",
            since: 1,
            url: `/sessions/${ID}?request=r1`,
          },
        ],
        cursor: "c1",
      },
    }),
  transcript: () => Effect.succeed({ ok: true as const, value: { entries: [], newer: "n1" } }),
  createSession: ({ environment, title }) =>
    Effect.succeed(record({ title: title ?? null, environment })),
  configure: () => Effect.succeed({ ok: true as const, value: null }),
  submit: () =>
    Effect.succeed({
      ok: true as const,
      value: { delivery: "started" as const, cursor: "c-sent" },
    }),
  stop: () => Effect.succeed({ ok: true as const, value: { status: "idle" as const } }),
  ...overrides,
});

const service = (overrides: Partial<McpBackend> = {}, context: Partial<McpApiContext> = {}) =>
  mcpApiService(backend(overrides), {
    origin: ORIGIN,
    caller: { kind: "owner" },
    withinRate: () => Effect.succeed(true),
    ...context,
  });

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

describe("describe", () => {
  it("reports Server's deploy id when it has one, and none otherwise", () => {
    expect(service({}, { version: "v-123" }).describe().version).toBe("v-123");
    expect(service().describe().version).toBeUndefined();
  });

  it("lists the read operations and the three that start, send and stop, and no others", () => {
    expect(service().describe().operations).toEqual([
      "environments",
      "sessions",
      "session",
      "transcript",
      "start",
      "send",
      "stop",
    ]);
  });
});

describe("environments", () => {
  it("lists the default first, with repos, running counts, and the models", async () => {
    const result = await run(
      service({
        environments: Effect.succeed([
          environment("e2", "Docs"),
          environment(DEFAULT_ENVIRONMENT, "Default"),
        ]),
      }).environments,
    );

    expect(
      result.ok && result.value.environments.map((e) => [e.id, e.default, e.running_sessions]),
    ).toEqual([
      [DEFAULT_ENVIRONMENT, true, 1],
      ["e2", false, 0],
    ]);
    expect(result.ok && result.value.models.default).toBe("anthropic/claude-opus");
    expect(result.ok && result.value.models.available.length).toBeGreaterThan(0);
  });

  it("still lists when the default model cannot be read", async () => {
    const result = await run(service({ defaultModel: Effect.die("no settings") }).environments);

    expect(result.ok && result.value.models.default).toBeUndefined();
  });

  it("is unavailable when the Registry fails", async () => {
    const result = await run(service({ environments: Effect.die("boom") }).environments);

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
  });
});

describe("sessions", () => {
  it("summarises a page with absolute urls, and passes the cursor on", async () => {
    const sessions = vi.fn(() =>
      Effect.succeed({ sessions: [record({ archivedAt: 5 })], nextCursor: "next" }),
    );

    const result = await run(service({ sessions }).sessions({ limit: 5 }));

    expect(result).toEqual({
      ok: true,
      value: {
        sessions: [
          {
            session_id: ID,
            title: "Fix the thing",
            environment: { id: DEFAULT_ENVIRONMENT, name: "Default" },
            status: "idle",
            updated_at: "2023-11-14T22:15:00.000Z",
            archived: true,
            url: `${ORIGIN}/sessions/${ID}`,
          },
        ],
        next_cursor: "next",
      },
    });
    expect(sessions).toHaveBeenCalledWith({ limit: 5 });
  });

  it("resolves an Environment by id, or by name in any case", async () => {
    const sessions = vi.fn(() => Effect.succeed({ sessions: [] }));
    const api = service({ sessions });

    await run(api.sessions({ environment: "e2" }));
    await run(api.sessions({ environment: " DOCS " }));

    expect(sessions.mock.calls).toEqual([[{ environment: "e2" }], [{ environment: "e2" }]]);
  });

  it("refuses an Environment that is not there, or whose name is not unique", async () => {
    const none = await run(service().sessions({ environment: "nope" }));

    const twice = await run(
      service({
        environments: Effect.succeed([environment("e1", "Same"), environment("e2", "same")]),
      }).sessions({ environment: "SAME" }),
    );

    expect(none).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(twice).toMatchObject({
      ok: false,
      error: { code: "ambiguous_environment", details: { ids: ["e1", "e2"] } },
    });
  });

  it("says a cursor that is not one is invalid", async () => {
    const result = await run(
      service({ sessions: () => Effect.succeed({ refused: "invalid_cursor" as const }) }).sessions({
        cursor: "x",
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
  });

  it("shows where a Session came from, the marks first", async () => {
    const result = await run(
      service({
        sessions: () =>
          Effect.succeed({
            sessions: [
              record({
                marks: { kind: "mcp", client: { name: "claude-code" }, auth: "service_token" },
              }),
              record({ id: OTHER_ID, origin: { kind: "fork", session: ID } }),
            ],
          }),
      }).sessions({}),
    );

    expect(result.ok && result.value.sessions.map((s) => s.origin)).toEqual([
      { kind: "mcp", client: { name: "claude-code" }, auth: "service_token" },
      { kind: "fork", session: ID },
    ]);
  });
});

describe("session", () => {
  it("composes the listing fields, the Session's report, its agents and its Workspace", async () => {
    const result = await run(
      service({
        session: () =>
          Effect.succeed(
            record({
              agents: [{ id: "agent-1", parent: "root", role: "reviewer", status: "working" }],
            }),
          ),
      }).session(ID),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        session_id: ID,
        status: "waiting_for_owner",
        cursor: "c1",
        waiting: [{ request_id: "r1", url: `${ORIGIN}/sessions/${ID}?request=r1` }],
        agents: [{ agent_id: "agent-1", parent: "root", role: "reviewer", status: "working" }],
        workspace: { branch: "cloudpid/abcd1234", base: null, repos: ["app"] },
      },
    });
  });

  it("answers invalid_argument without any call for an id that is not a Session's", async () => {
    const session = vi.fn(() => Effect.succeed(null));
    const result = await run(service({ session }).session("../etc"));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(session).not.toHaveBeenCalled();
  });

  it("answers not_found for a Session the Registry does not know, without asking a Session", async () => {
    const status = vi.fn();
    const result = await run(service({ session: () => Effect.succeed(null), status }).session(ID));

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(status).not.toHaveBeenCalled();
  });

  it("passes the Session's own failure on, and is unavailable on a defect", async () => {
    const failed = await run(
      service({
        status: () =>
          Effect.succeed({
            ok: false as const,
            error: { code: "unavailable" as const, message: "asleep", retryable: true },
          }),
      }).session(ID),
    );

    const died = await run(service({ status: () => Effect.die("boom") }).session(ID));

    expect(failed).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(died).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("transcript", () => {
  it("reads the page of a Session the Registry knows, naming the Session", async () => {
    const transcript = vi.fn(() =>
      Effect.succeed({ ok: true as const, value: { entries: [], newer: "n1" } }),
    );

    const result = await run(
      service({ transcript }).transcript({ session_id: ID, detail: "full" } as never),
    );

    expect(result).toEqual({ ok: true, value: { entries: [], newer: "n1", session_id: ID } });
    expect(transcript).toHaveBeenCalledWith(ID, { detail: "full" });
  });

  it("never reaches a Session for an unknown or malformed id", async () => {
    const transcript = vi.fn();

    const unknown = await run(
      service({ session: () => Effect.succeed(null), transcript }).transcript({
        session_id: ID,
      } as never),
    );

    const malformed = await run(
      service({ transcript }).transcript({ session_id: "nope" } as never),
    );

    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(transcript).not.toHaveBeenCalled();
  });
});

const VIA = { client: { name: "claude-code", version: "2.1" }, era: "modern" as const };

describe("start", () => {
  it("marks the Session and the first input by how the caller got in, without the owner's email", async () => {
    const createSession = vi.fn(({ environment }: { environment: string }) =>
      Effect.succeed(record({ environment })),
    );

    const submit = vi.fn(backend().submit);

    const result = await run(
      service(
        { createSession, submit },
        { caller: { kind: "owner", clientId: "dcr-client-1" } },
      ).start({ text: "Fix it", via: VIA }),
    );

    expect(createSession).toHaveBeenCalledWith({
      environment: DEFAULT_ENVIRONMENT,
      marks: { kind: "mcp", auth: "oauth", client: VIA.client },
      maxRunning: 10,
    });
    expect(submit).toHaveBeenCalledWith(ID, {
      input: "Fix it",
      via: { client: VIA.client, auth: "oauth", era: "modern", clientId: "dcr-client-1" },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        session_id: ID,
        title: "Fix the thing",
        url: `${ORIGIN}/sessions/${ID}`,
        status: "waiting_for_owner",
        cursor: "c-sent",
        environment: { id: DEFAULT_ENVIRONMENT, name: "Default", repos: ["app"] },
      },
    });
    expect(JSON.stringify(createSession.mock.calls)).not.toContain("@");
  });

  it("marks a service token's and local dev's Sessions as such, and keeps no client id for them", async () => {
    const createSession = vi.fn(backend().createSession);
    const submit = vi.fn(backend().submit);

    await run(
      service(
        { createSession, submit },
        { caller: { kind: "service_token", clientId: "id.access" } },
      ).start({ text: "go", via: { era: "legacy" } }),
    );

    await run(
      service({ createSession, submit }, { caller: { kind: "local" } }).start({
        text: "go",
        via: { era: "legacy" },
      }),
    );

    expect(createSession.mock.calls.map(([input]) => input.marks)).toEqual([
      { kind: "mcp", auth: "service_token" },
      { kind: "mcp", auth: "local" },
    ]);
    expect(submit.mock.calls.map(([, input]) => input.via)).toEqual([
      { auth: "service_token", era: "legacy" },
      { auth: "local", era: "legacy" },
    ]);
  });

  it("passes a repeated request_id to the Registry and the Session, which each find the first", async () => {
    const createSession = vi.fn(backend().createSession);
    const submit = vi.fn(backend().submit);

    await run(
      service({ createSession, submit }).start({ text: "go", request_id: "req-1", via: VIA }),
    );

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req-1" }));
    expect(submit).toHaveBeenCalledWith(ID, expect.objectContaining({ requestId: "req-1" }));
  });

  it("takes the Environment by id or name, the default when none is named, and the options it was given", async () => {
    const createSession = vi.fn(backend().createSession);
    const api = service({ createSession });

    await run(
      api.start({
        environment: " docs ",
        text: "go",
        via: VIA,
        title: "  T  ",
        branch: "feat/x",
        base: "dev",
      }),
    );

    expect(createSession).toHaveBeenCalledWith({
      environment: "e2",
      title: "T",
      branch: "feat/x",
      base: "dev",
      marks: expect.anything(),
      maxRunning: 10,
    });
  });

  it("configures the model and thinking before the first message, and only when asked", async () => {
    const order: string[] = [];

    const configure = vi.fn(() => {
      order.push("configure");

      return Effect.succeed({ ok: true as const, value: null });
    });

    const submit = vi.fn(() => {
      order.push("submit");

      return backend().submit(ID, {} as never);
    });

    const api = service({ configure, submit });

    await run(api.start({ text: "go", via: VIA }));
    expect(configure).not.toHaveBeenCalled();

    await run(
      api.start({ text: "go", model: "anthropic/claude-opus-5-5", thinking: "high", via: VIA }),
    );

    expect(configure).toHaveBeenCalledWith(ID, {
      model: "anthropic/claude-opus-5-5",
      thinkingLevel: "high",
    });
    expect(order).toEqual(["submit", "configure", "submit"]);
  });

  it("refuses a bad argument before it makes anything", async () => {
    const createSession = vi.fn(backend().createSession);
    const api = service({ createSession });

    const bad = await Promise.all([
      run(api.start({ text: "go", model: "gpt-nope", via: VIA })),
      run(api.start({ text: "go", thinking: "turbo", via: VIA })),
      run(api.start({ text: "go", branch: "a..b", via: VIA })),
      run(api.start({ text: "go", branch: "cloudpid/spare", via: VIA })),
      run(api.start({ text: "go", base: "", via: VIA })),
      run(api.start({ text: "go", title: "   ", via: VIA })),
    ]);

    for (const result of bad) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_argument", retryable: false },
      });
    }

    const large = await run(api.start({ text: "é".repeat(1_000_000), via: VIA }));
    const unknown = await run(api.start({ text: "go", environment: "nope", via: VIA }));

    expect(large).toMatchObject({ ok: false, error: { code: "input_too_large" } });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("answers the cap, a taken branch and a missing Environment with their codes, and sends nothing", async () => {
    const submit = vi.fn(backend().submit);

    const refused = (refusal: SessionRefusal) =>
      run(
        service({ createSession: () => Effect.succeed(refusal), submit }).start({
          text: "go",
          via: VIA,
        }),
      );

    expect(await refused({ refused: "too-many-running", limit: 10 })).toMatchObject({
      ok: false,
      error: { code: "too_many_running", retryable: true, details: { limit: 10 } },
    });
    expect(await refused({ refused: "branch-taken", workspace: "abcd1234" })).toMatchObject({
      ok: false,
      error: { code: "branch_taken", retryable: false, details: { workspace: "abcd1234" } },
    });
    expect(await refused({ refused: "no-environment" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("names the Session on every failure after it was made, so a retry need not make another", async () => {
    const stopped = apiFailure("stopped", "Stopped before it was sent.", { retryable: false });
    const refused = apiFailure("invalid_argument", "The model cannot be picked.");

    const cases = {
      withdrawn: service({ submit: () => Effect.succeed(stopped) }),
      down: service({ submit: () => Effect.die("object reset") }),
      configureRefused: service({ configure: () => Effect.succeed(refused) }),
      configureDown: service({ configure: () => Effect.die("object reset") }),
    };

    const results = {
      withdrawn: await run(cases.withdrawn.start({ text: "go", via: VIA })),
      down: await run(cases.down.start({ text: "go", request_id: "r-1", via: VIA })),
      configureRefused: await run(
        cases.configureRefused.start({ text: "go", model: "anthropic/claude-opus-5-5", via: VIA }),
      ),
      configureDown: await run(
        cases.configureDown.start({ text: "go", thinking: "low", via: VIA }),
      ),
    };

    const named = { session_id: ID, url: `${ORIGIN}/sessions/${ID}` };

    expect(results.withdrawn).toMatchObject({
      ok: false,
      error: { code: "stopped", retryable: false, details: named },
    });
    expect(results.down).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true, details: named },
    });
    expect(results.configureRefused).toMatchObject({
      ok: false,
      error: { code: "invalid_argument", details: named },
    });
    expect(results.configureDown).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true, details: named },
    });

    // A retryable failure says how to go on: the same request_id, or session_send when there is none.
    expect(!results.down.ok && results.down.error.message).toContain("same request_id");
    expect(!results.configureDown.ok && results.configureDown.error.message).toContain(
      "session_send",
    );
  });

  it("does not name a tool that is not served in a refusal", async () => {
    const cap = await run(
      service({
        createSession: () => Effect.succeed({ refused: "too-many-running", limit: 10 }),
      }).start({ text: "go", via: VIA }),
    );

    expect(!cap.ok && cap.error.message).not.toContain("session_wait");
    expect(!cap.ok && cap.error.message).toContain("session_stop");
  });

  it("says the Session is running when it cannot yet say", async () => {
    const result = await run(
      service({ status: () => Effect.die("waking") }).start({ text: "go", via: VIA }),
    );

    expect(result.ok && result.value.status).toBe("running");
  });
});

/** A Registry and a Session that remember, as the real ones do: one Session per `request_id`, one first message per id. */
const remembering = () => {
  const made: Array<string> = [];
  const sent: Array<string> = [];
  const configured: Array<string> = [];
  let cut = false;
  const sessions = new Map<string, SessionRecord>();
  const delivered = new Map<string, { delivery: "started"; cursor: string }>();

  const overrides: Partial<McpBackend> = {
    createSession: ({ requestId, environment }) =>
      Effect.sync(() => {
        const earlier = requestId === undefined ? undefined : sessions.get(requestId);

        if (earlier !== undefined) return { ...earlier, repeated: true as const };

        const id = `0190f0a8-1b2c-7d3e-8f40-${String(made.length).padStart(12, "0")}`;
        const created = record({ id, environment });

        made.push(id);

        if (requestId !== undefined) sessions.set(requestId, created);

        return created;
      }),
    configure: (id) =>
      Effect.sync(() => {
        configured.push(id);

        return { ok: true as const, value: null };
      }),
    submit: (id, request) =>
      Effect.suspend(() => {
        const key = `${id}/${request.requestId ?? ""}`;
        const first = request.requestId === undefined ? undefined : delivered.get(key);

        if (first !== undefined) return Effect.succeed({ ok: true as const, value: first });

        if (cut) return Effect.die("the Session was reset");

        const value = { delivery: "started" as const, cursor: `cursor-${String(sent.length)}` };

        sent.push(request.input);

        if (request.requestId !== undefined) delivered.set(key, value);

        return Effect.succeed({ ok: true as const, value });
      }),
  };

  return {
    overrides,
    made,
    sent,
    configured,
    cutBeforeSubmit: (on: boolean) => {
      cut = on;
    },
  };
};

describe("a repeated start", () => {
  it("makes one Session and sends one first message, and answers the first one's cursor", async () => {
    const memory = remembering();
    const api = service(memory.overrides);

    const start = () =>
      api.start({
        text: "Fix it",
        request_id: "req-1",
        model: "anthropic/claude-opus-5-5",
        via: VIA,
      });

    const first = await run(start());
    const again = await run(start());

    expect(first.ok && again.ok && again.value.session_id).toBe(first.ok && first.value.session_id);
    expect(first.ok && again.ok && again.value.cursor).toBe(first.ok && first.value.cursor);
    expect(memory.made).toHaveLength(1);
    expect(memory.sent).toEqual(["Fix it"]);
    // The model is picked once: a repeat never configures the Session it finds.
    expect(memory.configured).toHaveLength(1);
  });

  it("heals a start cut between making the Session and sending its first message, without a second Session", async () => {
    const memory = remembering();
    const api = service(memory.overrides);

    const start = () =>
      api.start({ text: "Fix it", request_id: "req-1", thinking: "low", via: VIA });

    memory.cutBeforeSubmit(true);

    const cut = await run(start());

    expect(cut).toMatchObject({
      ok: false,
      error: { retryable: true, details: { session_id: memory.made[0] } },
    });
    expect(memory.sent).toEqual([]);

    memory.cutBeforeSubmit(false);

    const healed = await run(start());

    expect(healed).toMatchObject({ ok: true, value: { session_id: memory.made[0] } });
    expect(memory.made).toHaveLength(1);
    expect(memory.sent).toEqual(["Fix it"]);
    // Only the first start picked the model; the repeat healed the message alone.
    expect(memory.configured).toHaveLength(1);
  });

  it("makes another Session for another request_id, and for none", async () => {
    const memory = remembering();
    const api = service(memory.overrides);

    await run(api.start({ text: "a", request_id: "req-1", via: VIA }));
    await run(api.start({ text: "b", request_id: "req-2", via: VIA }));
    await run(api.start({ text: "c", via: VIA }));
    await run(api.start({ text: "d", via: VIA }));

    expect(memory.made).toHaveLength(4);
  });
});

describe("send", () => {
  it("sends the text with the caller's mark, and queues unless told otherwise", async () => {
    const submit = vi.fn(backend().submit);
    const api = service({ submit }, { caller: { kind: "owner", clientId: "dcr-1" } });

    const result = await run(api.send({ session_id: ID, text: "more", via: VIA }));

    await run(
      api.send({ session_id: ID, text: "now", when_busy: "steer", request_id: "r", via: VIA }),
    );
    await run(api.send({ session_id: ID, text: "or not", when_busy: "reject", via: VIA }));

    expect(result).toEqual({ ok: true, value: { delivery: "started", cursor: "c-sent" } });
    expect(
      submit.mock.calls.map(([, input]) => [input.input, input.whenBusy, input.requestId]),
    ).toEqual([
      ["more", "followUp", undefined],
      ["now", "steer", "r"],
      ["or not", "reject", undefined],
    ]);
    expect(submit.mock.calls[0]?.[1].via).toEqual({
      client: VIA.client,
      auth: "oauth",
      era: "modern",
      clientId: "dcr-1",
    });
  });

  it("never reaches a Session for an unknown or malformed id, or text over the limit", async () => {
    const submit = vi.fn(backend().submit);

    const unknown = await run(
      service({ session: () => Effect.succeed(null), submit }).send({
        session_id: ID,
        text: "x",
        via: VIA,
      }),
    );

    const malformed = await run(
      service({ submit }).send({ session_id: "nope", text: "x", via: VIA }),
    );

    const large = await run(
      service({ submit }).send({ session_id: ID, text: "é".repeat(1_000_000), via: VIA }),
    );

    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(large).toMatchObject({ ok: false, error: { code: "input_too_large" } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("answers the Session's own refusals as they are: busy, archived, stopped", async () => {
    for (const code of ["session_busy", "session_archived", "stopped"] as const) {
      const result = await run(
        service({ submit: () => Effect.succeed(apiFailure(code, "no")) }).send({
          session_id: ID,
          text: "x",
          via: VIA,
        }),
      );

      expect(result).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("is unavailable when the Session cannot be reached", async () => {
    const result = await run(
      service({ submit: () => Effect.die("reset") }).send({ session_id: ID, text: "x", via: VIA }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("stop", () => {
  it("stops with the caller's mark, and subagents only when asked", async () => {
    const stop = vi.fn(backend().stop);
    const api = service({ stop }, { caller: { kind: "service_token", clientId: "id.access" } });

    const plain = await run(api.stop({ session_id: ID, via: VIA }));

    await run(api.stop({ session_id: ID, subagents: true, via: VIA }));

    expect(plain).toEqual({ ok: true, value: { status: "idle" } });
    expect(stop.mock.calls).toEqual([
      [ID, { via: { client: VIA.client, auth: "service_token", era: "modern" } }],
      [ID, { subagents: true, via: { client: VIA.client, auth: "service_token", era: "modern" } }],
    ]);
  });

  it("never reaches a Session for an unknown or malformed id", async () => {
    const stop = vi.fn(backend().stop);

    const unknown = await run(
      service({ session: () => Effect.succeed(null), stop }).stop({ session_id: ID, via: VIA }),
    );

    const malformed = await run(service({ stop }).stop({ session_id: "nope", via: VIA }));

    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(stop).not.toHaveBeenCalled();
  });

  it("says stopping when the Session had not gone idle", async () => {
    const result = await run(
      service({
        stop: () =>
          Effect.succeed({
            ok: true as const,
            value: { status: "running" as const, stopping: true },
          }),
      }).stop({ session_id: ID, via: VIA }),
    );

    expect(result).toEqual({ ok: true, value: { status: "running", stopping: true } });
  });
});

describe("the caller", () => {
  it("is marked as it got in, and rate-limited by an identity that is never the email", () => {
    expect(identityOf({ kind: "owner" })).toEqual({ auth: "oauth", rateKey: "owner" });
    expect(identityOf({ kind: "service_token", clientId: "id.access" })).toEqual({
      auth: "service_token",
      rateKey: "token:id.access",
    });
    expect(identityOf({ kind: "local" })).toEqual({ auth: "local", rateKey: "local" });
  });

  it("counts a call against its key, and says to wait a period when over", async () => {
    const withinRate = vi.fn(() => Effect.succeed(false));

    const api = service(
      {},
      { caller: { kind: "service_token", clientId: "id.access" }, withinRate },
    );

    expect(await run(api.limited)).toEqual({ retryAfterS: MCP_CALLS_PERIOD_S });
    expect(withinRate).toHaveBeenCalledWith("token:id.access");
    expect(api.auth).toBe("service_token");
  });

  it("is within the rate, and fails open when the limiter cannot answer", async () => {
    expect(await run(service().limited)).toBeUndefined();
    expect(
      await run(service({}, { withinRate: () => Effect.die("down") }).limited),
    ).toBeUndefined();
  });
});
