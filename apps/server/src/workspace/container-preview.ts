// A Container preview (ADR-0023, `docs/architecture/browser.md` → Container preview): a request a page of the Session's
// browser made to `http://<port>.cloudpid.internal/`, which Browser Run sent to the browser Worker's `ContainerPreviews`
// entrypoint, which hands it here through the Workspaces Worker's `WorkspaceContainerPreviews`. It is answered from the
// Container's port (`getTcpPort`, as computer's `fetchPort` does), on the Container's interface, so a dev server must
// listen on `0.0.0.0`. A Container preview never starts the Container: a stopped one answers 503, a port with nothing
// listening 502. Only the eight Container preview ports are served; computerd's is not one of them.
//
// Each request is a use of the Container (`IdleStop.touch`). A page's WebSockets, which Browser Run does not route, are
// carried over HTTP by the script put in every HTML page (`container-preview-script.ts`): this module holds each carried
// socket's real socket to the Container, which counts as a running command (`hold`) while it is open, and closes
// it when the page's stream goes away (cancelled, a write fails) or stops being read. Neither is the owner's or the
// agent's activity: an open page keeps the Container only until the hold cap passes without any (`IdleStop`).
// @effect-diagnostics asyncFunction:off globalTimers:off preferEffectArray:off preferSchemaOverJson:off
import {
  CONTAINER_PREVIEW_PORTS,
  containerPreviewHost,
} from "@cloudpid/extensions/browser/contract";
import * as Predicate from "effect/Predicate";
import type { IdleStop } from "./idle.ts";
import {
  CONTAINER_PREVIEW_HEADER,
  CONTAINER_PREVIEW_SCRIPT,
  CONTAINER_PREVIEW_SOCKET_PATH,
} from "./container-preview-script.ts";

/**
 * How often a carried socket's stream is written to when nothing else is. A write that fails is the page gone, and a
 * stream with something unread that the page read nothing of since the last tick is a page that stopped reading.
 */
export const CONTAINER_PREVIEW_KEEP_ALIVE_MS = 15_000;

/**
 * The most of a carried socket's stream that may wait unread, a bound on the memory a page that stopped reading holds
 * between two ticks. Far above any one message (a WebSocket message is at most 32 MiB, 43 MiB in base64), so a page
 * that reads is never cut off for a large one: it is the tick that finds a page stopped.
 */
export const CONTAINER_PREVIEW_MAX_UNREAD_BYTES = 96 * 1024 * 1024;

/** The most of a carried socket's stream written at once: a large message goes in slices, each read on its own. */
const CONTAINER_PREVIEW_SLICE_BYTES = 64 * 1024;

/** The use of the Container a Container preview makes, as the idle stop counts it (`IdleStop`). */
export type ContainerPreviewActivity = Pick<IdleStop, "touch" | "hold">;

export type ContainerPreviewDeps = {
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** The Container's port `port`, as `ctx.container.getTcpPort` gives it. */
  readonly port: (port: number) => Fetcher;
  readonly activity: () => ContainerPreviewActivity;
  /** A request the Container preview serves is a use of the Workspace (a spare's is no longer a spare). */
  readonly used: () => void;
  /** A new carried socket's ID: unguessable, as only the page that opened the socket may write to it. */
  readonly newId: () => string;
  readonly keepAliveMs: () => number;
  readonly warn: (message: string) => void;
};

/**
 * Headers not passed on: the ones a request picks up on its way here, which are not the page's, and `Host`, which is the
 * dev server's own (`localhost:<port>`), as a dev server refuses a host it does not know (Vite's `allowedHosts`).
 */
const DROPPED_HEADERS = [
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-forwarded-for",
];

/** The `Host` a dev server on `port` knows: its own, as on a laptop. */
const devServerHost = (port: number) => `localhost:${port}`;

/** The names a dev server calls itself by in a URL it makes from `Host`. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

/**
 * A `Location` the dev server answered with, as the page follows it: an absolute URL to the dev server itself (made from
 * the `Host` it was sent) is the Container preview's own address instead; anything else is left as it is.
 */
const containerPreviewLocation = (location: string, port: number): string => {
  if (!URL.canParse(location)) return location;

  const url = new URL(location);

  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(url.hostname) ||
    url.port !== String(port)
  ) {
    return location;
  }

  return `http://${containerPreviewHost(port)}${url.pathname}${url.search}${url.hash}`;
};

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A page of ours, in place of the dev server's, with `status`. */
const page = (status: number, title: string, text: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

/** Put the script at the start of an HTML page: in its `<head>`, else before anything but its doctype. */
export const withContainerPreviewScript = (html: string): string => {
  const script = `<script>${CONTAINER_PREVIEW_SCRIPT}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);

  if (head !== null) {
    const at = head.index + head[0].length;

    return `${html.slice(0, at)}${script}${html.slice(at)}`;
  }

  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype === null ? 0 : doctype[0].length;

  return `${html.slice(0, at)}${script}${html.slice(at)}`;
};

/** A close code a WebSocket may be closed with: the page's own when it is one, else a normal closure. */
const sendableCode = (code: number) => {
  if (code === 1006) return 1011;

  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(binary);
};

/** One carried socket: its real socket to the Container, and how to end it. */
type CarriedSocket = {
  readonly socket: WebSocket;
  readonly end: (code: number, reason: string) => void;
};

export class ContainerPreview {
  readonly #deps: ContainerPreviewDeps;
  /** The open carried sockets, by ID. In memory: a restarted object has none, and their pages reconnect. */
  readonly #carried = new Map<string, CarriedSocket>();

  constructor(deps: ContainerPreviewDeps) {
    this.#deps = deps;
  }

  /** Answer `request`, made to the Container preview of `port`. */
  async serve(request: Request, port: number): Promise<Response> {
    if (!CONTAINER_PREVIEW_PORTS.includes(port)) {
      return page(
        404,
        `Port ${port} has no Container preview`,
        `A Container preview is on one of the ports ${CONTAINER_PREVIEW_PORTS.join(", ")}. Start the dev server on one of them.`,
      );
    }

    if (!this.#deps.running()) {
      return page(
        503,
        "The Container is not running",
        "The Workspace's Container is stopped, and opening this page does not start it. Run a command in the Session to start it, start the dev server again (a Container's processes do not survive a stop), then reload.",
      );
    }

    this.#deps.used();
    await this.#use(this.#deps.activity().touch());

    const url = new URL(request.url);

    if (url.pathname.startsWith(CONTAINER_PREVIEW_SOCKET_PATH)) {
      return this.#socketEndpoint(request, url, port);
    }

    return this.#forward(request, url, port);
  }

  /** A use of the Container the idle stop is told of; a failed write only shortens the idle time. */
  async #use(noted: Promise<void>): Promise<void> {
    await noted.catch((cause: unknown) => this.#deps.warn(`idle stop: ${String(cause)}`));
  }

  /**
   * `request` as the dev server gets it: the page's own headers, `Origin` among them, to `localhost`, saying where the
   * page is (`X-Forwarded-Host`, `X-Forwarded-Proto`).
   */
  async #forward(request: Request, url: URL, port: number): Promise<Response> {
    const headers = new Headers({
      host: devServerHost(port),
      "x-forwarded-host": containerPreviewHost(port),
      "x-forwarded-proto": "http",
    });

    for (const [name, value] of request.headers) {
      if (!name.startsWith("cf-") && !DROPPED_HEADERS.includes(name)) headers.append(name, value);
    }

    let response: Response;

    try {
      response = await this.#deps
        .port(port)
        .fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
          redirect: "manual",
        });
    } catch (cause) {
      return this.#unreachable(port, cause);
    }

    const out = new Headers(response.headers);
    const location = response.headers.get("location");

    if (location !== null) out.set("location", containerPreviewLocation(location, port));

    const type = response.headers.get("content-type") ?? "";

    if (
      request.method === "HEAD" ||
      !type.toLowerCase().startsWith("text/html") ||
      response.status === 204 ||
      response.status === 304
    ) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
      });
    }

    // The page is longer and no longer the dev server's bytes.
    for (const name of ["content-length", "content-encoding", "etag"]) out.delete(name);

    return new Response(withContainerPreviewScript(await response.text()), {
      status: response.status,
      statusText: response.statusText,
      headers: out,
    });
  }

  #unreachable(port: number, cause: unknown): Response {
    this.#deps.warn(`Container preview: nothing answered on port ${port}: ${String(cause)}`);

    return page(
      502,
      `Nothing is listening on port ${port}`,
      `No dev server answered on the Container's port ${port}. Start it listening on 0.0.0.0, not localhost (with Vite, --host 0.0.0.0), then reload.`,
    );
  }

  /** The script's endpoints: `open` a carried socket as a stream of its messages, `send` to it, `close` it. */
  async #socketEndpoint(request: Request, url: URL, port: number): Promise<Response> {
    const origin = request.headers.get("origin");

    // A page of another origin cannot send the header without a preflight, which nothing here answers.
    if (
      request.headers.get(CONTAINER_PREVIEW_HEADER) !== "1" ||
      (origin !== null && origin !== url.origin)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const op = url.pathname.slice(CONTAINER_PREVIEW_SOCKET_PATH.length);

    if (op === "open" && request.method === "GET") return this.#open(request, url, port);

    if (request.method !== "POST") return new Response("Not found", { status: 404 });

    const carried = this.#carried.get(url.searchParams.get("id") ?? "");

    if (carried === undefined) return new Response("No such socket", { status: 404 });

    if (op === "send") {
      try {
        carried.socket.send(
          url.searchParams.get("binary") === "1"
            ? await request.arrayBuffer()
            : await request.text(),
        );
      } catch (cause) {
        carried.end(1011, String(cause));
      }

      return new Response(null, { status: 204 });
    }

    if (op === "close") {
      const asked: { code?: unknown; reason?: unknown } = await request
        .json<{ code?: unknown; reason?: unknown }>()
        .catch(() => ({}));

      carried.end(
        Predicate.isNumber(asked.code) ? asked.code : 1000,
        Predicate.isString(asked.reason) ? asked.reason.slice(0, 123) : "",
      );

      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  async #open(request: Request, url: URL, port: number): Promise<Response> {
    const path = url.searchParams.get("path") ?? "/";
    const protocols = url.searchParams.get("protocols") ?? "";
    const cookie = request.headers.get("cookie");

    // The upgrade the browser would have sent: from the page's origin, with its cookies.
    const headers = new Headers({
      host: devServerHost(port),
      upgrade: "websocket",
      origin: url.origin,
    });

    if (protocols !== "") headers.set("sec-websocket-protocol", protocols);

    if (cookie !== null) headers.set("cookie", cookie);

    let upstream: Response;

    try {
      upstream = await this.#deps
        .port(port)
        .fetch(`http://localhost:${port}${path.startsWith("/") ? path : `/${path}`}`, { headers });
    } catch (cause) {
      return this.#unreachable(port, cause);
    }

    const socket = upstream.webSocket;

    if (socket === null) {
      return new Response(`The dev server did not open a WebSocket (${upstream.status})`, {
        status: 502,
      });
    }

    const id = this.#deps.newId();
    const activity = this.#deps.activity();
    // Begun before anything can end the socket, so its end always comes after it.
    const hold = activity.hold();
    const begun = this.#use(hold.begun);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let ended = false;
    // What is written to the stream and not yet read: a page that stops reading holds it all.
    let unread = 0;
    // How much the page has read, in all, and at the last tick: no progress across a tick with something unread is a stop.
    let read = 0;
    let readAtTick = 0;

    const end = (code: number, reason: string, stalled = false) => {
      if (ended) return;

      ended = true;
      clearInterval(keepAlive);
      this.#carried.delete(id);
      void begun.then(() => this.#use(hold.end()));

      try {
        socket.close(sendableCode(code), reason);
      } catch {
        // Closed already.
      }

      // A page that stopped reading would never read the close: the stream fails, which its script takes as a close.
      if (stalled) {
        writer.abort(new Error(reason)).catch(() => undefined);

        return;
      }

      writer
        .write(encoder.encode(`event: close\ndata: ${JSON.stringify({ code, reason })}\n\n`))
        .then(() => writer.close())
        .catch(() => undefined);
    };

    const stalled = () => end(1001, "The page stopped reading", true);

    const write = (text: string): Promise<void> => {
      const bytes = encoder.encode(text);

      unread += bytes.byteLength;

      if (unread > CONTAINER_PREVIEW_MAX_UNREAD_BYTES) {
        stalled();

        return Promise.resolve();
      }

      // In slices, so a page reading a large message shows progress at every tick until it has it all.
      const slices: Promise<void>[] = [];

      for (let at = 0; at < bytes.byteLength; at += CONTAINER_PREVIEW_SLICE_BYTES) {
        const slice = bytes.subarray(at, at + CONTAINER_PREVIEW_SLICE_BYTES);

        slices.push(
          writer.write(slice).then(() => {
            unread -= slice.byteLength;
            read += slice.byteLength;
          }),
        );
      }

      return Promise.all(slices).then(
        () => undefined,
        () => end(1001, "The page went away"),
      );
    };

    // A comment now and then: a write that fails is the page gone, and a tick that finds something unread and nothing
    // read since the last one a page that stopped reading. A page slowly reading a large message is still reading.
    const keepAlive = setInterval(() => {
      if (unread > 0 && read === readAtTick) return stalled();

      readAtTick = read;
      void write(": keep-alive\n\n");
    }, this.#deps.keepAliveMs());

    // Listening before the socket is accepted: the dev server's first message (Vite's `connected`) comes at once.
    socket.addEventListener("message", (event) => {
      void this.#use(activity.touch());

      const data = Predicate.isString(event.data)
        ? { text: event.data }
        : { binary: toBase64(new Uint8Array(event.data)) };

      void write(`data: ${JSON.stringify(data)}\n\n`);
    });
    socket.addEventListener("close", (event) => end(event.code, event.reason));
    socket.addEventListener("error", () => end(1006, ""));
    writer.closed.catch(() => end(1001, "The page went away"));

    this.#carried.set(id, { socket, end });
    void write(
      `event: open\ndata: ${JSON.stringify({ id, protocol: upstream.headers.get("sec-websocket-protocol") ?? "" })}\n\n`,
    );
    socket.accept();
    await begun;

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
}
