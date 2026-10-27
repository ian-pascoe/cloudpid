// A Container preview (ADR-0023, `docs/spec.md` → Browser → Container preview): a request a page of the Session's
// browser made to `http://<port>.cloudpid.internal/`, which Browser Run sent to the browser Worker's `ContainerPreviews`
// entrypoint, which hands it here. It is answered from the Container's port (`getTcpPort`, as computer's `fetchPort`
// does), on the Container's interface, so a dev server must listen on `0.0.0.0`. A preview never starts the Container:
// a stopped one answers 503, a port with nothing listening 502. computerd's port is refused.
//
// Each request is a use of the Container (`IdleStop.touch`). A page's WebSockets, which Browser Run does not route, come
// over HTTP through the script put in every HTML page (`preview-shim.ts`): this module holds the real socket to the
// Container, which counts as a running command (`begin`/`end`) while it is open, and closes it when the page's stream
// goes away (a keep-alive write fails, or the stream is cancelled).
// @effect-diagnostics asyncFunction:off globalTimers:off preferEffectArray:off preferSchemaOverJson:off
import * as Predicate from "effect/Predicate";
import { PREVIEW_HEADER, PREVIEW_SHIM, PREVIEW_SOCKET_PATH } from "./preview-shim.ts";

/** computerd's port on the Container (`@cloudflare/computer`'s `DEFAULT_CONTAINER_PORT`): it has no Container preview. */
export const COMPUTERD_PORT = 8080;

/** How often an open socket's stream is written to when nothing else is: a write that fails is the page gone. */
export const PREVIEW_KEEP_ALIVE_MS = 15_000;

/** The use of the Container a preview makes, as the idle stop counts it (`IdleStop`). */
export type PreviewActivity = {
  readonly touch: () => Promise<void>;
  readonly begin: () => Promise<void>;
  readonly end: () => Promise<void>;
};

export type ContainerPreviewDeps = {
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** The Container's port `port`, as `ctx.container.getTcpPort` gives it. */
  readonly port: (port: number) => Fetcher;
  readonly activity: () => PreviewActivity;
  /** A new socket's ID: unguessable, as only the page that opened the socket may write to it. */
  readonly newId: () => string;
  readonly keepAliveMs: () => number;
  readonly warn: (message: string) => void;
};

/**
 * Headers not passed on: the ones a request picks up on its way here, which are not the page's, and `Host`, which is the
 * dev server's own (`localhost:<port>`), as a dev server refuses a host it does not know (Vite's `allowedHosts`).
 */
const DROPPED_HEADERS = ["host", "x-forwarded-proto", "x-real-ip", "x-forwarded-for"];

/** The `Host` a dev server on `port` knows: its own, as on a laptop. */
const devServerHost = (port: number) => `localhost:${port}`;

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
export const withPreviewShim = (html: string): string => {
  const script = `<script>${PREVIEW_SHIM}</script>`;
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

/** One tunnelled socket: the Container's side, and how to end it. */
type Tunnel = {
  readonly socket: WebSocket;
  readonly end: (code: number, reason: string) => void;
};

export class ContainerPreview {
  readonly #deps: ContainerPreviewDeps;
  /** The open tunnelled sockets, by ID. In memory: a restarted object has none, and their pages reconnect. */
  readonly #tunnels = new Map<string, Tunnel>();

  constructor(deps: ContainerPreviewDeps) {
    this.#deps = deps;
  }

  /** Answer `request`, made to the Container preview of `port`. */
  async serve(request: Request, port: number): Promise<Response> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return page(400, "No such port", `${port} is not a port.`);
    }

    if (port === COMPUTERD_PORT) {
      return page(
        403,
        "Port 8080 has no Container preview",
        "Port 8080 is the Workspace's own, for running its commands. Start the dev server on another port.",
      );
    }

    if (!this.#deps.running()) {
      return page(
        503,
        "The Container is not running",
        "The Workspace's Container is stopped, and opening this page does not start it. Run a command in the Session to start it, start the dev server again (a Container's processes do not survive a stop), then reload.",
      );
    }

    await this.#use(this.#deps.activity().touch());

    const url = new URL(request.url);

    if (url.pathname.startsWith(PREVIEW_SOCKET_PATH)) return this.#tunnel(request, url, port);

    return this.#forward(request, url, port);
  }

  /** A use of the Container the idle stop is told of; a failed write only shortens the idle time. */
  async #use(noted: Promise<void>): Promise<void> {
    await noted.catch((cause: unknown) => this.#deps.warn(`idle stop: ${String(cause)}`));
  }

  /** `request` as the dev server gets it: the page's own headers, `Origin` among them, to `localhost`. */
  async #forward(request: Request, url: URL, port: number): Promise<Response> {
    const headers = new Headers({ host: devServerHost(port) });

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

    const type = response.headers.get("content-type") ?? "";

    if (
      request.method === "HEAD" ||
      !type.toLowerCase().startsWith("text/html") ||
      response.status === 204 ||
      response.status === 304
    ) {
      return response;
    }

    const out = new Headers(response.headers);

    // The page is longer and no longer the dev server's bytes.
    for (const name of ["content-length", "content-encoding", "etag"]) out.delete(name);

    return new Response(withPreviewShim(await response.text()), {
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

  /** The script's endpoints: `open` a socket to the Container as a stream of its messages, `send` to it, `close` it. */
  async #tunnel(request: Request, url: URL, port: number): Promise<Response> {
    const origin = request.headers.get("origin");

    // A page of another origin cannot send the header without a preflight, which nothing here answers.
    if (request.headers.get(PREVIEW_HEADER) !== "1" || (origin !== null && origin !== url.origin)) {
      return new Response("Forbidden", { status: 403 });
    }

    const op = url.pathname.slice(PREVIEW_SOCKET_PATH.length);

    if (op === "open" && request.method === "GET") return this.#open(request, url, port);

    if (request.method !== "POST") return new Response("Not found", { status: 404 });

    const tunnel = this.#tunnels.get(url.searchParams.get("id") ?? "");

    if (tunnel === undefined) return new Response("No such socket", { status: 404 });

    if (op === "send") {
      try {
        tunnel.socket.send(
          url.searchParams.get("binary") === "1"
            ? await request.arrayBuffer()
            : await request.text(),
        );
      } catch (cause) {
        tunnel.end(1011, String(cause));
      }

      return new Response(null, { status: 204 });
    }

    if (op === "close") {
      const asked: { code?: unknown; reason?: unknown } = await request
        .json<{ code?: unknown; reason?: unknown }>()
        .catch(() => ({}));

      tunnel.end(
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

    socket.accept();

    const id = this.#deps.newId();
    const activity = this.#deps.activity();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let ended = false;

    const write = (text: string) =>
      writer.write(encoder.encode(text)).catch(() => end(1001, "The page went away"));

    const end = (code: number, reason: string) => {
      if (ended) return;

      ended = true;
      clearInterval(keepAlive);
      this.#tunnels.delete(id);
      void this.#use(activity.end());

      try {
        socket.close(sendableCode(code), reason);
      } catch {
        // Closed already.
      }

      writer
        .write(encoder.encode(`event: close\ndata: ${JSON.stringify({ code, reason })}\n\n`))
        .then(() => writer.close())
        .catch(() => undefined);
    };

    // A comment now and then: a write that fails is the page gone, whose socket is then closed.
    const keepAlive = setInterval(() => void write(": keep-alive\n\n"), this.#deps.keepAliveMs());

    this.#tunnels.set(id, { socket, end });
    await this.#use(activity.begin());

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

    void write(
      `event: open\ndata: ${JSON.stringify({ id, protocol: upstream.headers.get("sec-websocket-protocol") ?? "" })}\n\n`,
    );

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
}
