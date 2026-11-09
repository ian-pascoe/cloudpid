// A server's question during a prompt send's `prompts/get`, end to end (`docs/architecture/mcp-server-requests.md` →
// Questions; `docs/architecture/mcp-in-a-session.md` → Getting a prompt at send): the owner's message goes Session → host →
// the real `McpEngine` → a fake server whose prompt asks a form (or a model reply) before it answers. The question reaches
// a client of the Session socket as a card that names the prompt, the owner answers over the socket, and the get completes;
// nobody is notified, and Stop withdraws the message and its card. Legacy and Modern. The 5-minute bound runs here too,
// shortened to 300 ms for a Session named `mcp-short-wait-*` (`host.fixture.ts`). (The paused clock is in
// `packages/extensions/src/mcp-prompt-asking.test.ts` and `packages/mcp/src/prompt-questions.test.ts`.)
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off globalJsonInEffect:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type FakeOptions,
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
  MCP_PROMPT_REQUEST_ID_MAX,
  mcpPromptCallId,
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

const PAGE_URL = "https://login.example.com/authorize?state=1";

/** A Legacy server's page, opened in the get: the server is told `accept` at once, then goes on for `holdMs`. */
const pagePrompt = (holdMs: number): FakePrompt => ({
  name: "review",
  title: "Review PR",
  arguments: [{ name: "pr", required: true }],
  get: () => ({ messages: [] }),
  asks: { url: PAGE_URL, holdMs },
});

/** A prompt whose server never answers. */
const HANG_PROMPT: FakePrompt = {
  name: "review",
  title: "Review PR",
  arguments: [{ name: "pr", required: true }],
  get: () => ({ messages: [] }),
  hangs: true,
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
  make: (options: FakeOptions) => FakeServer,
  prompt: FakePrompt,
  name = "mcp",
  server: Record<string, Schema.Json> = {},
  more: Omit<FakeOptions, "prompts"> = {},
) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const fake = make({ ...more, prompts: [prompt] });

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
const send = (
  stub: DurableObjectStub<TestSession>,
  script: ReadonlyArray<string> = ["reviewed"],
  requestId = "pick-1",
) =>
  runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(script);

    return instance.submitMcpPrompt({ requestId, text: "go", ref: REVIEW });
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
      // The send's own identity, which the web ties its lane row to the card by.
      callId: mcpPromptCallId("pick-1"),
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

  it("is keyed by a UUID of its own when the message's requestId is too long to be part of a storage key", async () => {
    const { stub } = await open(make, FORM_PROMPT);
    const owner = await connect(stub);
    const long = "r".repeat(MCP_PROMPT_REQUEST_ID_MAX + 1);
    const sending = send(stub, ["reviewed"], long);

    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [card] = owner.forms();

    expect(card?.callId).toMatch(/^prompt-[0-9a-f-]{36}$/);
    expect(card?.callId).not.toBe(mcpPromptCallId(long));

    owner.send({
      type: "mcp_elicitation_answer",
      id: "yes",
      request: card?.id ?? "",
      action: "accept",
      content: {},
    });

    expect(await sending).toHaveProperty("submission");
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
});

describe.each(eras)("the Session's own clock on a %s server's prompt send", (_era, make) => {
  // `mcp-short-clock-*` Sessions have a get clock of 2 s (`PROMPT_GET_WAIT_MS` is 40 s) and a question wait of 6 s: wide margins, since the clock also runs through the connect and the server's first ask on a loaded runner.
  it("stands still while a card waits, and the get completes after Submit", async () => {
    const { stub } = await open(make, FORM_PROMPT, "mcp-short-clock");
    const owner = await connect(stub);
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));

    // Longer than the clock: it would have run out.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(owner.forms()).toHaveLength(1);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "yes",
      request: owner.forms()[0]?.id ?? "",
      action: "accept",
      content: {},
    });

    expect(await sending).toHaveProperty("submission");
    owner.close();
  });

  it("stands still while a Sampling card waits, and the get completes once the owner allows it", async () => {
    const { stub } = await open(make, SAMPLE_PROMPT, "mcp-short-clock");
    const owner = await connect(stub);
    const sending = send(stub, ["a sampled reply", "reviewed"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));

    // Longer than the clock: it would have run out.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(owner.samples()).toHaveLength(1);

    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: owner.samples()[0]?.id ?? "",
      choice: "allow_call",
    });

    expect(await sending).toHaveProperty("submission");
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("a sampled reply");
    owner.close();
  });

  it("still runs out when no question waits", async () => {
    const { stub } = await open(make, HANG_PROMPT, "mcp-short-clock");
    const owner = await connect(stub);

    expect(await send(stub)).toMatchObject({
      failure: {
        code: "MCP_PROMPT_FAILED",
        server: "docs",
        message: expect.stringContaining("did not answer in time"),
      },
    });
    owner.close();
  });
});

describe("a Legacy server's page during a prompt send", () => {
  it("opens, is told accept at once, stays until the server is done, and the get completes", async () => {
    const { stub } = await open(legacyStatefulServer, pagePrompt(400));
    const owner = await connect(stub);
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [card] = owner.forms();

    expect(card).toMatchObject({
      server: "docs",
      prompt: "Review PR",
      tool: "/mcp__docs__review",
      page: { url: PAGE_URL, host: "login.example.com", domain: "example.com", opened: false },
    });
    expect(card?.waits).toBeUndefined();

    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: card?.id ?? "",
      action: "opened",
    });

    expect(await sending).toHaveProperty("submission");
    await settles(async () => expect(owner.forms()).toEqual([]));
    await idle(stub);

    // The server was answered `accept` by Open, which its prompt's message repeats.
    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("accept");
    expect(await inputPushes(stub)).toEqual([]);
    owner.close();
  });

  it("holds the Session's clock only until the 5 min bound, though it is open and not finished", async () => {
    // The server goes on for 12 s after Open and never says the page is finished. The clock (2 s) stands still until
    // the question's 6 s are up, then runs out: the get is not held for the page for good.
    const { stub } = await open(legacyStatefulServer, pagePrompt(12_000), "mcp-short-clock");
    const owner = await connect(stub);
    const started = Date.now();
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));
    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: owner.forms()[0]?.id ?? "",
      action: "opened",
    });

    expect(await sending).toMatchObject({
      failure: { code: "MCP_PROMPT_FAILED", message: expect.stringContaining("in time") },
    });
    // After the bound (6 s from the ask) and before the server was done (12 s).
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
    expect(Date.now() - started).toBeLessThan(11_000);
    owner.close();
  });
});

const Summaries = Schema.Unknown.pipe(Schema.Array, Schema.optional);

const SummariesData = Schema.Struct({
  mcpPrompt: Schema.optional(Schema.Struct({ elicitation: Summaries, sampling: Summaries })),
});

/** What the owner's entry of the sent prompt keeps of the server's questions: `mcpPrompt.elicitation` and `.sampling`. */
const summariesOf = async (stub: DurableObjectStub<TestSession>) => {
  const [, picked] = await ownerMessages(stub);
  const data = picked?.data;
  const mcpPrompt = Schema.is(SummariesData)(data) ? data.mcpPrompt : undefined;

  return { elicitation: mcpPrompt?.elicitation, sampling: mcpPrompt?.sampling };
};

/** Open the page of the only card, then press Done; the card that follows (if any) is another one. */
const finishPage = async (owner: Awaited<ReturnType<typeof connect>>) => {
  const [card] = owner.forms();

  owner.send({
    type: "mcp_elicitation_answer",
    id: `open-${card?.id}`,
    request: card?.id ?? "",
    action: "opened",
  });
  await settles(async () => expect(owner.forms()[0]?.page?.opened).toBe(true));
  owner.send({
    type: "mcp_elicitation_answer",
    id: `done-${card?.id}`,
    request: card?.id ?? "",
    action: "done",
  });

  return card;
};

describe("a Modern server's page during a prompt send", () => {
  it("waits on a card with Open and Done, tells nobody, and the get goes on once the owner is done", async () => {
    const { stub } = await open(modernServer, pagePrompt(0));
    const owner = await connect(stub);
    let finished = false;

    const sending = send(stub).then((outcome) => {
      finished = true;

      return outcome;
    });

    await settles(async () => expect(owner.forms()).toHaveLength(1));

    const [card] = owner.forms();

    expect(card).toMatchObject({
      server: "docs",
      prompt: "Review PR",
      callId: mcpPromptCallId("pick-1"),
      page: { url: PAGE_URL, host: "login.example.com", opened: false, retry: true, era: "modern" },
    });
    expect(card?.waits).toBeUndefined();

    // Open answers the server nothing: the get still waits for Done.
    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: card?.id ?? "",
      action: "opened",
    });
    await settles(async () => expect(owner.forms()[0]?.page?.opened).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "done",
      request: card?.id ?? "",
      action: "done",
    });

    expect(await sending).toHaveProperty("submission");
    await settles(async () => expect(owner.forms()).toEqual([]));
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    // The server was answered `accept` by Done, which its prompt's message repeats.
    expect(picked?.text).toContain("accept");
    expect(await inputPushes(stub)).toEqual([]);
    expect(await summariesOf(stub)).toEqual({
      elicitation: [
        {
          server: "docs",
          mode: "url",
          action: "accept",
          by: "owner",
          fields: [],
          host: "login.example.com",
        },
      ],
      sampling: undefined,
    });
    owner.close();
  });
});

describe("a Legacy server's -32042 during a prompt send", () => {
  const VISIT: FakePrompt = {
    name: "review",
    title: "Review PR",
    arguments: [{ name: "pr", required: true }],
    get: () => ({
      messages: [{ role: "assistant", content: { type: "text", text: "opened after the page" } }],
    }),
  };

  const gated = (times: number, name = "mcp", pages = 1) => {
    const gatePrompts = { times, calls: 0, pages, url: PAGE_URL };

    return { gatePrompts, opened: open(legacyStatefulServer, VISIT, name, {}, { gatePrompts }) };
  };

  it("waits on a card, and Done sends the get again once, which completes", async () => {
    const { gatePrompts, opened } = gated(1);
    const { stub } = await opened;
    const owner = await connect(stub);
    const sending = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));
    expect(owner.forms()[0]).toMatchObject({
      server: "docs",
      prompt: "Review PR",
      callId: mcpPromptCallId("pick-1"),
      message: "Authorize first",
      page: { url: PAGE_URL, opened: false, retry: true, era: "legacy" },
    });

    await finishPage(owner);

    expect(await sending).toHaveProperty("submission");
    await settles(async () => expect(owner.forms()).toEqual([]));
    await idle(stub);

    const [, picked] = await ownerMessages(stub);

    expect(picked?.text).toContain("opened after the page");
    expect(gatePrompts.calls).toBe(2);
    expect(await inputPushes(stub)).toEqual([]);
    expect((await summariesOf(stub)).elicitation).toMatchObject([
      { mode: "url", action: "accept", by: "owner", host: "login.example.com" },
    ]);
    owner.close();
  });

  it("keeps only its own questions in the entry of a get sent again under the same requestId", async () => {
    const { opened } = gated(1);
    const { stub } = await opened;
    const owner = await connect(stub);
    const first = send(stub);

    await settles(async () => expect(owner.forms()).toHaveLength(1));
    owner.send({
      type: "mcp_elicitation_answer",
      id: "no",
      request: owner.forms()[0]?.id ?? "",
      action: "decline",
    });
    expect(await first).toHaveProperty("failure");

    // The same `requestId` again: the server asks nothing this time, so the entry holds no question, not the first's.
    expect(await send(stub)).toHaveProperty("submission");
    await idle(stub);
    expect(await summariesOf(stub)).toEqual({ elicitation: undefined, sampling: undefined });
    owner.close();
  });
});

describe("what the entry of a sent prompt keeps of a form and a Sampling request", () => {
  it.each(eras)("lists the Sampling request a %s server made", async (_era, make) => {
    const { stub } = await open(make, SAMPLE_PROMPT);
    const owner = await connect(stub);
    const sending = send(stub, ["a sampled reply", "reviewed"]);

    await settles(async () => expect(owner.samples()).toHaveLength(1));
    owner.send({
      type: "mcp_sampling_answer",
      id: "yes",
      request: owner.samples()[0]?.id ?? "",
      choice: "allow_call",
    });
    expect(await sending).toHaveProperty("submission");
    await idle(stub);

    expect((await summariesOf(stub)).sampling).toMatchObject([
      { server: "docs", status: "answered", by: "owner" },
    ]);
    owner.close();
  });
});
