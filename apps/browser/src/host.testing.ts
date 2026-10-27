// The real `BrowserHost` over a Durable Object's own state, with a fake Browser Run as its binding, for the tests that
// drive it whole: the agent in an Owner tab (`./owner-tab-agent.test.ts`) and the Container previews' routes
// (`./container-preview.test.ts`). The model's code runs in a Worker Loader isolate and drives the fake over CDP, which records
// what it is sent and in which page.
// workerd's WebSocketPair, Durable Object state and RPC are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off missingPipeableSignature:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  BrowserRun,
  ContainerPreviewWorkspace,
  HandoffStartInput,
} from "@cloudpid/extensions/browser/contract";
import type { BrowserBinding } from "agents/browser";
import { BrowserHost } from "./BrowserHost.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly LOADER: WorkerLoader;
    }
  }
}

type Command = {
  readonly id: number;
  readonly method: string;
  readonly params?: { readonly targetId?: string; readonly expression?: string };
  readonly sessionId?: string;
};

/** A page of the fake browser. */
export type FakePage = { url: string; title: string };

/** What one `acquire` was asked: Browser Run's options as the binding was given them, `outboundByHost` among them. */
export type Acquired = {
  readonly keepAlive?: number;
  readonly outboundByHost?: Readonly<Record<string, Fetcher>>;
};

/**
 * A Browser Run with one browser at a time (`s1`, `s2`, ...), acquired with `acquire` (its options kept in `acquired`),
 * whose pages a test can set and close; `lose` makes Browser Run forget the browser that runs. Over CDP it opens pages
 * (`page-1`, `page-2`, ...), attaches to them (session `in-<targetId>`), answers `Runtime.evaluate` with the page it ran
 * in (or, for the expression `close`, closes that page first and fails as Chrome does), and mints Live View links.
 */
export const fakeBrowserRun = () => {
  /** Every command, with the page its session is in. */
  const sent: Array<{ readonly method: string; readonly page?: string }> = [];
  const acquired: Acquired[] = [];

  const state = {
    created: 0,
    opened: 0,
    pages: new Map<string, FakePage>(),
    sent,
    acquired,
    /** Whether Browser Run lost the browser that runs. */
    lost: false,
  };

  const targetOf = (sessionId: string | undefined) => sessionId?.replace(/^in-/, "");

  const answer = ({ method, params, sessionId }: Command) => {
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [...state.pages].map(([targetId, page]) => ({
            targetId,
            type: "page",
            attached: false,
            ...page,
          })),
        };
      case "Target.createTarget": {
        state.opened += 1;

        const targetId = `page-${state.opened}`;

        state.pages.set(targetId, { url: "about:blank", title: "" });

        return { targetId };
      }

      case "Target.attachToTarget": {
        const targetId = params?.targetId ?? "";

        return state.pages.has(targetId) ? { sessionId: `in-${targetId}` } : undefined;
      }

      case "Runtime.evaluate": {
        const page = targetOf(sessionId);

        if (page === undefined || !state.pages.has(page)) return undefined;

        if (params?.expression === "close") {
          state.pages.delete(page);

          return undefined;
        }

        return { result: { type: "string", value: `in ${page}` } };
      }

      case "Cloudflare.getLiveView":
        return { webSocketDebuggerUrl: `wss://live.example/${params?.targetId ?? "newest"}` };
      default:
        return {};
    }
  };

  const binding: BrowserBinding = {
    acquire: (options) => {
      // SAFETY: the host's binding passes `outboundByHost` beside what `agents/browser` types (`container-preview.ts`).
      acquired.push({ ...(options as Acquired) });
      state.created += 1;
      state.lost = false;
      state.pages.clear();

      return Promise.resolve({ sessionId: `s${state.created}` });
    },
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";

      const session = /^\/v1\/devtools\/browser\/([^/]+)(\/json\/list)?$/.exec(url.pathname);

      if (session === null || session[1] !== `s${state.created}` || state.lost) {
        return Promise.resolve(new Response("gone", { status: 404 }));
      }

      if (method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));

      if (session[2] !== undefined) {
        return Promise.resolve(
          Response.json([...state.pages].map(([id, page]) => ({ id, type: "page", ...page }))),
        );
      }

      const pair = new WebSocketPair();
      const server = pair[1];

      server.accept();
      server.addEventListener("message", (event) => {
        // SAFETY: what `agents/browser` and the host send is a CDP command, with only the params read here typed.
        const command = JSON.parse(String(event.data)) as Command;
        const page = targetOf(command.sessionId);

        state.sent.push(
          page === undefined ? { method: command.method } : { method: command.method, page },
        );

        const result = answer(command);

        server.send(
          JSON.stringify(
            result === undefined
              ? { id: command.id, error: { code: -32000, message: "Target closed" } }
              : { id: command.id, result },
          ),
        );
      });

      return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
    },
  };

  return { binding, state, lose: () => void (state.lost = true) };
};

export type FakeBrowserRun = ReturnType<typeof fakeBrowserRun>;

/** Code that reads which page its active tab is. */
export const WHERE =
  'async () => (await cdp.send({ method: "Runtime.evaluate", params: { expression: "1", returnByValue: true }, sessionId: "active" })).result.value';

export const textOf = (run: BrowserRun) =>
  run.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** The Session's Workspace, as the Session names it to the calls that can acquire a browser. */
export const WORKSPACE = "ws:abc";

/**
 * The host as a Session calls it: the calls that can acquire a browser name the Session's Workspace, `workspace`, last
 * (none when it is undefined, as a Session without one, or from before Container previews, calls them).
 */
export const asSession = (host: BrowserHost, workspace: ContainerPreviewWorkspace | undefined) => ({
  run: (code: string, conversationId: number, ownerTabId?: string) =>
    host.run(code, conversationId, ownerTabId, workspace),
  close: () => host.close(),
  startHandoff: (input: HandoffStartInput) => host.startHandoff(input),
  ownerTabView: (open: boolean) => host.ownerTabView(open, workspace),
  ownerTabs: () => host.ownerTabs(),
  openOwnerTab: () => host.openOwnerTab(workspace),
  showOwnerTab: (id: string) => host.showOwnerTab(id),
  closeOwnerTab: (id: string) => host.closeOwnerTab(id),
  readOwnerTabPages: (ids: ReadonlyArray<string>) => host.readOwnerTabPages(ids),
});

export type SessionHost = ReturnType<typeof asSession>;

let objects = 0;

/** `test` with a `BrowserHost` over a fresh Durable Object's state and a fake Browser Run. */
export const withHost = (test: (host: BrowserHost, run: FakeBrowserRun) => Promise<void>) => {
  objects += 1;

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `BROWSER_HOST` is the namespace of the `BrowserHost` class; the global types it by its RPC methods only (`worker.workerd.test.ts`).
  const stub = env.BROWSER_HOST.getByName(`host-${objects}`) as unknown as DurableObjectStub;

  return runInDurableObject(stub, async (_instance, state) => {
    const run = fakeBrowserRun();

    await test(new BrowserHost(state, { BROWSER: run.binding, LOADER: env.LOADER }), run);
  });
};

/** `withHost`, with the host as a Session calls it, naming `WORKSPACE` to the calls that can acquire a browser. */
export const withSessionHost = (test: (host: SessionHost, run: FakeBrowserRun) => Promise<void>) =>
  withHost((host, run) => test(asSession(host, WORKSPACE), run));
