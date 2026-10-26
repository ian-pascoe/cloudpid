// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off strictEffectProvide:off missingPipeableSignature:off -- a fake browser over native arrays, speaking CDP's plain JSON, given to each test's Live View.

// A fake Browser Run and link source for the Live View's tests: page sockets that answer CDP commands, and the links
// that open them.

import { LIVE_VIEW_HANDOFF_OVER, type LiveViewLinks } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { settle, type Value } from "../session/client.testing.ts";
import { liveViewOver, type LinkSource } from "./connection.ts";

type Listener = (event: Socket.WebSocketEvent) => void;

interface Sent {
  readonly id: number;
  readonly method: string;
  readonly params: { readonly [key: string]: Value };
}

/** How the fake browser answers a command: a result, or nothing (a socket iOS killed). */
export type Answer = { readonly [key: string]: Value } | "silent";

/** A page's CDP socket in a fake Browser Run: it opens at once and answers every command, as `answer` says. */
export class FakePage implements Socket.WebSocketLike {
  readyState = 0;
  readonly sent: Sent[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    private readonly answer: (method: string) => Answer,
  ) {}

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();

    set.add(listener);
    this.listeners.set(type, set);

    if (type === "open") {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;

        this.readyState = 1;
        this.dispatch("open", { type: "open" });
      });
    }
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    const command: Sent = JSON.parse(String(data));

    this.sent.push(command);

    const result = this.answer(command.method);

    if (result === "silent") return;

    queueMicrotask(() => {
      this.dispatch("message", {
        type: "message",
        data: JSON.stringify({ id: command.id, result }),
      });
    });
  }

  close() {
    if (this.readyState === 3) return;

    this.readyState = 3;
    this.dispatch("close", { type: "close", code: 1000 });
  }

  /** The page sends an event. */
  event(method: string, params: { readonly [key: string]: Value }) {
    return Effect.sync(() => {
      this.dispatch("message", { type: "message", data: JSON.stringify({ method, params }) });
    }).pipe(Effect.andThen(settle));
  }

  /** The browser closes the socket (the window closed). */
  drop() {
    return Effect.sync(() => {
      this.close();
    }).pipe(Effect.andThen(settle));
  }

  methods(): string[] {
    return this.sent.map((command) => command.method);
  }

  last(method: string): Sent | undefined {
    return this.sent.findLast((command) => command.method === method);
  }

  private dispatch(type: string, event: Socket.WebSocketEvent) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

export const link = (targetId: string, n: number) => `wss://live.example/page/${targetId}?jwt=${n}`;

/**
 * A fake Browser Run and the links that open its pages: `source` is a link source, `mint` the same links as the
 * Session's `live_view` answers them (failing with `LIVE_VIEW_HANDOFF_OVER` once `finish` is called). `answer` may
 * answer a command before the default does.
 */
export const fakeBrowser = (
  options: {
    readonly windows?: () => LiveViewLinks["windows"];
    readonly answer?: (method: string) => Answer | undefined;
  } = {},
) => {
  const pages: FakePage[] = [];
  const silent = new Set<string>();
  let mints = 0;
  let over = false;

  const answer = (url: string) => (method: string) => {
    if (silent.has(url) || (method === "Cloudflare.getSessionId" && silent.has("*"))) {
      return "silent" as const;
    }

    if (method === "Runtime.evaluate") return { result: { type: "number", value: 2 } };

    return options.answer?.(method) ?? {};
  };

  const layer = Layer.succeed(Socket.WebSocketConstructor)((url: string) => {
    const page = new FakePage(url, answer(url));

    pages.push(page);

    return page;
  });

  const minted = Effect.suspend(() => {
    mints += 1;

    const windows = (options.windows?.() ?? []).map((window) => ({
      ...window,
      link: link(window.targetId, mints),
    }));

    return Effect.succeed({ tab: { targetId: "T", link: link("T", mints) }, windows });
  });

  const source: LinkSource = Effect.suspend(() => (over ? Effect.fail(liveViewOver) : minted));

  const mint = Effect.suspend(() =>
    over ? Effect.fail({ message: LIVE_VIEW_HANDOFF_OVER }) : minted,
  );

  return {
    layer,
    source,
    mint,
    pages,
    mints: () => mints,
    /** The page sockets opened to `targetId`, oldest first. */
    to: (targetId: string) => pages.filter((page) => page.url.includes(`/page/${targetId}?`)),
    /** The links are over for good. */
    finish: () => {
      over = true;
    },
    /** Every socket open now stops answering, as iOS leaves one after the background. */
    killAll: () => {
      for (const page of pages) silent.add(page.url);
    },
  };
};

export const frame = (sessionId: number) => ({
  data: "jpeg",
  sessionId,
  metadata: {
    deviceWidth: 390,
    deviceHeight: 700,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
});
