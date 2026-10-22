/* oxlint-disable -- throwaway spike code, not part of the app */
// The Live View spike's Worker (#152). Throwaway: not part of the app.
//
// - `/test-page` and `/popup` are the pages the Browser Run tab shows (not gated: static, no secrets).
// - Everything else needs `?t=<SPIKE_TOKEN>`: `/` is the harness, `/api/*` goes to the `Spike` Durable Object, which
//   holds one Browser Run session and a browser-level CDP connection to it (like `apps/browser`'s host), mints Live
//   View links, lists targets, starts handoffs, hears `Cloudflare.handoffComplete`, and keeps a log the harness writes to.
//
// No Live View link is logged: every log line goes through `redact`.
import { DurableObject } from "cloudflare:workers";
import harnessHtml from "./harness.html?raw";
import testPageHtml from "./test-page.html?raw";
import popupHtml from "./popup.html?raw";

type Env = {
  readonly SPIKE: DurableObjectNamespace<Spike>;
  readonly BROWSER: Fetcher;
  readonly SPIKE_TOKEN: string;
};

/** Bumped on each deploy, to see which code answers. */
const VERSION = 4;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const redact = (text: string): string => text.replace(/jwt=[^&"'\s\\]+/g, "jwt=<redacted>");

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const html = (body: string): Response =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/test-page") return html(testPageHtml);
    if (url.pathname === "/popup") return html(popupHtml);
    if (url.searchParams.get("t") !== env.SPIKE_TOKEN)
      return new Response("Not found", { status: 404 });

    if (url.pathname === "/") return html(harnessHtml.replaceAll("__TOKEN__", env.SPIKE_TOKEN));

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(
        JSON.stringify({
          name: "Live View spike",
          short_name: "LV spike",
          start_url: `/?t=${env.SPIKE_TOKEN}&pwa=1`,
          scope: "/",
          display: "standalone",
          background_color: "#111111",
          theme_color: "#111111",
          icons: [{ src: `/icon.svg?t=${env.SPIKE_TOKEN}`, sizes: "any", type: "image/svg+xml" }],
        }),
        { headers: { "content-type": "application/manifest+json" } },
      );
    }

    if (url.pathname === "/icon.svg") {
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f38020"/><text x="50" y="62" font-size="40" text-anchor="middle" fill="#fff">LV</text></svg>',
        { headers: { "content-type": "image/svg+xml" } },
      );
    }

    if (url.pathname === "/version") return json({ version: VERSION });

    if (url.pathname.startsWith("/api/"))
      return env.SPIKE.getByName(`spike-v${VERSION}`).fetch(request);

    return new Response("Not found", { status: 404 });
  },
};

type Pending = { method: string; resolve: (value: Json) => void; reject: (error: Error) => void };

/** How long the object keeps the browser alive after the last API call. */
const ACTIVE_MS = 45 * 60_000;
/** How often the alarm pings the browser while active. */
const PING_MS = 20_000;
/** Browser Run's idle timeout for the session (its maximum is 20 minutes). */
const KEEP_ALIVE_MS = 600_000;

export class Spike extends DurableObject<Env> {
  #socket: WebSocket | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  /** CDP session ids of the targets this connection is attached to, by target id. */
  readonly #attached = new Map<string, string>();
  #connecting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, src TEXT, msg TEXT)",
    );
  }

  #get<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get<T>(key);
  }

  #put(key: string, value: unknown): void {
    this.ctx.storage.kv.put(key, value);
  }

  log(src: string, msg: string, ts = Date.now()): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO log (ts, src, msg) VALUES (?, ?, ?)",
      ts,
      src,
      redact(msg).slice(0, 8000),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice("/api/".length);
    const body: { [key: string]: Json } =
      request.method === "POST"
        ? await request.json<{ [key: string]: Json }>().catch(() => ({}))
        : {};

    this.#put("activeUntil", Date.now() + ACTIVE_MS);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + PING_MS);

    try {
      switch (path) {
        case "log": {
          if (request.method === "POST") {
            const entries = (body.entries ?? []) as { ts?: number; src?: string; msg?: string }[];

            for (const entry of entries)
              this.log(entry.src ?? "harness", entry.msg ?? "", entry.ts);

            return json({ ok: true });
          }

          const since = Number(url.searchParams.get("since") ?? 0);
          const src = url.searchParams.get("src");
          const grep = url.searchParams.get("grep");
          const limit = Number(url.searchParams.get("limit") ?? 500);
          const rows = this.ctx.storage.sql
            .exec<{ id: number; ts: number; src: string; msg: string }>(
              "SELECT id, ts, src, msg FROM log WHERE id > ? ORDER BY id LIMIT ?",
              since,
              10_000,
            )
            .toArray()
            .filter(
              (row) =>
                (src === null || row.src.startsWith(src)) &&
                (grep === null || row.msg.includes(grep)),
            )
            .slice(0, limit);

          return json(rows);
        }
        case "clear-log":
          this.ctx.storage.sql.exec("DELETE FROM log");

          return json({ ok: true });
        case "setup":
          return json(await this.#setup(body.fresh === true, new URL(request.url).origin));
        case "info":
          return json({ ...this.#info(), version: VERSION });
        case "restart":
          // Drops this instance, so the next request gets the deployed code.
          this.ctx.abort("restart");

          return json({ ok: true });
        case "mint":
          return json(await this.#mint(body));
        case "targets":
          return json(await this.send("Target.getTargets", {}));
        case "handoff":
          return json(await this.#handoff(body));
        case "cdp": {
          // A command on the host's own connection: `target` is a target id to send it in (attached on demand), or
          // absent for the browser itself.
          const target = typeof body.target === "string" ? body.target : undefined;
          const sessionId = target === undefined ? undefined : await this.#attach(target);
          const result = await this.send(
            String(body.method),
            (body.params ?? {}) as { [key: string]: Json },
            sessionId,
          );

          return json({ result });
        }
        case "close-session": {
          const sessionId = this.#get<string>("sessionId");

          this.#socket?.close(1000, "done");
          this.#socket = undefined;
          if (sessionId !== undefined) {
            await this.env.BROWSER.fetch(`https://localhost/v1/devtools/browser/${sessionId}`, {
              method: "DELETE",
            });
          }
          this.#put("sessionId", undefined);
          this.#put("activeUntil", 0);

          return json({ ok: true });
        }
        default:
          return json({ error: `unknown ${path}` }, 404);
      }
    } catch (error) {
      this.log("host", `ERROR ${path}: ${String(error)}`);

      return json({ error: String(error) }, 500);
    }
  }

  async alarm(): Promise<void> {
    const activeUntil = this.#get<number>("activeUntil") ?? 0;

    if (Date.now() > activeUntil || this.#get<string>("sessionId") === undefined) return;

    try {
      await this.#connect();
      // Keeps the browser and this object busy, and re-attaches to the tab after an eviction so the handoff's end
      // event is still heard.
      const tab = this.#get<string>("tabTargetId");

      if (tab !== undefined) await this.#attach(tab);
      await this.send("Target.getTargets", {}, undefined, false);
    } catch (error) {
      this.log("host", `alarm ping failed: ${String(error)}`);
    }

    await this.ctx.storage.setAlarm(Date.now() + PING_MS);
  }

  #info(): { [key: string]: Json } {
    return {
      sessionId: this.#get<string>("sessionId") ?? null,
      tabTargetId: this.#get<string>("tabTargetId") ?? null,
      otherTargetId: this.#get<string>("otherTargetId") ?? null,
      connected: this.#socket !== undefined,
      handoffs: this.#get<Json[]>("handoffs") ?? [],
      completions: this.#get<Json[]>("completions") ?? [],
      handoffEvents: this.#get<Json[]>("handoffEvents") ?? [],
    };
  }

  /** A browser session with the test page in a tab (`tab`) and a second page (`other`); reused while it lives. */
  async #setup(fresh: boolean, origin: string): Promise<{ [key: string]: Json }> {
    if (!fresh && this.#get<string>("sessionId") !== undefined) {
      try {
        await this.#connect();
        const { targetInfos } = (await this.send("Target.getTargets", {})) as {
          targetInfos: { targetId: string }[];
        };
        const tab = this.#get<string>("tabTargetId");

        if (targetInfos.some((target) => target.targetId === tab)) return this.#info();
      } catch (error) {
        this.log("host", `setup: old session unusable: ${String(error)}`);
      }
    }

    this.#socket?.close(1000, "new session");
    this.#socket = undefined;
    this.#attached.clear();
    this.#put("handoffs", []);
    this.#put("completions", []);
    this.#put("handoffEvents", []);

    const response = await this.env.BROWSER.fetch(
      `https://localhost/v1/devtools/browser?keep_alive=${KEEP_ALIVE_MS}&targets=true`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );

    if (!response.ok)
      throw new Error(`create session: ${response.status} ${await response.text()}`);

    const created = await response.json<{
      sessionId: string;
      targets?: { id: string; type: string }[];
    }>();

    this.log(
      "host",
      `created browser session ${created.sessionId} with ${created.targets?.length ?? 0} targets`,
    );
    this.#put("sessionId", created.sessionId);
    await this.#connect();
    await this.send("Target.setDiscoverTargets", { discover: true });

    const { targetId: tab } = (await this.send("Target.createTarget", {
      url: `${origin}/test-page?which=tab`,
    })) as { targetId: string };
    const { targetId: other } = (await this.send("Target.createTarget", {
      url: `${origin}/test-page?which=other`,
    })) as { targetId: string };

    this.#put("tabTargetId", tab);
    this.#put("otherTargetId", other);
    await this.#attach(tab);
    // Let both load.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    return this.#info();
  }

  async #mint(body: { [key: string]: Json }): Promise<{ [key: string]: Json }> {
    const tab = this.#get<string>("tabTargetId");

    if (tab === undefined) throw new Error("no session: run setup");

    const params: { [key: string]: Json } = {
      mode: typeof body.mode === "string" ? body.mode : "tab",
      expiresInMs: typeof body.expiresInMs === "number" ? body.expiresInMs : 60_000,
    };

    if (typeof body.targetId === "string") params.targetId = body.targetId;

    // `via`: "tab" sends it in the tab's CDP session (as the host does), "browser" on the browser itself.
    const sessionId = body.via === "browser" ? undefined : await this.#attach(tab);
    const reply = (await this.send("Cloudflare.getLiveView", params, sessionId)) as {
      [key: string]: Json;
    };
    const link = String(reply.devtoolsFrontendUrl);
    const parsed = new URL(link);
    const wss = parsed.searchParams.get("wss");

    this.log(
      "host",
      `minted ${JSON.stringify(params)} via ${body.via ?? "tab"}: reply keys ${Object.keys(reply).join(",")}, host ${parsed.host}${parsed.pathname}, params ${[...parsed.searchParams.keys()].join(",")}, wss ${redact(wss ?? "")}`,
    );

    const socketUrl = new URL(String(reply.webSocketDebuggerUrl));

    return {
      link,
      wss,
      replyKeys: Object.keys(reply),
      id: reply.id ?? null,
      options: reply.options ?? null,
      webSocketDebuggerUrlIsWss: redact(socketUrl.href) === redact(`wss://${wss}`),
    };
  }

  async #handoff(body: { [key: string]: Json }): Promise<{ [key: string]: Json }> {
    const target = typeof body.target === "string" ? body.target : this.#get<string>("tabTargetId");

    if (target === undefined) throw new Error("no session: run setup");

    const sessionId = await this.#attach(target);
    const reply = await this.send(
      "Cloudflare.handoff",
      {
        instructions: typeof body.instructions === "string" ? body.instructions : "Spike handoff",
        timeout: typeof body.timeout === "number" ? body.timeout : 600_000,
      },
      sessionId,
    );
    const handoffs = this.#get<Json[]>("handoffs") ?? [];

    handoffs.push({ at: Date.now(), target, reply });
    this.#put("handoffs", handoffs);

    return { reply };
  }

  /** Attach to `targetId` on the host connection (flattened), once per connection. */
  async #attach(targetId: string): Promise<string> {
    await this.#connect();

    const known = this.#attached.get(targetId);

    if (known !== undefined) return known;

    const { sessionId } = (await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };

    this.#attached.set(targetId, sessionId);

    return sessionId;
  }

  async #connect(): Promise<void> {
    if (this.#socket !== undefined) return;

    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });

    return this.#connecting;
  }

  async #open(): Promise<void> {
    const sessionId = this.#get<string>("sessionId");

    if (sessionId === undefined) throw new Error("no session: run setup");

    const response = await this.env.BROWSER.fetch(
      `https://localhost/v1/devtools/browser/${sessionId}`,
      {
        headers: { Upgrade: "websocket" },
      },
    );
    const socket = response.webSocket;

    if (socket === null) {
      this.#put("sessionId", undefined);
      throw new Error(`Browser Run did not open a CDP connection (${response.status})`);
    }

    socket.accept();
    this.#socket = socket;
    this.#attached.clear();
    this.log("host", `connected to browser session ${sessionId}`);

    socket.addEventListener("message", (event) => this.#onMessage(String(event.data)));

    const end = (why: string) => {
      if (this.#socket !== socket) return;

      this.#socket = undefined;
      this.#attached.clear();
      this.log("host", `browser connection ${why}`);

      for (const [id, pending] of this.#pending) {
        this.#pending.delete(id);
        pending.reject(new Error(`connection ${why}`));
      }
    };

    socket.addEventListener("close", (event) => end(`closed ${event.code} ${event.reason}`));
    socket.addEventListener("error", () => end("errored"));
  }

  #onMessage(data: string): void {
    const message = JSON.parse(data) as {
      id?: number;
      result?: Json;
      error?: { message?: string };
      method?: string;
      params?: { [key: string]: Json };
      sessionId?: string;
    };

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);

      if (pending === undefined) return;

      this.#pending.delete(message.id);

      if (message.error !== undefined)
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? null);

      return;
    }

    this.log("host:event", data);

    if (message.method === "Cloudflare.handoffComplete") {
      const completions = this.#get<Json[]>("completions") ?? [];

      completions.push({
        at: Date.now(),
        sessionId: message.sessionId ?? null,
        params: message.params ?? null,
      });
      this.#put("completions", completions);
    } else if (message.method?.startsWith("Cloudflare.") === true) {
      const events = this.#get<Json[]>("handoffEvents") ?? [];

      events.push({ at: Date.now(), method: message.method, params: message.params ?? null });
      this.#put("handoffEvents", events);
    } else if (message.method === "Target.detachedFromTarget") {
      for (const [target, session] of this.#attached) {
        if (session === message.params?.sessionId) this.#attached.delete(target);
      }
    }
  }

  /** Send a CDP command on the host's connection. */
  async send(
    method: string,
    params: { [key: string]: Json },
    sessionId?: string,
    log = true,
  ): Promise<Json> {
    await this.#connect();

    const socket = this.#socket;

    if (socket === undefined) throw new Error("not connected");

    const id = this.#nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    if (log) this.log("host:send", payload);

    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, 15_000);

      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          if (log) this.log("host:recv", JSON.stringify({ id, result: value }));
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (log) this.log("host:recv", JSON.stringify({ id, error: String(error) }));
          reject(error);
        },
      });
      socket.send(payload);
    });
  }
}
