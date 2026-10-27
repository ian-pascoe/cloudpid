// The script the Workspace DO puts at the start of every HTML page of a Container preview (ADR-0023, the spike's
// `WS_HTTP_SHIM`, #244): Browser Run's outbound Workers route only HTTP, so a WebSocket to the page's own host (Vite's
// HMR, its restart ping) is carried over plain HTTP instead. `GET /__cloudpid/ws/open` is a stream of server-sent events
// (`open` with the socket's ID, each message, `close`), read with `fetch` so it can carry a header; `send` and `close`
// are POSTs, sent in order. The Workspace DO holds the real socket to the Container (`preview.ts`).
//
// Every request carries `x-cloudpid-preview`, a header a page of another origin cannot send without a CORS preflight,
// which the Workspace DO never grants, and a socket's ID is the Workspace DO's, unguessable, told only in its stream.
// The script also hides `SharedWorker`: Vite pings for a restarted server from one when it can, where this does not
// reach. A WebSocket to another host is the browser's own.

/** Where the tunnelled sockets' endpoints are, on every Container preview's host. */
export const PREVIEW_SOCKET_PATH = "/__cloudpid/ws/";

/** The header every request of the script carries, and the endpoints refuse a request without. */
export const PREVIEW_HEADER = "x-cloudpid-preview";

/** The script, as it goes in a `<script>` element: no `</script>` in it. */
export const PREVIEW_SHIM = `(() => {
  if (window.__cloudpidPreview) return;
  window.__cloudpidPreview = true;
  try {
    Object.defineProperty(window, "SharedWorker", { value: undefined, configurable: true, writable: true });
  } catch {}
  const NativeWebSocket = window.WebSocket;
  const nativeFetch = window.fetch.bind(window);
  const BASE = "${PREVIEW_SOCKET_PATH}";
  const HEADERS = { "${PREVIEW_HEADER}": "1" };
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  class PreviewSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = url;
      this.readyState = 0;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this._id = null;
      this._sent = Promise.resolve();
      this._abort = new AbortController();
      for (const type of ["open", "message", "close", "error"]) {
        let handler = null;
        Object.defineProperty(this, "on" + type, {
          get: () => handler,
          set: (value) => {
            if (handler) this.removeEventListener(type, handler);
            handler = typeof value === "function" ? value : null;
            if (handler) this.addEventListener(type, handler);
          },
        });
      }
      const target = new URL(url);
      const list = protocols === undefined ? [] : [].concat(protocols);
      const query = new URLSearchParams({ path: target.pathname + target.search, protocols: list.join(",") });
      this._read(BASE + "open?" + query.toString());
    }
    async _read(path) {
      try {
        const response = await nativeFetch(path, { headers: HEADERS, cache: "no-store", signal: this._abort.signal });
        if (!response.ok || response.body === null) throw new Error("refused");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end = buffer.indexOf("\\n\\n");
          while (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let type = "message";
            let data = "";
            for (const line of block.split("\\n")) {
              if (line.startsWith("event: ")) type = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (data !== "") this._event(type, JSON.parse(data));
            end = buffer.indexOf("\\n\\n");
          }
        }
        this._end(1006, "");
      } catch {
        if (this.readyState === 0) this.dispatchEvent(new Event("error"));
        this._end(1006, "");
      }
    }
    _event(type, data) {
      if (type === "open") {
        this._id = data.id;
        this.protocol = data.protocol;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      } else if (type === "close") {
        this._end(data.code, data.reason);
      } else if (this.readyState === 1) {
        let message = data.text;
        if (data.binary !== undefined) {
          const bytes = fromBase64(data.binary);
          message = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
        }
        this.dispatchEvent(new MessageEvent("message", { data: message, origin: location.origin }));
      }
    }
    _post(op, query, body) {
      const path = BASE + op + "?id=" + encodeURIComponent(this._id) + query;
      this._sent = this._sent
        .then(() => nativeFetch(path, { method: "POST", headers: HEADERS, body, keepalive: op === "close" }))
        .catch(() => undefined);
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return;
      if (typeof data === "string") this._post("send", "", data);
      else this._post("send", "&binary=1", data);
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      if (this._id !== null) {
        this.readyState = 2;
        this._post("close", "", JSON.stringify({ code: code ?? 1000, reason: reason ?? "" }));
        this._sent.then(() => this._end(code ?? 1000, reason ?? ""));
      } else {
        this._end(code ?? 1000, reason ?? "");
      }
    }
    _end(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._abort.abort();
      this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
    }
  }
  Object.assign(PreviewSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Object.assign(PreviewSocket.prototype, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const WebSocket = function WebSocket(url, protocols) {
    const parsed = new URL(url, location.href);
    if (parsed.host === location.host && ["ws:", "wss:", "http:", "https:"].includes(parsed.protocol)) {
      return new PreviewSocket(parsed.href.replace(/^http/, "ws"), protocols);
    }
    return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  };
  Object.assign(WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  WebSocket.prototype = NativeWebSocket.prototype;
  window.WebSocket = WebSocket;
})();`;
