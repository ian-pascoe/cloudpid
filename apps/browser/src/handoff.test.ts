// A Browser Handoff in the browser host (`./handoff.ts`), over a scripted CDP connection: it hands the conversation's tab
// to the owner through Browser Run's structured handoff, hears the owner finish as the `Cloudflare.handoffComplete`
// event, and finds a handoff again after the host restarts (a second `HandoffHost` over the same records).
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off
import type { Schema } from "effect";
import type * as Types from "effect/Types";
import { describe, expect, it } from "vitest";
import {
  type CdpEvent,
  type CdpParams,
  type CdpTransport,
  HandoffHost,
  type HandoffRecords,
} from "./handoff.ts";

const URL_OF_VIEW = "https://live.browser.run/ui/view?mode=tab&wss=x?jwt=SECRET-TOKEN";

const records = (): HandoffRecords => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the host reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

type Sent = { readonly method: string; readonly params?: CdpParams; readonly sessionId?: string };

/** A scripted connection: it records what it is sent, answers from `replies`, and lets a test emit events. */
const fakeTransport = (replies: Partial<Record<string, Schema.Json>> = {}) => {
  const sent: Sent[] = [];
  let listener: (event: CdpEvent) => void = () => undefined;
  let closing: () => void = () => undefined;
  const state = { closed: false };

  const transport: CdpTransport = {
    send: (method, params, sessionId) => {
      const command: Types.Mutable<Sent> = { method };

      if (params !== undefined) command.params = params;

      if (sessionId !== undefined) command.sessionId = sessionId;

      sent.push(command);

      if (state.closed) return Promise.reject(new Error("closed"));

      const defaults = {
        "Target.attachToTarget": { sessionId: "cdp-1" },
        "Cloudflare.getLiveView": { devtoolsFrontendUrl: URL_OF_VIEW },
        "Cloudflare.handoff": { targetId: "tab-1", handoffId: "handoff-1" },
        "Cloudflare.getHandoffState": { active: true, handoffId: "handoff-1" },
        "Cloudflare.handoffComplete": {},
      } satisfies Record<string, Schema.Json>;

      // SAFETY: `method in defaults` says it is one of the defaults' keys.
      return Promise.resolve(
        replies[method] ?? (method in defaults ? defaults[method as keyof typeof defaults] : null),
      );
    },
    onEvent: (next) => {
      listener = next;
    },
    onClose: (next) => {
      closing = next;
    },
    close: () => {
      state.closed = true;
      closing();
    },
  };

  return {
    transport,
    sent,
    state,
    emit: (event: CdpEvent) => listener(event),
    methods: () => sent.map((command) => command.method),
  };
};

const REQUEST = {
  requestId: "7",
  conversationId: 3,
  instructions: "Log in, then press Done",
  timeoutMs: 1_800_000,
};

const hostOver = (
  transports: ReturnType<typeof fakeTransport>[],
  store = records(),
  tab: "none" | { readonly browserSessionId: string; readonly targetId: string } = {
    browserSessionId: "browser-1",
    targetId: "tab-1",
  },
) => {
  const opened: string[] = [];
  const asked: number[] = [];

  const host = new HandoffHost({
    records: store,
    graceMs: 20,
    now: () => 1_000,
    browser: {
      tabOf: (conversationId) => {
        asked.push(conversationId);

        return Promise.resolve(tab === "none" ? undefined : tab);
      },
      connect: (browserSessionId) => {
        opened.push(browserSessionId);

        const next = transports.shift();

        return next === undefined
          ? Promise.reject(new Error("no more connections"))
          : Promise.resolve(next.transport);
      },
    },
  });

  return { host, store, opened, asked };
};

const COMPLETE = (params: Schema.Json): CdpEvent => ({
  method: "Cloudflare.handoffComplete",
  params,
  sessionId: "cdp-1",
});

describe("a Browser Handoff in the browser host", () => {
  it("attaches to the conversation's tab, mints a tab Live View link, and starts Browser Run's handoff", async () => {
    const cdp = fakeTransport();
    const { host, asked, opened } = hostOver([cdp]);

    expect(await host.start(REQUEST)).toEqual({ url: URL_OF_VIEW, startedAt: 1_000 });
    expect(asked).toEqual([3]);
    expect(opened).toEqual(["browser-1"]);

    expect(cdp.sent).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "tab-1", flatten: true } },
      {
        method: "Cloudflare.getLiveView",
        params: { mode: "tab", expiresInMs: 1_800_000 },
        sessionId: "cdp-1",
      },
      {
        method: "Cloudflare.handoff",
        params: { instructions: "Log in, then press Done", timeout: 1_800_000 },
        sessionId: "cdp-1",
      },
    ]);
  });

  it("answers a second start under the same request with the same handoff", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.start(REQUEST)).toEqual({ url: URL_OF_VIEW, startedAt: 1_000 });
    expect(cdp.methods().filter((method) => method === "Cloudflare.handoff")).toHaveLength(1);
  });

  it("fails when the conversation has no tab, or the tab cannot be attached", async () => {
    const none = hostOver([], records(), "none");

    await expect(none.host.start(REQUEST)).rejects.toThrow(/no open tab/);

    const gone = fakeTransport({});
    const broken = hostOver([gone]);

    gone.transport.send = () => Promise.reject(new Error("No target with given id"));
    await expect(broken.host.start(REQUEST)).rejects.toThrow(/tab is not available/);
    expect(gone.state.closed).toBe(true);
    expect(await broken.host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("forgets a handoff Browser Run would not start", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);
    const send = cdp.transport.send.bind(cdp.transport);

    cdp.transport.send = (method, params, sessionId) =>
      method === "Cloudflare.handoff"
        ? Promise.reject(new Error("a handoff is already active"))
        : send(method, params, sessionId);

    await expect(host.start(REQUEST)).rejects.toThrow(/already active/);
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("keeps waiting while the owner is busy, and checks with Browser Run each quiet round", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.wait("7", 20)).toEqual({ state: "waiting" });
    expect(cdp.methods().filter((method) => method === "Cloudflare.getHandoffState")).toHaveLength(
      2,
    );
  });

  it("resumes the wait the moment the owner finishes", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    const waiting = host.wait("7", 60_000);

    await new Promise((resolve) => setTimeout(resolve, 5));
    cdp.emit(COMPLETE({ handoffId: "handoff-1", success: true }));

    expect(await waiting).toEqual({ state: "complete", success: true });
    // And later rounds say the same.
    expect(await host.wait("7", 10)).toEqual({ state: "complete", success: true });
  });

  it("reports the reason the owner gave when they could not do it", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: false, reason: "No code arrived" }));

    expect(await host.wait("7", 10)).toEqual({
      state: "complete",
      success: false,
      reason: "No code arrived",
    });
  });

  it("ignores the end of another handoff on the same tab", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ handoffId: "earlier", success: true }));

    expect(await host.wait("7", 10)).toEqual({ state: "waiting" });
  });

  it("says the handoff ended without a word when Browser Run no longer has it and no event came", async () => {
    const cdp = fakeTransport({ "Cloudflare.getHandoffState": { active: false } });
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.wait("7", 10)).toEqual({ state: "ended" });
  });

  it("finds the handoff again after the host restarts, on a connection of its own, and hears it end there", async () => {
    const store = records();
    const first = fakeTransport();

    await hostOver([first], store).host.start(REQUEST);

    // A new instance over the same records: it has no connection and no listener.
    const second = fakeTransport();
    const { host, opened } = hostOver([second], store);

    const waiting = host.wait("7", 60_000);

    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emit(COMPLETE({ handoffId: "handoff-1", success: true }));

    expect(await waiting).toEqual({ state: "complete", success: true });
    expect(opened).toEqual(["browser-1"]);
    expect(second.methods()).toEqual(["Target.attachToTarget", "Cloudflare.getHandoffState"]);
  });

  it("says a handoff that ended while the host was away ended, and one whose browser is gone too", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    const over = hostOver(
      [fakeTransport({ "Cloudflare.getHandoffState": { active: false } })],
      store,
    );

    expect(await over.host.wait("7", 10)).toEqual({ state: "ended" });

    const store2 = records();

    await hostOver([fakeTransport()], store2).host.start(REQUEST);

    // No connection can be opened: the browser is gone.
    expect(await hostOver([], store2).host.wait("7", 10)).toEqual({ state: "ended" });
  });

  it("ends a handoff the owner has not finished in Browser Run, then forgets it", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    await host.end("7");

    expect(cdp.sent.at(-1)).toEqual({
      method: "Cloudflare.handoffComplete",
      params: { success: false, reason: "The agent stopped waiting" },
      sessionId: "cdp-1",
    });
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("does not end again what the owner already finished, and forgets a handoff that is not there", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: true }));
    await host.end("7");
    await host.end("nope");

    expect(cdp.methods()).not.toContain("Cloudflare.handoffComplete");
    expect(cdp.state.closed).toBe(true);
  });
});
