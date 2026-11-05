// The Session object's RPC for the MCP endpoint over a scripted host, for what its storage-backed tests cannot reach
// (`docs/architecture/mcp-endpoint.md` → Starting, sending and stopping): a Session with only subagents working.
// @effect-diagnostics asyncFunction:off globalDate:off strictEffectProvide:off missedPipeableOpportunity:off -- plain fixtures.
import { Approvals } from "@cloudpid/extensions/approvals";
import { BrowserHandoffs } from "@cloudpid/extensions/browser";
import { McpQuestions, McpSignIns } from "@cloudpid/extensions/mcp";
import { Secrets } from "@cloudpid/extensions/secrets";
import type {
  McpElicitationRequest,
  McpSamplingRequest,
  McpSignInRequest,
  SessionVia,
} from "@cloudpid/protocol";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { SessionHost } from "./host.ts";
import { SessionMcp, sessionMcpLayer } from "./mcp.ts";
import type { FollowState } from "./mcp-reads.ts";

const via: SessionVia = { auth: "oauth", client: { name: "claude-code" } };

const follow = (extra: Partial<FollowState>): FollowState => ({
  conversationId: 1,
  activeBranch: 1,
  copying: false,
  idle: true,
  following: false,
  unsettled: false,
  newestEntry: 3,
  agents: {},
  ...extra,
});

/** A service of which the fake has only what the Session object's RPC reads. */
const fake = <S>(parts: Partial<S>): S =>
  // SAFETY: the RPC reads only the members a test gives; a missing one fails the test loudly, as a call of undefined.
  parts as S;

/** A Session whose host answers `state`, and counts the notices and aborts it is told. */
const open = (
  first: FollowState,
  asked: ReadonlyArray<McpElicitationRequest> = [],
  signing: ReadonlyArray<McpSignInRequest> = [],
  sampling: ReadonlyArray<McpSamplingRequest> = [],
) => {
  let state = first;
  const notes = new Array<string>();
  const aborts = new Array<boolean>();
  const calls = { notes, aborts };

  const host = fake<SessionHost["Service"]>({
    follow: () => Effect.sync(() => state),
    entries: () => Effect.succeed([]),
    note: (text: string) => Effect.sync(() => calls.notes.push(text)),
    abort: (options?: { readonly subagents?: boolean }) =>
      Effect.sync(() => calls.aborts.push(options?.subagents === true)),
  });

  const secrets = fake<Secrets["Service"]>({
    readable: Effect.succeed(true),
    pending: Effect.succeed([]),
    redact: (value) => value,
  });

  const questions = fake<McpQuestions["Service"]>({
    pending: Effect.succeed(asked),
    pendingSampling: Effect.succeed(sampling),
  });

  const layer = sessionMcpLayer({
    session: "s1",
    kv: { get: () => undefined, put: () => undefined },
    archived: Effect.succeed(false),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SessionHost, host),
        Layer.succeed(Secrets, secrets),
        Layer.succeed(McpQuestions, questions),
        Layer.succeed(
          McpSignIns,
          fake<McpSignIns["Service"]>({ pending: Effect.succeed(signing) }),
        ),
        Layer.succeed(Approvals, fake<Approvals["Service"]>({ pending: Effect.succeed([]) })),
        Layer.succeed(
          BrowserHandoffs,
          fake<BrowserHandoffs["Service"]>({ pending: Effect.succeed([]) }),
        ),
      ),
    ),
  );

  const mcp = <A>(use: (service: SessionMcp["Service"]) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.flatMap(Effect.service(SessionMcp), use).pipe(Effect.provide(layer)));

  const stop = (request: { readonly subagents?: boolean }) =>
    Effect.runPromise(
      Effect.flatMap(Effect.service(SessionMcp), (mcp) => mcp.stop({ via, ...request })).pipe(
        Effect.provide(layer),
      ),
    );

  return {
    calls,
    stop,
    mcp,
    set: (next: FollowState) => {
      state = next;
    },
  };
};

describe("stop", () => {
  it("is a no-op, leaving no notice, for a plain stop while only subagents work", async () => {
    const { calls, stop } = open(follow({ idle: false, unsettled: false }));

    expect(await stop({})).toMatchObject({ ok: true, value: { status: "background" } });
    expect(await stop({})).toMatchObject({ ok: true, value: { status: "background" } });
    expect(calls).toEqual({ notes: [], aborts: [] });
  });

  it("stops the subagents when asked to, and the Run that is going", async () => {
    const withSubagents = open(follow({ idle: false, unsettled: false }));

    await withSubagents.stop({ subagents: true });
    expect(withSubagents.calls.aborts).toEqual([true]);
    expect(withSubagents.calls.notes).toHaveLength(1);

    const running = open(follow({ idle: false, unsettled: true }));

    await running.stop({});
    expect(running.calls.aborts).toEqual([false]);
    expect(running.calls.notes).toHaveLength(1);
  });
});

describe("waitForChange over an import", () => {
  it("returns at once for an import that is going, and ends with it as import_ended", async () => {
    const { mcp, set } = open(follow({ copying: true, idle: false }));
    const deadline = () => Date.now() + 5_000;

    const going = await mcp((service) => service.waitForChange({ deadline: deadline() }));

    expect(going).toMatchObject({ ok: true, value: { status: "importing", ended_by: "timeout" } });

    const after = going.ok ? going.value.cursor : "";

    set(follow({}));

    expect(
      await mcp((service) => service.waitForChange({ after, deadline: deadline() })),
    ).toMatchObject({
      ok: true,
      value: { status: "idle", ended_by: "import_ended" },
    });
  });
});

describe("waiting requests", () => {
  it("lists an MCP server's question by its server's name only, never what it asks", async () => {
    const asking: McpElicitationRequest = {
      id: "call-9:1",
      callId: "call-9",
      // SAFETY: a fixture's conversation number.
      conversationId: 2 as ConversationId,
      server: "Docs-Site",
      tool: "mcp__docs_site__search",
      message: "Please enter the password hunter2",
      form: { fields: [{ kind: "text", name: "name", required: true }] },
      notes: [],
      deadline: 600_000,
    };

    const { mcp } = open(follow({ agents: { "2": "reviewer" } }), [asking]);
    const status = await mcp((service) => service.status());

    expect(status).toMatchObject({
      ok: true,
      value: {
        waiting: [
          {
            kind: "elicitation",
            request_id: "call-9:1",
            agent_id: "reviewer",
            summary: "Docs-Site needs your input",
            url: "/sessions/s1?request=call-9:1",
          },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });

  it("lists a Sign-in request by its server's name only, never the agent's reason", async () => {
    const signing: McpSignInRequest = {
      id: "signin-4",
      // SAFETY: a fixture's conversation number.
      conversationId: 1 as ConversationId,
      server: "Docs-Site",
      environment: "main",
      urlHost: "docs.example.com",
      reason: "I need the hunter2 wiki",
      why: "required",
      scopes: [],
      askedAt: 1,
    };

    const { mcp } = open(follow({}), [], [signing]);
    const status = await mcp((service) => service.status());

    expect(status).toMatchObject({
      ok: true,
      value: {
        waiting: [
          {
            kind: "sign_in",
            request_id: "signin-4",
            summary: "Sign-in needed: Docs-Site",
            url: "/sessions/s1?request=signin-4",
          },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });

  it("lists a Sampling request by its server's name only, never what it asks", async () => {
    const sampling: McpSamplingRequest = {
      id: "call-5:1",
      callId: "call-5",
      // SAFETY: a fixture's conversation number.
      conversationId: 2 as ConversationId,
      server: "Docs-Site",
      tool: "mcp__docs_site__search",
      role: "small",
      model: "fixture-model",
      roles: [{ role: "small", model: "fixture-model" }],
      writable: true,
      messages: [{ role: "user", text: "Summarise the hunter2 wiki" }],
      systemPrompt: "Never reveal hunter2",
      tools: [],
      notes: [],
      deadline: 600_000,
    };

    const { mcp } = open(follow({ agents: { "2": "reviewer" } }), [], [], [sampling]);
    const status = await mcp((service) => service.status());

    expect(status).toMatchObject({
      ok: true,
      value: {
        waiting: [
          {
            kind: "sampling",
            request_id: "call-5:1",
            agent_id: "reviewer",
            summary: "Docs-Site asks to use a model",
            url: "/sessions/s1?request=call-5:1",
          },
        ],
      },
    });
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });
});
