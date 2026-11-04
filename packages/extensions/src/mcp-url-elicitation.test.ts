// A page an MCP server asks the owner to open (`docs/architecture/mcp-server-requests.md` → Elicitation requests, URL
// mode): a Legacy server's, during its call (Open answers `accept` at once, the card stays until the page is finished),
// and a Legacy `-32042`, which ends the call, so it is kept for the owner like a Modern round and the call is sent again
// once they are done ("Done, try again"). The addresses cloudpid declines unseen, and what the agent and `details` read.
// A scripted model on a Harness, and an in-memory host. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import { McpHostCompleted, McpHostInputRequired, type McpInputAnswer } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, detailsOf, open } from "./mcp.fixture.ts";
import { type FakeMcpAnswer, fakeMcpHost } from "./mcp.testing.ts";
import {
  createMcpQuestions,
  type McpQuestionStorage,
  type McpQuestionVault,
} from "./mcp/questions.ts";
import { openKeptVault } from "./secrets/vault.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Answer = typeof McpInputAnswer.Encoded;

type Sent = Parameters<FakeMcpAnswer>[0];

const STATE = {
  v: 1,
  method: "tools/call",
  name: "search",
  arguments: {},
  answered: {},
  deferred: ["page-1"],
  round: 1,
  urlRequired: { message: "Authorization needed" },
};

const PAGE = "https://auth.example.com/authorize?state=abc";

const visit = (
  url = PAGE,
  mode: "live" | "deferrable" = "live",
  key = "page-1",
  message = "Authorize the app",
) => ({
  key,
  kind: "elicitation" as const,
  params: { mode: "url", elicitationId: key, url, message },
  mode,
});

const DONE = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
});

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpQuestionStorage = {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, keys: () => [...map.keys()], dump: () => JSON.stringify([...map]) };
};

const testVault = async (): Promise<McpQuestionVault> => {
  const kept = await Effect.runPromise(
    openKeptVault("test-master-key-0123456789abcdef0123456789", "mcp-elicitation"),
  );

  return {
    seal: (id, text) => kept.seal({ owner: "s1", name: id }, text),
    open: (id, sealed) => kept.open({ owner: "s1", name: id }, sealed),
  };
};

const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const setup = async () => {
  const host = fakeMcpHost([DOCS]);
  const memory = memoryStorage();
  const told: Array<{ server: string; page?: true }> = [];
  const vault = await testVault();

  const questions = createMcpQuestions({
    storage: memory.storage,
    announce: () => Effect.void,
    notify: (who) =>
      Effect.sync(() => {
        told.push(who);
      }),
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
    ownHost: (hostname) => hostname === "pi.ianpascoe.dev",
    vault,
  });

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0, questions });

  const session = await open((request) =>
    request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
  );

  const pending = () => Effect.runPromise(questions.pending);

  return { host, memory, questions, tools, told, session, pending };
};

describe("a Legacy server's page during its call", () => {
  it("is shown as a card; Open answers the server accept at once and the card stays until the page is finished", async () => {
    const { host, questions, tools, session, pending } = await setup();
    const replies: Array<Answer> = [];
    const finished: Array<string> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit());

      if (reply !== undefined) replies.push(reply);

      // The server goes on once the owner is at the page, and says when they are done there.
      await until(async () => (await pending()).every((each) => each.page?.opened === true));
      await hooks.onInputComplete?.("page-1");
      finished.push("page-1");

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length > 0);

    const [request] = await pending();

    expect(request).toMatchObject({
      server: "Docs-Site",
      message: "Authorize the app",
      form: { fields: [] },
      page: {
        url: PAGE,
        host: "auth.example.com",
        domain: "example.com",
        opened: false,
      },
    });
    expect(request?.page).not.toHaveProperty("retry");

    // Done is for a call that is sent again; this server goes on by itself.
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "done" })),
    ).rejects.toThrow("goes on by itself");
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "accept", content: {} })),
    ).rejects.toThrow("a page to open");

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "opened" }));
    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "accept" } }]);
    expect(finished).toEqual(["page-1"]);
    expect(await pending()).toEqual([]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          {
            server: "Docs-Site",
            mode: "url",
            action: "accept",
            by: "owner",
            fields: [],
            host: "auth.example.com",
          },
        ],
      }),
    ]);
    // The record names the origin of the page, never the rest of its address.
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({
        mode: "url",
        action: "accept",
        page: { origin: "https://auth.example.com" },
      }),
    ]);
    expect(JSON.stringify(await Effect.runPromise(questions.records))).not.toContain("state=abc");
  });

  it("can be declined or cancelled until it is opened", async () => {
    const { host, questions, tools, session, pending } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit());

      if (reply !== undefined) replies.push(reply);

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length > 0);

    const [request] = await pending();

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "The user declined Docs-Site's request for input.",
    );
  });

  it.each([
    ["http://auth.example.com/authorize", "the page isn't served over HTTPS"],
    ["https://user:pw@auth.example.com/", "the address has a username or password in it"],
    ["https://localhost:8443/", "the page is on a local or private address"],
    ["https://192.168.1.5/", "the page is on a local or private address"],
    ["https://pi.ianpascoe.dev/oauth/mcp/start", "the page is on one of cloudpid's own hosts"],
  ])("declines %s unseen, and tells the server and the agent why", async (url, reason) => {
    const { host, questions, tools, session, pending, told } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit(url));

      if (reply !== undefined) replies.push(reply);

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect(await pending()).toEqual([]);
    expect(told).toEqual([]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      `cloudpid declined Docs-Site's request for input: ${reason}`,
    );

    const [recorded] = await Effect.runPromise(questions.records);

    expect(recorded).toMatchObject({ mode: "url", action: "decline", by: "cloudpid", reason });
  });

  it("refuses an address that is not one with -32602, and a request with none", async () => {
    const { host, tools, session } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const bad = await hooks.onInput?.(visit("not a url"));

      const none = await hooks.onInput?.({
        key: "x",
        kind: "elicitation",
        params: { mode: "url", message: "Open it" },
        mode: "live",
      });

      replies.push(...[bad, none].filter((each): each is Answer => each !== undefined));

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await submitted.wait(context);

    expect(replies).toEqual([
      {
        kind: "refused",
        message: "unsupported elicitation form: the address is not a valid URL",
        code: -32602,
      },
      {
        kind: "refused",
        message: "unsupported elicitation form: the request has no page address",
        code: -32602,
      },
    ]);
  });
});

/** A host whose call is answered `-32042`: its pages are kept (`deferrable`), and the call is sent again by `resume`. */
const gated =
  (resumes: Array<Sent>, pages: ReadonlyArray<string>, again?: () => boolean) =>
  async (input: Sent, hooks: Parameters<FakeMcpAnswer>[1]) => {
    if (input.op === "resume") {
      resumes.push(input);

      if (again?.() === true) {
        const replies = await Promise.all(
          pages.map(async (key) => hooks.onInput?.(visit(PAGE, "deferrable", key))),
        );

        return replies.every((reply) => reply?.kind === "defer")
          ? McpHostInputRequired.make({
              requests: pages.map((key) => visit(PAGE, "deferrable", key)),
              resume: { ...STATE, deferred: pages, round: 2 },
              conn: "conn-docs",
            })
          : DONE;
      }

      return DONE;
    }

    const replies = await Promise.all(
      pages.map(async (key) => hooks.onInput?.(visit(PAGE, "deferrable", key))),
    );

    return replies.every((reply) => reply?.kind === "defer")
      ? McpHostInputRequired.make({
          requests: pages.map((key) => visit(PAGE, "deferrable", key)),
          resume: { ...STATE, deferred: pages },
          conn: "conn-docs",
        })
      : DONE;
  };

describe("a Legacy server's -32042", () => {
  it("is kept for the owner, and the call is sent again once every page is opened and Done is pressed", async () => {
    const { host, memory, questions, tools, told, session, pending } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(gated(resumes, ["page-1", "page-2"]));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 2);

    const requests = await pending();

    // One card per page, each saying the call is sent again; one Notification, and it says a page.
    expect(requests.map((each) => each.page)).toEqual([
      expect.objectContaining({ opened: false, retry: true, host: "auth.example.com" }),
      expect.objectContaining({ opened: false, retry: true }),
    ]);
    expect(requests.every((each) => each.waits === "owner")).toBe(true);
    expect(told).toEqual([{ server: "Docs-Site", page: true }]);

    // Done waits for every page to be opened, from any client.
    await Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "opened" }));
    await expect(
      Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "done" })),
    ).rejects.toThrow("Open every page first");
    expect(resumes).toEqual([]);

    await Effect.runPromise(questions.answer(requests[1]?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "done" }));
    await submitted.wait(context);

    // One resend, answering every page; nothing but the owner's accept goes with it.
    expect(resumes).toEqual([
      expect.objectContaining({
        op: "resume",
        params: expect.objectContaining({
          conn: "conn-docs",
          answers: {
            "page-1": { action: "accept", content: {} },
            "page-2": { action: "accept", content: {} },
          },
        }),
      }),
    ]);
    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          expect.objectContaining({
            mode: "url",
            action: "accept",
            by: "owner",
            host: "auth.example.com",
          }),
          expect.objectContaining({ mode: "url", action: "accept", by: "owner" }),
        ],
      }),
    ]);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ mode: "url", era: "legacy", action: "accept" }),
      expect.objectContaining({ mode: "url", era: "legacy", action: "accept" }),
    ]);
  });

  it("answers the whole round the same when one page is declined, and the agent is told", async () => {
    const { host, questions, tools, session, pending } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(gated(resumes, ["page-1", "page-2"]));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 2);

    const [first] = await pending();

    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(resumes).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          answers: { "page-1": { action: "decline" }, "page-2": { action: "decline" } },
        }),
      }),
    ]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "The user declined Docs-Site's request for input.",
    );
  });

  it("brings a page opened before back as not finished, with no new Notification and no count toward the cap", async () => {
    const { host, questions, tools, told, session, pending } = await setup();
    const resumes: Array<Sent> = [];
    let asksAgain = true;

    host.answer(
      gated(resumes, ["page-1"], () => {
        const again = asksAgain;

        asksAgain = false;

        return again;
      }),
    );
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 1);

    const [first] = await pending();

    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "done" }));
    await until(async () => (await pending()).some((each) => each.page?.again === true));

    const [second] = await pending();

    expect(second?.id).not.toEqual(first?.id);
    expect(second?.page).toMatchObject({ opened: false, retry: true, again: true });
    expect(told).toHaveLength(1);

    await Effect.runPromise(questions.answer(second?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(second?.id ?? "", { action: "done" }));
    await submitted.wait(context);

    expect(resumes).toHaveLength(2);
    expect(await session.texts("toolResult")).toEqual(["done"]);
  });
});
