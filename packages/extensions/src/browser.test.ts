// The `browser` tool through real runs: a scripted model calls it in the root conversation and in a subagent, over a
// fake browser host that records what it is asked, with the Session's Secrets and keep-alive beside it.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off strictEffectProvide:off
import { type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  Browser,
  BrowserError,
  BrowserHost,
  type BrowserHostService,
  type BrowserRun,
  BrowserSession,
  type BrowserSessionService,
  MAX_IMAGE_CHARACTERS,
} from "./browser.ts";
import { secretReference } from "./secrets/references.ts";
import { call as secretsCall, openSecretsHarness } from "./secrets/harness.fixture.ts";
import { answer, call, openSubagentHarness } from "./subagents/harness.fixture.ts";

const DESCRIPTION = "Run JavaScript that drives a persistent Chrome browser.";

/** A fake browser host: it records every run it is asked for and answers with `reply`. */
const fakeHost = (reply: (code: string) => Effect.Effect<BrowserRun, BrowserError>) => {
  const runs: { code: string; conversationId: number }[] = [];

  const host: BrowserHostService = {
    describe: Effect.succeed(DESCRIPTION),
    run: (input) =>
      Effect.suspend(() => {
        runs.push(input);

        return reply(input.code);
      }),
    close: Effect.succeed(true),
  };

  return { host, runs };
};

/** A keep-alive that counts how often the browser was used. */
const fakeSession = () => {
  const uses = { count: 0 };

  const session: BrowserSessionService = {
    touch: Effect.sync(() => {
      uses.count += 1;
    }),
    closeAt: Effect.undefined,
    closeIfIdle: Effect.void,
  };

  return { session, uses };
};

const completed = (output: BrowserRun["output"]) =>
  Effect.succeed<BrowserRun>({ output, details: { status: "completed" } });

/** The `browser` extension over `host`. */
const extensionOver = (host: BrowserHostService, session = fakeSession().session) =>
  Effect.runPromise(
    Browser.pipe(
      Effect.provideService(BrowserHost, host),
      Effect.provideService(BrowserSession, session),
    ),
  );

/** The tool results among `entries`. */
const toolResults = (entries: readonly EntryRecord[]) =>
  entries.flatMap((entry) => {
    const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;

    return message?.role === "toolResult" ? [message] : [];
  });

/** The Session's model calls `browser` with `code` when it is told to "Look", and answers otherwise. */
const lookWith = (...codes: string[]) =>
  codes.length === 0
    ? answer("Looked.")
    : call(...codes.map((code) => ["browser", { code }] as const));

const looker =
  (...codes: string[]) =>
  (request: { readonly text: string }) =>
    request.text === "Look" ? lookWith(...codes) : answer("Looked.");

describe("the browser extension", () => {
  it("offers the browser tool with the host's description, and says what the Session's Secrets cannot do in it", async () => {
    const { host } = fakeHost(() => completed([]));
    const extension = await extensionOver(host);
    const [tool] = extension.tools ?? [];

    expect(tool?.name).toBe("browser");
    expect(tool?.description).toContain(DESCRIPTION);
    expect(tool?.description).toMatch(/Secret references are not resolved/);
    expect(tool?.description).toMatch(/jpeg/i);
  });

  it("still offers the tool, with a short description, when the host cannot be reached for it", async () => {
    const { host } = fakeHost(() => completed([]));

    const extension = await extensionOver({
      ...host,
      describe: Effect.fail(BrowserError.make({ message: "down" })),
    });

    expect(extension.tools?.[0]?.name).toBe("browser");
    expect(extension.tools?.[0]?.description).toMatch(/Chrome DevTools Protocol/);
  });

  it("runs the model's code in its conversation's tab, and returns what the page gave", async () => {
    const { host, runs } = fakeHost((code) => completed([{ type: "text", text: `ran ${code}` }]));

    const session = await openSubagentHarness(looker("async () => 1"), {}, [
      await extensionOver(host),
    ]);

    await session.prompt("Look");

    expect(runs).toEqual([{ code: "async () => 1", conversationId: 1 }]);
    expect(await session.texts("toolResult")).toEqual(["ran async () => 1"]);
  });

  it("gives a subagent a tab of its own: its conversation, not its parent's", async () => {
    const { host, runs } = fakeHost(() => completed([{ type: "text", text: "ok" }]));

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") {
          return request.text.startsWith("Open")
            ? call(["browser", { code: "child" }])
            : answer("Done.");
        }

        if (request.text === "Start") {
          return call(["browser", { code: "root" }], ["subagent", { task: "Open the page" }]);
        }

        return answer("Noted.");
      },
      {},
      [await extensionOver(host)],
    );

    await session.prompt("Start");
    await session.settle();

    const root = runs.find((run) => run.code === "root");
    const child = runs.find((run) => run.code === "child");

    expect(root?.conversationId).toBe(1);
    expect(child?.conversationId).toBeGreaterThan(1);
  });

  it("returns a screenshot as an image the UI shows", async () => {
    const { host } = fakeHost(() =>
      completed([
        { type: "text", text: "Screenshot attached." },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    );

    const session = await openSubagentHarness(looker("shot"), {}, [await extensionOver(host)]);

    await session.prompt("Look");

    const [result] = toolResults(await session.entries());

    expect(result?.isError).toBe(false);
    expect(result?.content).toEqual([
      { type: "text", text: "Screenshot attached." },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(result?.details).toEqual({ status: "completed" });
  });

  it("keeps a screenshot too large to store and send out of the transcript, and says how to retake it", async () => {
    const { host } = fakeHost(() =>
      completed([
        { type: "text", text: "Screenshot attached." },
        { type: "image", data: "A".repeat(MAX_IMAGE_CHARACTERS + 1), mimeType: "image/png" },
      ]),
    );

    const session = await openSubagentHarness(looker("shot"), {}, [await extensionOver(host)]);

    await session.prompt("Look");

    const [result] = toolResults(await session.entries());

    expect(result?.content.map((part) => part.type)).toEqual(["text", "text"]);
    expect(JSON.stringify(result)).not.toContain("AAAAAAAA");
    expect(result?.content[1]).toMatchObject({ text: expect.stringMatching(/jpeg.*quality/s) });
  });

  it("keeps only the image types a page may show", async () => {
    const { host } = fakeHost(() =>
      completed([{ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" }]),
    );

    const session = await openSubagentHarness(looker("shot"), {}, [await extensionOver(host)]);

    await session.prompt("Look");

    const [result] = toolResults(await session.entries());

    expect(result?.content.map((part) => part.type)).toEqual(["text"]);
    expect(JSON.stringify(result)).not.toContain("PHN2Zz4=");
  });

  it("reports code that threw as an error result", async () => {
    const { host } = fakeHost(() =>
      Effect.succeed({
        output: [{ type: "text", text: '{"status":"error","error":"boom"}' }],
        details: { status: "error" },
        isError: true,
      }),
    );

    const session = await openSubagentHarness(looker("bad"), {}, [await extensionOver(host)]);

    await session.prompt("Look");

    const [result] = toolResults(await session.entries());

    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([{ type: "text", text: '{"status":"error","error":"boom"}' }]);
  });

  it("reports a browser that cannot be reached as an error result", async () => {
    const { host } = fakeHost(() =>
      Effect.fail(BrowserError.make({ message: "Browser Run is down" })),
    );

    const session = await openSubagentHarness(looker("x"), {}, [await extensionOver(host)]);

    await session.prompt("Look");

    const [result] = toolResults(await session.entries());

    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([
      { type: "text", text: "The browser failed: Browser Run is down" },
    ]);
  });

  it("notes the browser as used by every run, even one that fails", async () => {
    const { host } = fakeHost((code) =>
      code === "fail" ? Effect.fail(BrowserError.make({ message: "down" })) : completed([]),
    );

    const { session: keepAlive, uses } = fakeSession();

    const session = await openSubagentHarness(looker("fine", "fail"), {}, [
      await extensionOver(host, keepAlive),
    ]);

    await session.prompt("Look");

    expect(uses.count).toBe(2);
  });
});

describe("the browser extension with the Session's Secrets", () => {
  const VALUE = "sk-live-abcdefghijkl";

  it("redacts a Secret's value from what the page returned", async () => {
    const { host } = fakeHost(() =>
      Effect.succeed({
        output: [{ type: "text", text: `the page says ${VALUE}` }],
        details: { echoed: VALUE },
      }),
    );

    const session = await openSecretsHarness([await extensionOver(host)]);

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Look", secretsCall("browser", { code: "async () => 1" }));

    expect(await session.lastResult()).toEqual({
      text: `the page says ${secretReference("API_KEY")}`,
      isError: false,
    });
    expect(await session.transcript()).not.toContain(VALUE);
  });

  it("does not resolve Secret references in the code: they would be stored with it", async () => {
    const { host, runs } = fakeHost(() => completed([{ type: "text", text: "ok" }]));
    const session = await openSecretsHarness([await extensionOver(host)]);
    const code = `type('${secretReference("API_KEY")}')`;

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Look", secretsCall("browser", { code }));

    expect(runs.map((run) => run.code)).toEqual([code]);
  });
});
