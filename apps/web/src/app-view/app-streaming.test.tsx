// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting), Lifecycle (Mounting, Cancelled). A call of an App
// tool as it streams, through the whole path: pi's events folded into the view (`reduceEvents`), the thread's messages
// (`toThreadMessages`), assistant-ui's own rendering of them and the real card (`ToolCallCard`) with its View's real frame
// and bridge; only the Session's socket and the sandbox page are replaced. The View mounts as the call starts, is sent the
// partial input, the final input at the commit and the result at the end, and the frame is the same element throughout:
// nothing remounts on the commit.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame and pi's events as the reducer reads them */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { McpAppEntry, McpAppRecord, McpAppTool, SessionView } from "@cloudpid/protocol";
import { EMPTY_VIEW, reduceEvents } from "@cloudpid/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShownSession } from "../chat/conversation.ts";
import { ToolCallCard } from "../chat/parts.tsx";
import { RegistryClient } from "../registry.ts";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { sessionClientAtom, sessionViewAtom } from "../session/atoms.ts";
import { INITIAL_SESSION_STATE, type SessionState } from "../session/state.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { sessionListAtom } from "../sessions.ts";
import { keyValueStoreLayer } from "../storage.ts";
import { AppPlacesContext } from "./app-call.tsx";
import { appKey, appLoadAtom, appRunningAtom, runningKey } from "./atoms.ts";
import { installFakeFrames, ORIGIN, viewOf } from "./frame-kit.testing.ts";
import type { AppPage } from "./load.ts";
import { AppPlaces } from "./places.ts";

const NAME = "mcp__docs__page";

const TOOL: McpAppTool = {
  name: NAME,
  server: "docs",
  tool: "page",
  uri: "ui://docs/page",
  visibility: ["model", "app"],
};

const PAGE: AppPage = { html: "<p>view</p>", meta: {}, origin: ORIGIN };

const record: McpAppRecord = {
  callId: "c1",
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: { title: "Hello", rows: ["abc"] },
  result: { content: [{ type: "text", text: "done" }] },
  audit: [],
  at: 1,
};

const entry: McpAppEntry = { callId: "c1", server: "docs", tool: "page", state: "kept", at: 1 };

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// The events and entries are the parts of pi's shapes the reducer reads.
type AgentEvent = Parameters<typeof reduceEvents>[1][number];

const event = (value: Record<string, unknown>): AgentEvent => value as unknown as AgentEvent;
const entryOf = (value: Record<string, unknown>): Record<string, unknown> => value;

const call = (args: Record<string, unknown>) => ({
  type: "toolCall",
  id: "c1",
  name: NAME,
  arguments: args,
});

const message = (content: unknown[]) => ({
  role: "assistant",
  content,
  api: "",
  provider: "p",
  model: "m",
  usage,
  stopReason: "toolUse",
  timestamp: 2,
});

const update = (...changes: Record<string, unknown>[]) =>
  event({ type: "message_update", usage, changes });

installFakeFrames();

let host: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let state: SubscriptionRef.SubscriptionRef<SessionState>;
let view: SessionView;
let apps: readonly McpAppEntry[];

const publish = () => {
  Effect.runSync(
    SubscriptionRef.set(state, {
      ...INITIAL_SESSION_STATE,
      view,
      mcpAppTools: [TOOL],
      mcpApps: { "1": apps },
    }),
  );
};

/** Pi's events reach the page: folded as the client folds them, with the App tools' names. */
const happens = async (...events: AgentEvent[]) => {
  view = reduceEvents(view, events, new Set([NAME]));
  publish();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

const clientOf = () => {
  const takes = () => ({ appMessages: false, appContext: false });
  const own = new Map<string, unknown>(Object.entries({ state, takes }));

  return new Proxy(
    {},
    {
      get: (_target, key) => (Predicate.isString(key) ? (own.get(key) ?? Effect.void) : undefined),
    },
  );
};

/** assistant-ui's own rendering of the thread's messages, each call by the real card. */
const Chat = () => {
  const shown = useAtomValue(sessionViewAtom("s1"));

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: toThreadMessages(shown),
    convertMessage: (each) => each,
    isRunning: shown.running,
    onNew: () => Promise.resolve(),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages>
          {({ message: each }) =>
            each.role === "assistant" ? (
              <MessagePrimitive.Root>
                <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCallCard } }} />
              </MessagePrimitive.Root>
            ) : (
              <MessagePrimitive.Root>user</MessagePrimitive.Root>
            )
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

beforeEach(() => {
  // @ts-expect-error -- React's flag that its updates are wrapped in `act` in this test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // happy-dom reports each frame page it was told not to load.
  vi.spyOn(window.console, "error").mockImplementation(() => undefined);
  vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  window.history.replaceState(null, "", "/sessions/s1");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

/** What a test seeds: the `view` that names the origin its running page is of, and what its call's record pins. */
interface Seed {
  readonly pageView?: string;
  readonly recordView?: string;
  readonly recordServer?: string;
}

/** The Session as the page holds it, with the user's message; and the page of the call's tool and its record, as loads would give. */
const start = async (seed: Seed = {}) => {
  view = reduceEvents(EMPTY_VIEW, [
    event({ type: "run_start", inputs: [1] }),
    event({
      type: "entry_appended",
      entry: entryOf({
        id: 1,
        conversationId: 1,
        kind: "pi.user",
        model: [{ role: "user", content: "show me", timestamp: 1 }],
      }),
    }),
  ]);

  apps = [];
  state = Effect.runSync(SubscriptionRef.make(INITIAL_SESSION_STATE));
  publish();

  // What the record pins, as the Session kept it: the origin's `viewHash` and the server's name.
  const server = seed.recordServer ?? record.server;

  const pinned: McpAppRecord =
    seed.recordView === undefined
      ? { ...record, server }
      : { ...record, server, viewHash: seed.recordView };

  registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(keyValueStoreLayer, KeyValueStore.layerStorage(memoryStorage)),
      Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer({})),
      // SAFETY: a stand-in for the client, which a page reads its state through.
      Atom.initialValue(sessionClientAtom("s1"), AsyncResult.success(clientOf() as never)),
      // SAFETY: the list is read for `archivedAt` and the Environment, which is all this gives.
      Atom.initialValue(sessionListAtom, [] as never),
      // The page of the tool's View, for a call that runs; the call's record, once it has one.
      Atom.initialValue(
        appRunningAtom(runningKey("s1", "c1", NAME)),
        AsyncResult.success({
          status: "running" as const,
          page: seed.pageView === undefined ? PAGE : { ...PAGE, view: seed.pageView },
        }),
      ),
      Atom.initialValue(
        appLoadAtom(appKey("s1", "c1")),
        // The record's page is another object, as a load of its own would make it: the frame is not swapped for it.
        AsyncResult.success({
          status: "view" as const,
          record: pinned,
          page: { ...PAGE },
        }),
      ),
    ],
  });
  registry.mount(appRunningAtom(runningKey("s1", "c1", NAME)));
  registry.mount(appLoadAtom(appKey("s1", "c1")));

  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <ShownSession.Provider value="s1">
          <AppPlacesContext value={new AppPlaces()}>
            <Chat />
          </AppPlacesContext>
        </ShownSession.Provider>
      </RegistryContext.Provider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

afterEach(() => {
  act(() => {
    root.unmount();
  });
  registry.dispose();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const frames = () => Array.from(host.querySelectorAll("iframe"));

const partials = (shownView: ReturnType<typeof viewOf>) =>
  shownView.sent.flatMap((each) =>
    each.data["method"] === "ui/notifications/tool-input-partial"
      ? [(each.data["params"] as { arguments: unknown }).arguments]
      : [],
  );

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("an App call as it streams", () => {
  it("mounts at toolcall_start, streams its partial input, and the commit and the result remount nothing", async () => {
    await start();
    await happens(event({ type: "message_start", message: message([]) }));
    expect(frames()).toHaveLength(0);

    await happens(
      update({
        type: "toolcall_start",
        contentIndex: 0,
        block: call({ title: "", rows: ["a"] }),
      }),
    );

    // The View mounts as the call starts, before any argument has arrived.
    expect(frames()).toHaveLength(1);

    const frame = frames()[0] as HTMLIFrameElement;
    const shown = viewOf(frame);

    shown.handshake();
    expect(partials(shown)).toEqual([{ title: "", rows: ["a"] }]);

    // Tokens arrive faster than the interval: the latest goes when it is up, not each.
    await happens(
      update({ type: "toolcall_delta", contentIndex: 0, path: ["title"], delta: "Hel" }),
    );
    await happens(
      update({ type: "toolcall_delta", contentIndex: 0, path: ["title"], delta: "lo" }),
    );
    expect(partials(shown)).toHaveLength(1);
    await tick(250);
    expect(partials(shown).at(-1)).toEqual({ title: "Hello", rows: ["a"] });

    await happens(
      update({ type: "toolcall_delta", contentIndex: 0, path: ["rows", 0], delta: "bc" }),
    );

    // The commit: the live message becomes the entry. The frame is the same element, and gets the final input once.
    await happens(
      event({
        type: "message_end",
        entry: entryOf({
          id: 2,
          conversationId: 1,
          kind: "pi.assistant",
          model: [message([call({ title: "Hello", rows: ["abc"] })])],
        }),
      }),
    );
    expect(frames()).toEqual([frame]);
    expect(
      shown.methods().filter((method) => method === "ui/notifications/tool-input"),
    ).toHaveLength(1);
    expect(
      shown.sent.find((each) => each.data["method"] === "ui/notifications/tool-input")?.data[
        "params"
      ],
    ).toEqual({ arguments: { title: "Hello", rows: ["abc"] } });

    // The tool runs, ends, and its record and result entry arrive: the result reaches the same View.
    await happens(
      event({ type: "tool_execution_start", toolCallId: "c1", toolName: NAME, args: {} }),
    );
    expect(frames()).toEqual([frame]);

    apps = [entry];
    await happens(
      event({
        type: "entry_appended",
        entry: entryOf({
          id: 3,
          conversationId: 1,
          kind: "pi.tool",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: NAME,
              content: [{ type: "text", text: "done" }],
              isError: false,
              timestamp: 3,
            },
          ],
        }),
      }),
    );
    await happens(event({ type: "tool_execution_end", toolCallId: "c1", toolName: NAME }));
    await happens(event({ type: "run_end", inputs: [1] }));

    expect(frames()).toEqual([frame]);
    expect(shown.methods().at(-1)).toBe("ui/notifications/tool-result");
    expect(shown.methods()).not.toContain("ui/resource-teardown");
    expect(shown.methods()).not.toContain("ui/notifications/tool-cancelled");
  });

  it("tells the View its call did not finish when its message is cut, and keeps it mounted", async () => {
    await start();
    await happens(event({ type: "message_start", message: message([]) }));
    await happens(
      update({ type: "toolcall_start", contentIndex: 0, block: call({ title: "Hel", rows: [] }) }),
    );

    const frame = frames()[0] as HTMLIFrameElement;
    const shown = viewOf(frame);

    shown.handshake();

    // Stop: the message is committed as it was cut, and no tool runs.
    await happens(
      event({
        type: "message_end",
        entry: entryOf({
          id: 2,
          conversationId: 1,
          kind: "pi.assistant",
          model: [{ ...message([call({ title: "Hel", rows: [] })]), stopReason: "aborted" }],
        }),
      }),
    );
    await happens(event({ type: "run_end", inputs: [1] }));

    expect(shown.methods().at(-1)).toBe("ui/notifications/tool-cancelled");
    expect(frames()).toEqual([frame]);
  });

  it("sends tool-cancelled before the teardown when the call goes from the transcript unfinished", async () => {
    await start();
    await happens(event({ type: "message_start", message: message([]) }));
    await happens(
      update({ type: "toolcall_start", contentIndex: 0, block: call({ title: "Hel", rows: [] }) }),
    );

    const shown = viewOf(frames()[0] ?? null);

    shown.handshake();

    // The run ends and the message that was streaming is dropped, not committed.
    await happens(event({ type: "run_end", inputs: [1] }));

    expect(shown.methods().slice(-2)).toEqual([
      "ui/notifications/tool-cancelled",
      "ui/resource-teardown",
    ]);
  });

  it("does not mount a View for a stopped call that was never seen running: a later load shows the summary", async () => {
    await start();
    view = reduceEvents(view, [
      event({
        type: "entry_appended",
        entry: entryOf({
          id: 2,
          conversationId: 1,
          kind: "pi.assistant",
          model: [{ ...message([call({ title: "Hel", rows: [] })]), stopReason: "aborted" }],
        }),
      }),
      event({ type: "run_end", inputs: [1] }),
    ]);
    publish();
    await tick(0);

    expect(host.textContent).toContain(NAME);
    expect(frames()).toHaveLength(0);
  });

  /** The call streams and commits, and its tool runs; its View is up and ready. */
  const running = async () => {
    await happens(event({ type: "message_start", message: message([]) }));
    await happens(
      update({ type: "toolcall_start", contentIndex: 0, block: call({ title: "", rows: [] }) }),
    );

    const frame = frames()[0] as HTMLIFrameElement;
    const shown = viewOf(frame);

    shown.handshake();
    await happens(
      event({
        type: "message_end",
        entry: entryOf({
          id: 2,
          conversationId: 1,
          kind: "pi.assistant",
          model: [message([call({ title: "Hello", rows: ["abc"] })])],
        }),
      }),
    );
    await happens(
      event({ type: "tool_execution_start", toolCallId: "c1", toolName: NAME, args: {} }),
    );

    return { frame, shown };
  };

  /** The tool ends with its result entry; its record is in the Session's list only when `recorded`. */
  const ends = async (recorded: boolean) => {
    apps = recorded ? [entry] : [];
    await happens(
      event({
        type: "entry_appended",
        entry: entryOf({
          id: 3,
          conversationId: 1,
          kind: "pi.tool",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: NAME,
              content: [{ type: "text", text: "done" }],
              isError: false,
              timestamp: 3,
            },
          ],
        }),
      }),
    );
    await happens(event({ type: "tool_execution_end", toolCallId: "c1", toolName: NAME }));
    await happens(event({ type: "run_end", inputs: [1] }));
  };

  it("delivers the record's result when its viewHash is the one the page was read for", async () => {
    await start({ pageView: "v-docs", recordView: "v-docs" });

    const { frame, shown } = await running();

    await ends(true);
    expect(frames()).toEqual([frame]);
    expect(shown.methods().at(-1)).toBe("ui/notifications/tool-result");
  });

  it("never delivers a record of another server to the View made before it: it is told the call is over, torn down, and the card says it is unavailable", async () => {
    // The inventory named one server when the call started, and the call ran on another with the same name.
    await start({ pageView: "v-repo", recordView: "v-owner" });

    const { shown } = await running();

    await ends(true);

    const methods = shown.methods();

    expect(methods).not.toContain("ui/notifications/tool-result");
    expect(methods.slice(-2)).toEqual(["ui/notifications/tool-cancelled", "ui/resource-teardown"]);

    shown.answerTeardown();
    await tick(0);
    expect(frames()).toHaveLength(0);
    expect(host.textContent).toContain("App unavailable");
    expect(shown.methods()).not.toContain("ui/notifications/tool-result");
  });

  it("never delivers a record whose server's name is not the page's, when the record pins no viewHash", async () => {
    await start({ pageView: "v-docs", recordServer: "other" });

    const { shown } = await running();

    await ends(true);
    expect(shown.methods()).not.toContain("ui/notifications/tool-result");
    expect(shown.methods().slice(-2)).toEqual([
      "ui/notifications/tool-cancelled",
      "ui/resource-teardown",
    ]);
  });

  it("tells the View its call is over when the call has its result and no record comes", async () => {
    await start({ pageView: "v-docs", recordView: "v-docs" });

    const { frame, shown } = await running();

    await ends(false);

    // The record's list comes on its own: a grace first.
    await tick(1900);
    expect(shown.methods()).not.toContain("ui/notifications/tool-cancelled");

    await tick(200);
    expect(shown.methods().at(-1)).toBe("ui/notifications/tool-cancelled");
    expect(frames()).toEqual([frame]);
  });

  it("delivers a record that comes within the grace, and says nothing of a cancel", async () => {
    await start({ pageView: "v-docs", recordView: "v-docs" });

    const { shown } = await running();

    await ends(false);
    await tick(1000);
    apps = [entry];
    publish();
    await tick(2500);
    expect(shown.methods().at(-1)).toBe("ui/notifications/tool-result");
    expect(shown.methods()).not.toContain("ui/notifications/tool-cancelled");
  });
});
