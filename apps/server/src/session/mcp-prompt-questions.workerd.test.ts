// A server's question during a prompt send's `prompts/get`, end to end (`docs/architecture/mcp-server-requests.md` →
// Questions; `docs/architecture/mcp-in-a-session.md` → Getting a prompt at send): the owner's message goes Session → host →
// the real `McpEngine` → a fake server whose prompt asks a form (or a model reply) before it answers. The question reaches
// a client of the Session socket as a card that names the prompt, the owner answers over the socket, and the get completes;
// nobody is notified, and Stop withdraws the message and its card. Legacy and Modern. The 5-minute bound runs here too,
// shortened to 300 ms for a Session named `mcp-short-wait-*` (`host.fixture.ts`). (The paused clock is in
// `packages/extensions/src/mcp-prompt-asking.test.ts` and `packages/mcp/src/prompt-questions.test.ts`.)
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferSchemaOverJson:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type FakePrompt,
  legacyStatefulServer,
  modernServer,
  type FakeServer,
} from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpElicitationRequest,
  type McpSamplingRequest,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

const FORM_PROMPT: FakePrompt = {
  name: "review",
  title: "Review PR",
  arguments: [{ name: "pr", required: true }],
  get: () => ({ messages: [] }),
  asks: { message: "Which team?" },
};

const SAMPLE_PROMPT: FakePrompt = {
  name: "review",
  title: "Review PR",
  arguments: [{ name: "pr", required: true }],
  get: () => ({ messages: [] }),
  asks: { sample: "Summarize the PR" },
};

const REVIEW = { server: "docs", name: "review", arguments: { pr: "7" } } as const;

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  return {
    received,
    forms: (): ReadonlyArray<McpElicitationRequest> => {
      const last = received.findLast((message) => message.type === "mcp_elicitation_requests");

      return last?.type === "mcp_elicitation_requests" ? last.requests : [];
    },
    samples: (): ReadonlyArray<McpSamplingRequest> => {
      const last = received.findLast((message) => message.type === "mcp_sampling_requests");

      return last?.type === "mcp_sampling_requests" ? last.requests : [];
    },
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

/**
 * A Session whose host runs the real engine against a fake server whose prompt asks, with the prompt in its catalog: a
 * first turn has the host discover the server.
 */
const open = async (
  make: (options: { readonly prompts: ReadonlyArray<FakePrompt> }) => FakeServer,
  prompt: FakePrompt,
  name = "mcp",
  server: Record<string, Schema.Json> = {},
) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const fake = make({ prompts: [prompt] });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fake.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply({
    ...SET,
    entries: SET.entries.map((entry) => ({
      ...entry,
      server: { ...entry.server, ...server },
    })),
  });

  const stub = env.SESSIONS.getByName(`${name}-${environment}`);

  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
    instance.script(["ready"]);
    await instance.prompt({ requestId: "first", text: "hi" });
  });

  await settles(async () => {
    const catalog = await runInDurableObject(stub, (instance: TestSession) => instance.catalog());

    expect(catalog.prompts).toHaveLength(1);
  });

  return { stub };
};

/** Send the prompt `review` and return at once, as the composer does: the get waits for the owner. */
const send = (stub: DurableObjectStub<TestSession>, script: ReadonlyArray<string> = ["reviewed"]) =>
  runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(script);

    return instance.submitMcpPrompt({ requestId: "pick-1", text: "go", ref: REVIEW });
  });

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

/** The pushes a Session made about MCP questions. */
const inputPushes = async (stub: DurableObjectStub<TestSession>) =>
  (await runInDurableObject(stub, (instance: TestSession) => instance.notified())).filter(
    (event) => event.kind === "input",
  );

/** The owner messages of the root conversation. */
const ownerMessages = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, async (instance: TestSession) =>
    (await instance.rootEntries()).filter(
      (entry) => entry.kind === "pi.user" || entry.kind === "cloudpid.user",
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

const eras = [
  ["Legacy", legacyStatefulServer],
  ["Modern", modernServer],
] as const;

describe.each(eras)("a %s server's form during a prompt send", (_era, make) => {
  it("waits live on a card that names the prompt, tells nobody, and the get completes after Submit", async () => {
    const { stub } = await open(make, FORM_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [card] = owner.forms();

    expect(card).toMatchObject({
      server: "docs",
      prompt: "Review PR",
      tool: "/mcp__docs__review",
      message: "Which team?",
    });
    // A prompt send's card has a countdown of 5 min at most, and never waits "for the owner" with no deadline.
    expect(card?.waits).toBeUndefined();
    expect(card?.deadline).toBeGreaterThan(Date.now());
    expect(card?.deadline).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

    // The message is not placed while the question waits.
    expect(await ownerMessages(stub)).toHaveLength(1);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "yes",
      request: card?.id ?? "",
      action: "accept",
      content: {},
    });

    expect(await sending).toHaveProperty("submission");
    await settles(async () => expect(owner.forms()).toEqual([]));
    await idle(stub);

    // The server was answered `accept`, which its prompt's message repeats.
    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("accept");
    expect(await inputPushes(stub)).toEqual([]);
    owner.close();
  });

  it("is cancelled after its own wait, and the get goes on", async () => {
    const { stub } = await open(make, FORM_PROMPT, "mcp-short-wait");
    const owner = await connect(stub);

    expect(await send(stub)).toHaveProperty("submission");
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("cancel");
    expect(owner.forms()).toEqual([]);
    expect(await inputPushes(stub)).toEqual([]);
    owner.close();
  });

  it("is withdrawn with its card, and the message with it, when the owner stops", async () => {
    const { stub } = await open(make, FORM_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());

    expect(await sending).toEqual({ withdrawn: true });
    await settles(async () => expect(owner.forms()).toEqual([]));
    // Nothing was placed beyond the first turn's message.
    expect(await ownerMessages(stub)).toHaveLength(1);
    owner.close();
  });
});

describe("a Legacy server's Sampling request during a prompt send", () => {
  it("waits live on a card that names the prompt, and the get completes once the owner allows it", async () => {
    const { stub } = await open(legacyStatefulServer, SAMPLE_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub, ["a sampled reply", "reviewed"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));

    const [card] = owner.samples();

    expect(card).toMatchObject({
      server: "docs",
      prompt: "Review PR",
      tool: "/mcp__docs__review",
    });
    expect(card?.waits).toBeUndefined();

    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: card?.id ?? "",
      choice: "allow_call",
    });

    expect(await sending).toHaveProperty("submission");
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("a sampled reply");
    expect(await inputPushes(stub)).toEqual([]);
    owner.close();
  });

  it("is withdrawn with its card when the owner stops", async () => {
    const { stub } = await open(legacyStatefulServer, SAMPLE_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub, ["never sampled", "never sent"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());

    expect(await sending).toEqual({ withdrawn: true });
    await settles(async () => expect(owner.samples()).toEqual([]));
    owner.close();
  });
});

describe("a Modern server's Sampling request during a prompt send", () => {
  it("waits live on a card that names the prompt, and the get completes once the owner allows it", async () => {
    const { stub } = await open(modernServer, SAMPLE_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub, ["a sampled reply", "reviewed"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));

    const [card] = owner.samples();

    expect(card).toMatchObject({ prompt: "Review PR", tool: "/mcp__docs__review" });
    expect(card?.waits).toBeUndefined();

    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: card?.id ?? "",
      choice: "allow_call",
    });

    expect(await sending).toHaveProperty("submission");
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("a sampled reply");
    owner.close();
  });

  it("refused by the owner fails the send with MCP_PROMPT_FAILED", async () => {
    const { stub } = await open(modernServer, SAMPLE_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub, ["never sampled", "never sent"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "no",
      request: owner.samples()[0]?.id ?? "",
      choice: "refuse",
    });

    expect(await sending).toMatchObject({
      failure: {
        code: "MCP_PROMPT_FAILED",
        server: "docs",
        message: expect.stringContaining("refused"),
      },
    });
    owner.close();
  });
});
