// The `browser` tool through real runs: a scripted model calls it in the root conversation and in a subagent, over a
// fake browser host that records what it is asked, with the Session's Secrets and keep-alive beside it.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off strictEffectProvide:off schemaSync:off
import { type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import {
  Browser,
  BrowserError,
  BrowserHandoffs,
  makeBrowserHandoffs,
  BrowserHost,
  type BrowserHostService,
  type BrowserRun,
  BrowserSession,
  type BrowserSessionService,
  makeOwnerTabDrivers,
  MAX_OWNER_TAB_TITLE,
  NO_OWNER_TABS,
  type OwnerTabDriver,
  OwnerTabDrivers,
  type OwnerTabListing,
} from "./browser.ts";
import { fakeHandoffHost, LIVE_VIEW_TOKEN } from "./browser/host.fixture.ts";
import { HandoffOutput, OwnerTabsOutput } from "./browser/outputs.ts";
import { MAX_IMAGE_CHARACTERS } from "./images.ts";
import { decodeProgramCall, programExtension, runProgram, runSized } from "./program.fixture.ts";
import { MAX_NESTED_STRUCTURED_OUTPUT_BYTES } from "./result-bounds.ts";
import { secretReference } from "./secrets/references.ts";
import { call as secretsCall, openSecretsHarness } from "./secrets/harness.fixture.ts";
import { answer, call, openSubagentHarness } from "./subagents/harness.fixture.ts";

const DESCRIPTION = "Run JavaScript that drives a persistent Chrome browser.";

/** Key-value storage in memory. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: a test's own keys, read back as what was put.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
  };
};

/**
 * A fake browser host: it records every run it is asked for and answers with `reply`; its Owner tabs are `ownerTabs`.
 */
const fakeHost = (
  reply: (code: string) => Effect.Effect<BrowserRun, BrowserError>,
  ownerTabs: OwnerTabListing = { tabs: [] },
) => {
  const runs: { code: string; conversationId: number; ownerTabId?: string }[] = [];

  const host: BrowserHostService = {
    ...fakeHandoffHost(undefined, { ownerTabs }).host,
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
    watch: Effect.succeed(false),
    closeAt: Effect.undefined,
    closeIfIdle: Effect.void,
  };

  return { session, uses };
};

const completed = (output: BrowserRun["output"]) =>
  Effect.succeed<BrowserRun>({ output, details: { status: "completed" } });

/** Runs in Owner tabs that tell no one. */
const untold = () => makeOwnerTabDrivers({ announce: () => Effect.void });

/** The `browser` extension over `host`. */
const extensionOver = (
  host: BrowserHostService,
  session = fakeSession().session,
  drivers = untold(),
) =>
  Effect.runPromise(
    Browser.pipe(
      Effect.provideService(BrowserHost, host),
      Effect.provideService(BrowserSession, session),
      Effect.provideService(OwnerTabDrivers, drivers),
      Effect.provideService(
        BrowserHandoffs,
        makeBrowserHandoffs(
          { host, storage: memoryStorage(), announce: () => Effect.void },
          session,
          {
            notify: () => Effect.void,
          },
        ),
      ),
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

const textOf = (result: { readonly content: readonly { readonly type: string }[] } | undefined) =>
  (result?.content ?? []).map((block) => ("text" in block ? String(block.text) : "")).join("");

const decodeOwnerTabs = Schema.decodeUnknownSync(OwnerTabsOutput);
const decodeHandoff = Schema.decodeUnknownSync(HandoffOutput);

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

  it("tells the agent where a dev server on the Container opens: not localhost, which Browser Run refuses, but its port's own host, listening on 0.0.0.0", async () => {
    const { host } = fakeHost(() => completed([]));
    const extension = await extensionOver(host);
    const description = extension.tools?.[0]?.description ?? "";

    expect(description).toMatch(/localhost/);
    expect(description).toContain("http://5173.cloudpid.internal/");
    expect(description).toContain("0.0.0.0");

    for (const port of [3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787]) {
      expect(description).toContain(String(port));
    }

    expect(description).not.toMatch(/\b8080\b.*cloudpid\.internal|cloudpid\.internal.*\b8080\b/);
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

  it("notes the browser as used before and after every run, even one that fails", async () => {
    const { session: keepAlive, uses } = fakeSession();
    const usesAtRun: number[] = [];

    const { host } = fakeHost((code) => {
      usesAtRun.push(uses.count);

      return code === "fail" ? Effect.fail(BrowserError.make({ message: "down" })) : completed([]);
    });

    const session = await openSubagentHarness(looker("fine", "fail"), {}, [
      await extensionOver(host, keepAlive),
    ]);

    await session.prompt("Look");

    // Used before each run began, so a Session evicted during the first still has a time to close the browser from.
    expect(usesAtRun).toEqual([1, 3]);
    expect(uses.count).toBe(4);
  });
});

describe("the browser extension in the user's Owner tabs", () => {
  // As the Browser Pane lists them: the URLs, which may carry a token, are for the owner alone.
  const OWNER_TABS: OwnerTabListing = {
    tabs: [
      { id: "tab-a", title: "An article", url: "https://news.example/story?token=SECRET-A" },
      { id: "tab-b", title: "Mail", url: "https://mail.example/inbox#code=SECRET-B" },
    ],
    shown: "tab-b",
  };

  /** Runs in Owner tabs, with each list the clients were told. */
  const telling = () => {
    const told: OwnerTabDriver[][] = [];

    const drivers = makeOwnerTabDrivers({
      announce: (current) =>
        Effect.sync(() => {
          told.push([...current]);
        }),
    });

    return { drivers, told };
  };

  it("takes an optional tab: an Owner tab's ID, or the one the Browser Pane shows", async () => {
    const { host } = fakeHost(() => completed([]));
    const [tool] = (await extensionOver(host)).tools ?? [];

    expect(JSON.stringify(tool?.parameters)).toMatch(/"tab"/);
    expect(JSON.stringify(tool?.parameters)).toMatch(/browser_owner_tabs/);
    expect(tool?.parameters).toMatchObject({ required: ["code"] });
    expect(tool?.description).toMatch(/Owner tabs/);
  });

  it("runs the model's code in the Owner tab it names, by ID or as the one shown, and tells the clients while it drives it", async () => {
    const { drivers, told } = telling();
    const whileRunning: Array<ReadonlyArray<OwnerTabDriver>> = [];

    const { host, runs } = fakeHost(
      () =>
        drivers.current.pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              whileRunning.push(current);
            }),
          ),
          Effect.andThen(completed([{ type: "text", text: "the article says X" }])),
        ),
      OWNER_TABS,
    );

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Look"
          ? call(
              ["browser", { code: "read", tab: "tab-a" }],
              ["browser", { code: "read shown", tab: "shown" }],
              ["browser", { code: "mine" }],
            )
          : answer("Looked."),
      {},
      [await extensionOver(host, fakeSession().session, drivers)],
    );

    await session.prompt("Look");

    expect(runs).toEqual([
      { code: "read", conversationId: 1, ownerTabId: "tab-a" },
      { code: "read shown", conversationId: 1, ownerTabId: "tab-b" },
      { code: "mine", conversationId: 1 },
    ]);
    expect(await session.texts("toolResult")).toEqual([
      "the article says X",
      "the article says X",
      "the article says X",
    ]);
    expect(whileRunning).toEqual([
      [{ ownerTabId: "tab-a", conversationId: 1 }],
      [{ ownerTabId: "tab-b", conversationId: 1 }],
      [],
    ]);
    expect(told).toEqual([
      [{ ownerTabId: "tab-a", conversationId: 1 }],
      [],
      [{ ownerTabId: "tab-b", conversationId: 1 }],
      [],
    ]);
  });

  it("names a subagent's run in an Owner tab by the subagent's conversation", async () => {
    const { drivers, told } = telling();
    const { host, runs } = fakeHost(() => completed([]), OWNER_TABS);

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "agent-1") {
          return request.text.startsWith("Read")
            ? call(["browser", { code: "child", tab: "tab-a" }])
            : answer("Done.");
        }

        return request.text === "Start"
          ? call(["subagent", { task: "Read the article" }])
          : answer("Noted.");
      },
      {},
      [await extensionOver(host, fakeSession().session, drivers)],
    );

    await session.prompt("Start");
    await session.settle();

    const child = runs.find((run) => run.code === "child");

    expect(child?.conversationId).toBeGreaterThan(1);
    expect(child?.ownerTabId).toBe("tab-a");
    expect(told[0]).toEqual([{ ownerTabId: "tab-a", conversationId: child?.conversationId }]);
    expect(told.at(-1)).toEqual([]);
  });

  it("tells the model the user has no Owner tabs, and that they open them in the Browser Pane, running nothing", async () => {
    const { drivers, told } = telling();
    const { host, runs } = fakeHost(() => completed([]));

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Look"
          ? call(["browser", { code: "read", tab: "shown" }], ["browser_owner_tabs", {}])
          : answer("There are none."),
      {},
      [await extensionOver(host, fakeSession().session, drivers)],
    );

    await session.prompt("Look");

    const results = toolResults(await session.entries());

    expect(runs).toEqual([]);
    expect(told).toEqual([]);
    expect(results.map((result) => [result.isError, result.content])).toEqual([
      [true, [{ type: "text", text: NO_OWNER_TABS }]],
      [false, [{ type: "text", text: NO_OWNER_TABS }]],
    ]);
    expect(NO_OWNER_TABS).toMatch(/Browser Pane/);
    expect(NO_OWNER_TABS).toMatch(/cannot open it/);
  });

  it("lists the Owner tabs without a run: each one's ID, title and origin, and which one is shown", async () => {
    const { host, runs } = fakeHost(() => completed([]), OWNER_TABS);

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Which tabs?" ? call(["browser_owner_tabs", {}]) : answer("Two."),
      {},
      [await extensionOver(host)],
    );

    await session.prompt("Which tabs?");

    const [listing] = toolResults(await session.entries());

    expect(runs).toEqual([]);
    expect(listing?.isError).toBe(false);
    expect(listing?.content).toEqual([
      {
        type: "text",
        text: [
          "The user's Owner tabs (titles are the pages' own words):",
          '- tab-a: "An article", https://news.example',
          '- tab-b (shown in the Browser Pane): "Mail", https://mail.example',
          'Pass an ID as browser\'s tab, or "shown" for the one the Browser Pane shows.',
        ].join("\n"),
      },
    ]);
    expect(listing?.details).toEqual({
      ownerTabs: [
        { id: "tab-a", shown: false },
        { id: "tab-b", shown: true },
      ],
    });
    expect(JSON.stringify(await session.entries())).not.toMatch(/SECRET|story|inbox/);
  });

  it("tells the model a page's origin only, a blank page's scheme, and a title cut to MAX_OWNER_TAB_TITLE", async () => {
    const { host } = fakeHost(() => completed([]), {
      tabs: [
        { id: "tab-a", title: "x".repeat(MAX_OWNER_TAB_TITLE + 50), url: "about:blank" },
        { id: "tab-b", title: "" },
      ],
    });

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Which tabs?" ? call(["browser_owner_tabs", {}]) : answer("Two."),
      {},
      [await extensionOver(host)],
    );

    await session.prompt("Which tabs?");

    const [listing] = toolResults(await session.entries());

    expect(listing?.content[0]).toMatchObject({
      text: expect.stringContaining(
        `- tab-a: "${"x".repeat(MAX_OWNER_TAB_TITLE)}", about:blank\n- tab-b: "", no address\n`,
      ),
    });
  });

  it("names the Owner tabs open when the one asked for is not, running nothing", async () => {
    const { host, runs } = fakeHost(() => completed([]), OWNER_TABS);

    const other = await openSubagentHarness(
      (request) =>
        request.text === "Look"
          ? call(["browser", { code: "read", tab: "tab-z" }])
          : answer("Not there."),
      {},
      [await extensionOver(host)],
    );

    await other.prompt("Look");

    const [result] = toolResults(await other.entries());

    expect(runs).toEqual([]);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({
      text: expect.stringMatching(
        /^There is no Owner tab tab-z open\. Nothing ran\.\n\n.*- tab-a: "An article"/s,
      ),
    });
  });

  it("gives a program the Owner tabs as data: ID, title, origin and which one is shown, never a URL", async () => {
    const { host } = fakeHost(() => completed([]), OWNER_TABS);

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Which tabs?"
          ? call(["program", { tool: "browser_owner_tabs", args: {} }])
          : answer("Two."),
      {},
      [programExtension, await extensionOver(host)],
    );

    await session.prompt("Which tabs?");

    const got = decodeProgramCall(textOf(toolResults(await session.entries())[0]));

    expect(got).toMatchObject({ isError: false, diagnostics: [] });
    expect(decodeOwnerTabs(got.structuredOutput)).toEqual({
      tabs: [
        { id: "tab-a", title: "An article", origin: "https://news.example", shown: false },
        { id: "tab-b", title: "Mail", origin: "https://mail.example", shown: true },
      ],
      tabs_truncated: false,
    });
    expect(JSON.stringify(got)).not.toMatch(/SECRET|story|inbox/);
  });

  it("gives a program an empty list when no Owner tab is open", async () => {
    const { host } = fakeHost(() => completed([]));

    const session = await openSubagentHarness(
      (request) =>
        request.text === "Which tabs?"
          ? call(["program", { tool: "browser_owner_tabs", args: {} }])
          : answer("None."),
      {},
      [programExtension, await extensionOver(host)],
    );

    await session.prompt("Which tabs?");

    const got = decodeProgramCall(textOf(toolResults(await session.entries())[0]));

    expect(got).toMatchObject({ isError: false, diagnostics: [] });
    expect(decodeOwnerTabs(got.structuredOutput)).toEqual({ tabs: [], tabs_truncated: false });
  });

  it("cuts a long list of Owner tabs, and the call still succeeds", async () => {
    const tabs = Array.from({ length: 2000 }, (_, index) => ({
      id: `tab-${index}`,
      title: "T".repeat(MAX_OWNER_TAB_TITLE),
      url: `https://site${index}.example/path`,
    }));

    const { host } = fakeHost(() => completed([]), { tabs, shown: "tab-0" });
    const [got] = await runSized([await extensionOver(host)], [["browser_owner_tabs", {}]]);

    // The text is cut too, which pi-durable says in a diagnostic: the value is what is under test.
    expect(got).toMatchObject({
      isError: false,
      truncated: { tabs_truncated: true },
    });
    expect(got?.lengths.tabs).toBeGreaterThan(0);
    expect(got?.lengths.tabs).toBeLessThan(tabs.length);
    expect(got?.bytes).toBeLessThan(MAX_NESTED_STRUCTURED_OUTPUT_BYTES);
  });
});

describe("browser_handoff", () => {
  /** The Browser extension over a host whose handoffs go as `waits` scripts, with what the owner was shown and pushed. */
  const handingOver = async (
    waits: Parameters<typeof fakeHandoffHost>[0],
    options: Parameters<typeof fakeHandoffHost>[1] = {},
  ) => {
    const { host, calls } = fakeHandoffHost(waits, options);
    const announced: unknown[] = [];
    const notices: unknown[] = [];
    const keepAlive = fakeSession().session;

    const handoffs = makeBrowserHandoffs(
      {
        host,
        storage: memoryStorage(),
        announce: (requests) =>
          Effect.sync(() => {
            announced.push(requests);
          }),
      },
      keepAlive,
      {
        notify: (event) =>
          Effect.sync(() => {
            notices.push(event);
          }),
      },
    );

    const extension = await Effect.runPromise(
      Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, keepAlive),
        Effect.provideService(OwnerTabDrivers, untold()),
        Effect.provideService(BrowserHandoffs, handoffs),
      ),
    );

    return { extension, calls, announced, notices };
  };

  const handoffScript = (request: { readonly text: string }) =>
    request.text === "Log me in"
      ? call(["browser_handoff", { instructions: "Sign in, then press Done" }])
      : answer("Back.");

  it("gives the owner the instructions and the way to the Live View, and resumes the model with only how it ended", async () => {
    const { extension, calls, announced, notices } = await handingOver([
      { state: "complete", success: true },
    ]);

    const session = await openSubagentHarness(handoffScript, {}, [extension]);

    await session.prompt("Log me in");

    expect(calls.started).toMatchObject([
      { conversationId: 1, instructions: "Sign in, then press Done" },
    ]);
    expect(announced[0]).toMatchObject([
      { conversationId: 1, instructions: "Sign in, then press Done" },
    ]);
    // In the background: the call does not wait for the push, which opens the handoff's Live View Pane.
    await vi.waitFor(() =>
      expect(notices).toMatchObject([
        { kind: "notice", url: expect.stringMatching(/^\?pane=live-view:/) },
      ]),
    );

    const [result] = toolResults(await session.entries());

    expect(result?.isError).toBe(false);
    expect(result?.content).toEqual([
      { type: "text", text: expect.stringMatching(/The user finished the handoff/) },
    ]);
    expect(result?.details).toEqual({ status: "completed" });
  });

  it("tells the model when the owner could not do it", async () => {
    const { extension } = await handingOver([
      { state: "complete", success: false, reason: "The code never came" },
    ]);

    const session = await openSubagentHarness(handoffScript, {}, [extension]);

    await session.prompt("Log me in");

    const [result] = toolResults(await session.entries());

    expect(result?.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("could not complete the handoff: The code never came"),
      },
    ]);
    expect(result?.details).toEqual({ status: "failed" });
  });

  it("tells the model how many windows the tab left open, and each one's origin only", async () => {
    const { extension } = await handingOver([{ state: "complete", success: true }], {
      windowOrigins: ["https://accounts.example.com", "about:blank"],
    });

    const session = await openSubagentHarness(handoffScript, {}, [extension]);

    await session.prompt("Log me in");

    const [result] = toolResults(await session.entries());

    expect(result?.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          "The tab opened 2 windows that are still open (pop-ups or new tabs): https://accounts.example.com, about:blank.",
        ),
      },
    ]);
  });

  it("tells the model it does not know which windows are open when the host could not say", async () => {
    const { extension } = await handingOver([{ state: "complete", success: true }]);
    const { host } = fakeHandoffHost([{ state: "complete", success: true }]);

    const unsure = await Effect.runPromise(
      Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, fakeSession().session),
        Effect.provideService(OwnerTabDrivers, untold()),
        Effect.provideService(
          BrowserHandoffs,
          makeBrowserHandoffs(
            {
              host: { ...host, endHandoff: () => Effect.succeed({}) },
              storage: memoryStorage(),
              announce: () => Effect.void,
            },
            fakeSession().session,
            { notify: () => Effect.void },
          ),
        ),
      ),
    );

    for (const [installed, expected] of [
      [extension, /^(?!.*not known).*$/s],
      [unsure, /Whether the tab left windows it opened \(pop-ups or new tabs\) open is not known/],
    ] as const) {
      const session = await openSubagentHarness(handoffScript, {}, [installed]);

      await session.prompt("Log me in");

      const [result] = toolResults(await session.entries());

      expect(result?.content).toEqual([{ type: "text", text: expect.stringMatching(expected) }]);
    }
  });

  it("reports a browser that cannot hand over a tab as an error result", async () => {
    const { host } = fakeHandoffHost([], {
      start: () => Effect.fail(BrowserError.make({ message: "The conversation has no tab open" })),
    });

    const keepAlive = fakeSession().session;

    const extension = await Effect.runPromise(
      Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, keepAlive),
        Effect.provideService(OwnerTabDrivers, untold()),
        Effect.provideService(
          BrowserHandoffs,
          makeBrowserHandoffs(
            { host, storage: memoryStorage(), announce: () => Effect.void },
            keepAlive,
            {
              notify: () => Effect.void,
            },
          ),
        ),
      ),
    );

    const session = await openSubagentHarness(handoffScript, {}, [extension]);

    await session.prompt("Log me in");

    const [result] = toolResults(await session.entries());

    expect(result?.isError).toBe(true);
    expect(result?.content).toEqual([
      { type: "text", text: "The browser handoff failed: The conversation has no tab open" },
    ]);
  });

  it("never lets the Live View link into the transcript or a model request", async () => {
    const { extension } = await handingOver([{ state: "complete", success: true }]);
    const session = await openSubagentHarness(handoffScript, {}, [extension]);

    await session.prompt("Log me in");
    await session.prompt("Anything else?");

    // The call reached the model's next requests as its result, and the whole transcript holds only that.
    expect(session.requests.length).toBeGreaterThanOrEqual(3);

    for (const surface of [
      JSON.stringify(await session.entries()),
      JSON.stringify(session.requests.map((request) => request.messages)),
      JSON.stringify(session.requests.map((request) => request.system)),
    ]) {
      expect(surface).not.toContain(LIVE_VIEW_TOKEN);
      expect(surface).not.toContain("live.browser.run");
    }
  });

  it("gives a program how the handoff ended: completed, failed with the owner's reason, or ended unsaid", async () => {
    const outcomes = [
      {
        script: { state: "complete", success: true } as const,
        want: { status: "completed", reason: null },
      },
      {
        script: { state: "complete", success: false, reason: "The code never came" } as const,
        want: { status: "failed", reason: "The code never came" },
      },
      { script: { state: "ended" } as const, want: { status: "ended", reason: null } },
    ];

    for (const { script, want } of outcomes) {
      const { extension } = await handingOver([script], {
        windowOrigins: ["https://auth.example"],
      });

      const session = await openSubagentHarness(
        (request) =>
          request.text === "Log me in"
            ? call([
                "program",
                { tool: "browser_handoff", args: { instructions: "Sign in, then press Done" } },
              ])
            : answer("Back."),
        {},
        [programExtension, extension],
      );

      await session.prompt("Log me in");

      const got = decodeProgramCall(textOf(toolResults(await session.entries())[0]));

      expect(got).toMatchObject({ isError: false, diagnostics: [] });
      expect(decodeHandoff(got.structuredOutput)).toEqual({
        ...want,
        reason_truncated: false,
        windows: ["https://auth.example"],
        windows_truncated: false,
      });
      expect(JSON.stringify(got)).not.toContain(LIVE_VIEW_TOKEN);
    }
  });

  it("gives a program no windows list when the host could not say which are open, and cuts a long reason", async () => {
    const { host } = fakeHandoffHost([
      { state: "complete", success: false, reason: "R".repeat(400_000) },
    ]);

    const extension = await Effect.runPromise(
      Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, fakeSession().session),
        Effect.provideService(OwnerTabDrivers, untold()),
        Effect.provideService(
          BrowserHandoffs,
          makeBrowserHandoffs(
            {
              host: { ...host, endHandoff: () => Effect.succeed({}) },
              storage: memoryStorage(),
              announce: () => Effect.void,
            },
            fakeSession().session,
            { notify: () => Effect.void },
          ),
        ),
      ),
    );

    const steps = [["browser_handoff", { instructions: "Sign in" }]] as const;
    const [got] = await runProgram([extension], steps);
    const ended = decodeHandoff(got?.structuredOutput);

    // The text carries the reason too, which pi-durable cuts and says in a diagnostic: the value is what is under test.
    expect(got?.isError).toBe(false);
    expect(ended).toMatchObject({ status: "failed", windows: null, reason_truncated: true });
    expect(ended.reason).toMatch(/^<\d+ characters>$/);

    const [sized] = await runSized([extension], steps);

    expect(sized).toMatchObject({ isError: false, truncated: { reason_truncated: true } });
    expect(sized?.bytes).toBeLessThan(MAX_NESTED_STRUCTURED_OUTPUT_BYTES);
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
