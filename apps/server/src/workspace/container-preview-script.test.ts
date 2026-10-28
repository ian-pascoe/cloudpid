// The script a Container preview puts in its HTML pages (`container-preview-script.ts`), run against a page's globals with
// its `fetch` answered by the Workspace DO's side (`ContainerPreview`) over a fake dev server: a page's WebSocket to its
// own host behaves as a WebSocket, carried over HTTP.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vitest";
import { ContainerPreview } from "./container-preview.ts";
import { CONTAINER_PREVIEW_SCRIPT } from "./container-preview-script.ts";

const PAGE = new URL("http://5173.cloudpid.internal/");

/** A WebSocket the fake dev server opened: what it received, and how the Container preview closed it. */
class DevSocket extends EventTarget {
  readonly received: Array<string | Uint8Array> = [];
  closed: { code: number; reason: string } | undefined;

  accept() {}

  send(data: string | ArrayBuffer) {
    if (Predicate.isString(data)) {
      this.received.push(data);
      this.push(`echo:${data}`);
    } else {
      this.received.push(new Uint8Array(data));
    }
  }

  close(code: number, reason: string) {
    this.closed = { code, reason };
  }

  /** The dev server sends `data`. */
  push(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/** The WebSocket the page would get from the browser for another host. */
class NativeWebSocket {
  static opened: string[] = [];

  constructor(url: string) {
    NativeWebSocket.opened.push(url);
  }
}

/** A WebSocket as the page sees it, the script's: what these tests use of it. */
type PageSocket = EventTarget & {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

/** The page's globals the script reads and replaces. */
type PageGlobals = {
  WebSocket: unknown;
  SharedWorker: unknown;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

/** A page with the script, whose `fetch` reaches a Container preview of a dev server on 5173 (when `running`). */
const pageWithScript = (running = true) => {
  const sockets: DevSocket[] = [];
  const upgrades: Array<{ url: string; protocols: string | null }> = [];

  const containerPreview = new ContainerPreview({
    running: () => running,
    port: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const socket = new DevSocket();
        const request = new Request(input, init);
        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0];

        sockets.push(socket);
        upgrades.push({
          url: request.url,
          protocols: request.headers.get("sec-websocket-protocol"),
        });

        // SAFETY: the Container preview reads `webSocket` and `headers` of an upgrade's answer; Node's `Response` has none.
        return {
          status: 101,
          webSocket: socket,
          headers: new Headers(
            protocol === undefined ? {} : { "sec-websocket-protocol": protocol },
          ),
        } as never;
      },
      connect: () => {
        throw new Error("No sockets");
      },
    }),
    activity: () => ({
      touch: () => Promise.resolve(),
      hold: () => ({ begun: Promise.resolve(), end: () => Promise.resolve() }),
    }),
    used: () => undefined,
    newId: () => `socket-${sockets.length}`,
    keepAliveMs: () => 60_000,
    warn: () => undefined,
  });

  /** The page's `fetch`: to the Container preview, whose stream an abort cancels, as the browser's does. */
  const fetch = async (input: string, init?: RequestInit) => {
    const response = await containerPreview.serve(new Request(new URL(input, PAGE), init), 5173);

    if (response.body === null || init?.signal === undefined || init.signal === null) {
      return response;
    }

    const reader = response.body.getReader();

    init.signal.addEventListener("abort", () => void reader.cancel());

    return new Response(
      new ReadableStream({
        pull: async (controller) => {
          const { value, done } = await reader.read();

          if (done) controller.close();
          else controller.enqueue(value);
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };

  const window: PageGlobals = { WebSocket: NativeWebSocket, SharedWorker: class {}, fetch };

  // The script runs as the page's first: with the page's globals.
  // oxlint-disable-next-line typescript/no-implied-eval -- the script is a string the Workspace DO puts in a page; this runs it as the page would.
  new Function("window", "location", CONTAINER_PREVIEW_SCRIPT)(window, PAGE);

  // SAFETY: the script put its WebSocket in `window`, constructed as the browser's is.
  const WebSocket = window.WebSocket as new (
    url: string,
    protocols?: string | string[],
  ) => PageSocket;

  return { WebSocket, window, sockets, upgrades };
};

/** Everything `socket` dispatches, as `type` or `type:data` or `close:code:reason`. */
const record = (socket: PageSocket) => {
  const seen: string[] = [];

  socket.onopen = () => void seen.push("open");
  socket.onmessage = (event) =>
    void seen.push(Predicate.isString(event.data) ? `message:${event.data}` : "message:binary");
  socket.onerror = () => void seen.push("error");
  socket.onclose = (event) => void seen.push(`close:${event.code}:${event.reason}`);

  return seen;
};

describe("the Container preview's script", () => {
  it("opens a WebSocket to the page's own host through the Workspace DO, with its protocol, and carries its messages both ways in order", async () => {
    const { WebSocket, sockets, upgrades } = pageWithScript();
    const socket = new WebSocket("ws://5173.cloudpid.internal/hmr?token=t", "vite-hmr");
    const seen = record(socket);

    expect(socket.readyState).toBe(0);
    await vi.waitFor(() => expect(seen).toEqual(["open"]));
    expect(socket.readyState).toBe(1);
    expect(socket.protocol).toBe("vite-hmr");
    expect(upgrades).toEqual([{ url: "http://localhost:5173/hmr?token=t", protocols: "vite-hmr" }]);

    socket.send("a");
    socket.send("b");
    sockets[0]?.push('{"type":"update"}');

    await vi.waitFor(() => expect(sockets[0]?.received).toEqual(["a", "b"]));
    await vi.waitFor(() =>
      expect(seen).toEqual([
        "open",
        'message:{"type":"update"}',
        "message:echo:a",
        "message:echo:b",
      ]),
    );

    socket.close(4000, "bye");
    await vi.waitFor(() => expect(sockets[0]?.closed).toEqual({ code: 4000, reason: "bye" }));
    expect(seen.at(-1)).toBe("close:4000:bye");
    expect(socket.readyState).toBe(3);
  });

  it("carries binary messages as bytes, as the page's binaryType asks", async () => {
    const { WebSocket, sockets } = pageWithScript();
    const socket = new WebSocket("/binary");
    const received: unknown[] = [];

    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => void received.push(event.data);
    await vi.waitFor(() => expect(socket.readyState).toBe(1));

    socket.send(new Uint8Array([1, 2, 255]));
    sockets[0]?.push(new Uint8Array([9, 8]).buffer);

    await vi.waitFor(() => expect(sockets[0]?.received).toEqual([new Uint8Array([1, 2, 255])]));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(received[0] instanceof ArrayBuffer ? received[0] : [])).toEqual(
      new Uint8Array([9, 8]),
    );
    socket.close();
  });

  it("passes on the dev server's close", async () => {
    const { WebSocket, sockets } = pageWithScript();
    const socket = new WebSocket("ws://5173.cloudpid.internal/hmr");
    const seen = record(socket);

    await vi.waitFor(() => expect(seen).toEqual(["open"]));
    sockets[0]?.dispatchEvent(Object.assign(new Event("close"), { code: 1012, reason: "restart" }));
    await vi.waitFor(() => expect(seen).toEqual(["open", "close:1012:restart"]));
  });

  it("fails as a WebSocket does when the Container is stopped, so Vite's restart ping tries again: an error, then a close", async () => {
    const { WebSocket } = pageWithScript(false);
    const seen = record(new WebSocket("ws://5173.cloudpid.internal/", "vite-ping"));

    await vi.waitFor(() => expect(seen).toEqual(["error", "close:1006:"]));
  });

  it("leaves a WebSocket to another host to the browser, and hides SharedWorker", () => {
    const { WebSocket, window } = pageWithScript();

    NativeWebSocket.opened = [];
    void new WebSocket("wss://example.com/live");

    expect(NativeWebSocket.opened).toEqual(["wss://example.com/live"]);
    expect(window.SharedWorker).toBeUndefined();
  });
});
