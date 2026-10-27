// The Workspace DO's Container preview (ADR-0023): a request the Session's browser made to
// `http://<port>.cloudpid.internal/`, handed to `containerPreview(request, port)` as the Workspaces Worker's
// `WorkspaceContainerPreviews` entrypoint hands it, and answered from a fake dev server on the fake Container
// (`TestWorkspace.fakeDevServer`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off newPromise:off globalTimers:off
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContainerPreviews } from "./worker.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

let objects = 0;

/** A Workspace DO of its own, named as a Workspace's (`ws:<id>`), its Container running (or not) with a dev server on 5173. */
const namedWorkspace = async (running = true) => {
  objects += 1;

  const name = `ws:container-preview-${objects}`;
  const stub = env.WORKSPACES.getByName(name);

  await stub.fakeContainer({ running });
  await stub.fakeDevServer({ ports: [5173] });

  return { name, stub };
};

const workspace = async (running = true) => (await namedWorkspace(running)).stub;

type Workspace = Awaited<ReturnType<typeof workspace>>;

const PAGE = "http://5173.cloudpid.internal";

/** The headers the page's script sends on every request to its carried sockets' endpoints. */
const SCRIPT = { "x-cloudpid-preview": "1" };

/** What Vite's server sends on a new socket at once, as the fake dev server does. */
const CONNECTED = { type: "message", data: { text: '{"type":"connected"}' } };

/** A server-sent event of a carried socket's stream: `open`, `message` or `close`, with what each carries. */
type SocketEvent = {
  readonly type: string;
  readonly data: {
    readonly id?: string;
    readonly protocol?: string;
    readonly text?: string;
    readonly code?: number;
    readonly reason?: string;
  };
};

/** The server-sent events of a carried socket's stream, one at a time. */
const eventsOf = (response: Response) => {
  if (response.body === null) throw new Error("No stream");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  let buffer = "";

  return {
    next: async (): Promise<SocketEvent> => {
      for (;;) {
        const end = buffer.indexOf("\n\n");

        if (end !== -1) {
          const block = buffer.slice(0, end);

          buffer = buffer.slice(end + 2);

          if (block.startsWith(":")) continue;

          const type = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";

          return { type, data: JSON.parse(data) };
        }

        const { value, done } = await reader.read();

        if (done) throw new Error("The stream ended");

        buffer += value;
      }
    },
    /** Read until the stream ends; how it ended: `done`, or the error it failed with. */
    drain: async (): Promise<string> => {
      try {
        for (;;) {
          const { done } = await reader.read();

          if (done) return "done";
        }
      } catch (error) {
        return String(error);
      }
    },
    cancel: () => reader.cancel(),
  };
};

/** Open a carried socket to the dev server's `/hmr` through the script's endpoint, and read its `open` event. */
const openSocket = async (stub: Workspace) => {
  const response = await stub.containerPreview(
    new Request(`${PAGE}/__cloudpid/ws/open?path=%2Fhmr%3Ftoken%3Dt&protocols=vite-hmr`, {
      headers: SCRIPT,
    }),
    5173,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const events = eventsOf(response);
  const opened = await events.next();

  expect(opened.type).toBe("open");

  return { events, id: opened.data.id ?? "", protocol: opened.data.protocol };
};

describe("a Container preview", () => {
  it("answers from the Container's port, passing the page's Origin and cookies through but not its Host (Vite's allowedHosts), and counts as a use", async () => {
    const stub = await workspace();

    const response = await stub.containerPreview(
      new Request(`${PAGE}/src/main.js?t=1`, {
        headers: { host: "5173.cloudpid.internal", origin: PAGE, cookie: "app=1" },
      }),
      5173,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export const tag = "<head>";');
    expect((await stub.devServerState()).requests).toEqual([
      {
        port: 5173,
        method: "GET",
        url: "http://localhost:5173/src/main.js?t=1",
        host: "localhost:5173",
        forwardedHost: "5173.cloudpid.internal",
        origin: PAGE,
        cookie: "app=1",
        upgrade: null,
        protocols: null,
      },
    ]);
    expect(await stub.containerPreviewUses()).toEqual({ touch: 1, begin: 0, end: 0 });
    expect(await stub.spareUsed()).toBe(true);
  });

  it("sends a redirect the dev server made to its own address back to the Container preview's", async () => {
    const stub = await workspace();

    const response = await stub.containerPreview(new Request(`${PAGE}/login`), 5173);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://5173.cloudpid.internal/login/");
  });

  it("puts the script at the start of an HTML page only, before the page's own scripts", async () => {
    const stub = await workspace();

    const html = await stub.containerPreview(new Request(`${PAGE}/`), 5173);
    const text = await html.text();

    expect(html.headers.get("content-type")).toContain("text/html");
    // The page grew: its old length would cut it.
    expect(html.headers.get("content-length")).not.toBe("86");
    expect(text).toMatch(
      /^<!doctype html><html lang="en"><head><script>\(\(\) => \{[\s\S]*__cloudpid\/ws\/[\s\S]*<\/script><title>App<\/title><\/head><body>app<\/body><\/html>$/,
    );
    expect(text.match(/<script>/g)).toHaveLength(1);

    // A script that merely says `<head>` is left as the dev server sent it.
    expect(await (await stub.containerPreview(new Request(`${PAGE}/main.js`), 5173)).text()).toBe(
      'export const tag = "<head>";',
    );
  });

  it("never starts a stopped Container: it answers 503, asking nothing of the Container and counting no use", async () => {
    const stub = await workspace(false);

    const page = await stub.containerPreview(new Request(`${PAGE}/`), 5173);

    expect(page.status).toBe(503);
    expect(await page.text()).toContain("does not start it");

    const socket = await stub.containerPreview(
      new Request(`${PAGE}/__cloudpid/ws/open?path=%2F`, { headers: SCRIPT }),
      5173,
    );

    expect(socket.status).toBe(503);
    expect(await stub.devServerState()).toEqual({ requests: [], sockets: [] });
    expect((await stub.fakeContainerState()).running).toBe(false);
    expect((await stub.liveStubs()).container).toBe(0);
    expect(await stub.containerPreviewUses()).toEqual({ touch: 0, begin: 0, end: 0 });
    expect(await stub.spareUsed()).toBe(false);
  });

  it("answers 502 for a port with nothing listening, saying to listen on 0.0.0.0", async () => {
    const stub = await workspace();

    const response = await stub.containerPreview(
      new Request("http://3000.cloudpid.internal/"),
      3000,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("listening on 0.0.0.0");
  });

  it("serves the eight Container preview ports only, computerd's not among them, asking nothing of the Container", async () => {
    const stub = await workspace();

    await stub.fakeDevServer({ ports: [8080, 9999] });

    for (const port of [8080, 9999, 0, 80]) {
      const response = await stub.containerPreview(
        new Request(`http://${port}.cloudpid.internal/`),
        port,
      );

      expect(response.status, String(port)).toBe(404);
      expect(await response.text(), String(port)).toContain("has no Container preview");
    }

    expect((await stub.devServerState()).requests).toEqual([]);
    expect(await stub.containerPreviewUses()).toEqual({ touch: 0, begin: 0, end: 0 });
    expect(await stub.spareUsed()).toBe(false);
  });
});

describe("the Workspaces Worker's Container previews entrypoint", () => {
  // SAFETY: the test Worker's entry (`workerd.fixture.ts`) exports `WorkspaceContainerPreviews`, an RPC entrypoint.
  const entrypoint = (
    exports as { readonly WorkspaceContainerPreviews: WorkspaceContainerPreviews }
  ).WorkspaceContainerPreviews;

  it("hands a request to the Workspace DO it names", async () => {
    const { name } = await namedWorkspace();

    const response = await entrypoint.containerPreview(name, new Request(`${PAGE}/main.js`), 5173);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export const tag = "<head>";');
  });

  it("reaches no object but a Workspace's: not a Build's, nor one named otherwise", async () => {
    for (const name of ["build:environment", "test-build:environment", "ws:../x", "session"]) {
      const response = await entrypoint.containerPreview(name, new Request(`${PAGE}/`), 5173);

      expect(response.status, name).toBe(404);
    }
  });
});

describe("a WebSocket of a Container preview, a carried socket", () => {
  it("opens the socket to the Container from the page's origin, missing none of its first messages, and carries its messages both ways", async () => {
    const stub = await workspace();
    const { events, id, protocol } = await openSocket(stub);

    expect(protocol).toBe("vite-hmr");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect((await stub.devServerState()).requests.at(-1)).toMatchObject({
      url: "http://localhost:5173/hmr?token=t",
      host: "localhost:5173",
      origin: PAGE,
      upgrade: "websocket",
      protocols: "vite-hmr",
    });
    // Sent the moment the socket opened, before the Workspace DO answered the page.
    expect(await events.next()).toEqual(CONNECTED);

    const sent = await stub.containerPreview(
      new Request(`${PAGE}/__cloudpid/ws/send?id=${id}`, {
        method: "POST",
        headers: { ...SCRIPT, origin: PAGE },
        body: '{"type":"ping"}',
      }),
      5173,
    );

    expect(sent.status).toBe(204);
    expect(await events.next()).toEqual({
      type: "message",
      data: { text: 'echo:{"type":"ping"}' },
    });

    await stub.devServerSend(0, '{"type":"update"}');
    expect(await events.next()).toEqual({ type: "message", data: { text: '{"type":"update"}' } });
    expect((await stub.devServerState()).sockets[0]?.received).toEqual(['{"type":"ping"}']);

    await events.cancel();
  });

  it("counts an open socket as a running command until it closes, and passes on the Container's close", async () => {
    const stub = await workspace();
    const { events } = await openSocket(stub);

    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 1, end: 0 });

    // The dev server restarts: the page is told, and the socket no longer holds off the idle stop.
    await stub.devServerClose(0);
    expect(await events.next()).toEqual(CONNECTED);
    expect(await events.next()).toEqual({
      type: "close",
      data: { code: 1012, reason: "restarting" },
    });
    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 1, end: 1 });
  });

  it("closes the Container's socket when its stream goes away", async () => {
    const stub = await workspace();
    const { events } = await openSocket(stub);

    // The page or the browser closed.
    await events.cancel();

    await vi.waitFor(async () =>
      expect((await stub.devServerState()).sockets[0]?.closed).not.toBeNull(),
    );
    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 1, end: 1 });
  });

  it("keeps the socket of a page that is reading, over several keep-alive ticks, while it receives one large message", async () => {
    const stub = await workspace();
    const { events } = await openSocket(stub);

    expect(await events.next()).toEqual(CONNECTED);

    // A 3 MiB message (an HMR payload, a large binary frame) is far more than a tick carries.
    const large = "x".repeat(3 * 1024 * 1024);

    await stub.devServerSend(0, large);
    expect((await events.next()).data.text).toHaveLength(large.length);

    // Several ticks (50 ms each here) pass while the page reads on, keep-alives and all.
    const after = events.next();

    await new Promise((resolve) => setTimeout(resolve, 300));
    await stub.devServerSend(0, "after");
    expect(await after).toEqual({ type: "message", data: { text: "after" } });
    expect((await stub.devServerState()).sockets[0]?.closed).toBeNull();
    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 1, end: 0 });

    await events.cancel();
  });

  it("closes the Container's socket, and fails its stream, when the page stops reading it without letting go", async () => {
    const stub = await workspace();
    const { events } = await openSocket(stub);

    // The page reads nothing more while the dev server keeps sending.
    for (let at = 0; at < 8; at++) await stub.devServerSend(0, "x".repeat(128 * 1024));

    await vi.waitFor(
      async () =>
        expect((await stub.devServerState()).sockets[0]?.closed).toEqual({
          code: 1000,
          reason: "The page stopped reading",
        }),
      { timeout: 5_000 },
    );
    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 1, end: 1 });
    expect(await events.drain()).not.toBe("done");
  });

  it("closes the socket the page closes, with its code", async () => {
    const stub = await workspace();
    const { events, id } = await openSocket(stub);

    const closed = await stub.containerPreview(
      new Request(`${PAGE}/__cloudpid/ws/close?id=${id}`, {
        method: "POST",
        headers: SCRIPT,
        body: JSON.stringify({ code: 4000, reason: "done" }),
      }),
      5173,
    );

    expect(closed.status).toBe(204);
    expect(await events.next()).toEqual(CONNECTED);
    expect(await events.next()).toEqual({ type: "close", data: { code: 4000, reason: "done" } });
    await vi.waitFor(async () =>
      expect((await stub.devServerState()).sockets[0]?.closed).toEqual({
        code: 4000,
        reason: "done",
      }),
    );
  });

  it("refuses a request without the script's header, from another origin, or for a socket it does not have", async () => {
    const stub = await workspace();
    const { events, id } = await openSocket(stub);

    const send = (headers: Record<string, string>, socket = id) =>
      stub.containerPreview(
        new Request(`${PAGE}/__cloudpid/ws/send?id=${socket}`, {
          method: "POST",
          headers,
          body: "injected",
        }),
        5173,
      );

    // A page of another origin cannot send the header without a preflight, which is never granted.
    expect((await send({})).status).toBe(403);
    expect((await send({ ...SCRIPT, origin: "http://3000.cloudpid.internal" })).status).toBe(403);
    expect((await send({ ...SCRIPT, origin: "null" })).status).toBe(403);
    expect(
      (
        await stub.containerPreview(
          new Request(`${PAGE}/__cloudpid/ws/send?id=${id}`, { method: "OPTIONS" }),
          5173,
        )
      ).status,
    ).toBe(403);
    expect(
      (await stub.containerPreview(new Request(`${PAGE}/__cloudpid/ws/open?path=%2F`), 5173))
        .status,
    ).toBe(403);
    expect((await send(SCRIPT, "0123")).status).toBe(404);

    expect((await stub.devServerState()).sockets[0]?.received).toEqual([]);
    await events.cancel();
  });

  it("answers 502 when nothing listens on the port, as Vite's restart ping expects", async () => {
    const stub = await workspace();

    const response = await stub.containerPreview(
      new Request("http://5174.cloudpid.internal/__cloudpid/ws/open?path=%2F&protocols=vite-ping", {
        headers: SCRIPT,
      }),
      5174,
    );

    expect(response.status).toBe(502);
    expect(await stub.containerPreviewUses()).toMatchObject({ begin: 0 });
  });
});
