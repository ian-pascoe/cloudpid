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
  BrowserGoneError,
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
    list: <T>({ prefix }: { readonly prefix: string }) =>
      // SAFETY: the host reads back only what it wrote under each prefix.
      [...map].filter(([key]) => key.startsWith(prefix)) as [string, T][],
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
  clock = { now: 1_000 },
) => {
  const opened: string[] = [];
  const asked: number[] = [];
  const scheduled: number[] = [];

  const host = new HandoffHost({
    records: store,
    graceMs: 20,
    now: () => clock.now,
    schedule: (at) => scheduled.push(at),
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

  return { host, store, opened, asked, scheduled, clock };
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

    // Browser Run says the browser is gone.
    const gone = new HandoffHost({
      records: store2,
      now: () => 1_000,
      browser: {
        tabOf: () => Promise.resolve(undefined),
        connect: () => Promise.reject(new BrowserGoneError("gone")),
      },
    });

    expect(await gone.wait("7", 10)).toEqual({ state: "ended" });
  });

  it("asks the Session again when the connection cannot be reopened for another reason", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    // The host has no connection to give: a network failure, not Browser Run saying the browser is gone.
    await expect(hostOver([], store).host.wait("7", 10)).rejects.toThrow(/no more connections/);

    // The handoff is still there for the next round.
    const next = fakeTransport();

    expect(await hostOver([next], store).host.wait("7", 10)).toEqual({ state: "waiting" });
  });

  it("counts an event that comes before Browser Run answers the handoff command as the handoff's end", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);
    const send = cdp.transport.send.bind(cdp.transport);

    cdp.transport.send = async (method, params, sessionId) => {
      const answer = await send(method, params, sessionId);

      if (method === "Cloudflare.handoff") {
        cdp.emit(COMPLETE({ handoffId: "handoff-1", success: true }));
      }

      return answer;
    };

    await host.start(REQUEST);

    expect(await host.wait("7", 10)).toEqual({ state: "complete", success: true });
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

  it("ends a handoff over a new connection when the host restarted since it started", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    const restarted = fakeTransport();
    const { host, opened } = hostOver([restarted], store);

    await host.end("7");

    expect(opened).toEqual(["browser-1"]);
    expect(restarted.sent.at(-1)).toEqual({
      method: "Cloudflare.handoffComplete",
      params: { success: false, reason: "The agent stopped waiting" },
      sessionId: "cdp-1",
    });
    expect(restarted.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("forgets the Live View link once the handoff settles", async () => {
    const store = records();
    const cdp = fakeTransport();
    const { host } = hostOver([cdp], store);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: true }));

    expect(JSON.stringify([...store.list({ prefix: "" })])).not.toContain("SECRET-TOKEN");
  });

  it("joins a second start of the same request while the first is in flight, and opens one handoff", async () => {
    const cdp = fakeTransport();
    const { host, asked } = hostOver([cdp]);

    const [first, second] = await Promise.all([host.start(REQUEST), host.start(REQUEST)]);

    expect(second).toEqual(first);
    expect(asked).toEqual([3]);
    expect(cdp.methods().filter((method) => method === "Cloudflare.handoff")).toHaveLength(1);
  });

  it("lets a start in flight finish before it ends the handoff, and refuses a start that comes after", async () => {
    const cdp = fakeTransport();
    const { host, store } = hostOver([cdp]);

    const starting = host.start(REQUEST);
    const ending = host.end("7");

    await starting;
    await ending;

    expect(cdp.sent.at(-1)?.method).toBe("Cloudflare.handoffComplete");
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
    await expect(host.start(REQUEST)).rejects.toThrow(/already ended/);
    expect([...store.list({ prefix: "handoff:" })]).toEqual([]);
  });

  it("prunes a handoff past its deadline that nobody ended, and a tombstone past its time", async () => {
    const cdp = fakeTransport();
    const { host, store, clock, scheduled } = hostOver([cdp]);

    await host.start(REQUEST);
    // Woken once the record is of no use: its deadline and five minutes more.
    expect(scheduled).toEqual([1_000 + 1_800_000 + 300_000]);

    expect(host.prune()).toBe(1_000 + 1_800_000 + 300_000);
    expect([...store.list({ prefix: "handoff:" })]).toHaveLength(1);

    clock.now = 1_000 + 1_800_000 + 300_000;

    expect(host.prune()).toBeUndefined();
    expect([...store.list({ prefix: "handoff:" })]).toEqual([]);
    expect(cdp.state.closed).toBe(true);

    await host.end("8");
    expect([...store.list({ prefix: "handoff-ended:" })]).toHaveLength(1);

    clock.now += 3_600_000;
    expect(host.prune()).toBeUndefined();
    expect([...store.list({ prefix: "handoff-ended:" })]).toEqual([]);
  });
});
