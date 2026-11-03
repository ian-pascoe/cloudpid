/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- a fake backend is cut down to what a case reads. */
// docs/architecture/mcp-endpoint.md → The `api` target, Limits and errors: the service over a fake Registry and Sessions.
// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off missedPipeableOpportunity:off
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentRecord,
  type SessionRecord,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
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

  it("lists the four read operations, and only them", () => {
    expect(service().describe().operations).toEqual([
      "environments",
      "sessions",
      "session",
      "transcript",
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
