// @effect-diagnostics asyncFunction:off preferEffectArray:off globalConsole:off -- a plain Durable Object class, reached over Workers RPC, which is Promise-based.
// The browser host: one Durable Object per Session (ADR-0007) with the Session's one Browser Run browser, driven by
// `agents/browser`'s `browserTool`. The Session DO reaches it over RPC, because the tool needs this Worker's
// `CodemodeRuntime` facet and the Loader that runs the model's CDP code (`docs/spec.md` → Browser).
//
// `Browser` keeps its record in this object's storage through an explicit store, so no `Lifecycle` is installed: it would
// take over the object's `fetch`, `alarm`, and WebSocket handlers, and the browser needs none of them. Browser Run
// closes an idle browser itself after `keepAliveMs`; the Session closes it sooner, when it is idle (`close`).
import {
  BROWSER_KEEP_ALIVE_MS,
  type BrowserHostRpc,
  type BrowserRun,
  type HandoffEnded,
  type HandoffStarted,
  type HandoffStartInput,
  type HandoffStatus,
  type LiveViewLinks,
} from "@cloudpid/extensions/browser/contract";
import {
  Browser,
  type BrowserBinding,
  browserRun,
  DurableBrowserSessionStore,
} from "agents/browser";
import { browserTool, type PiBrowserTool } from "agents/browser/pi";
import { DurableObject } from "cloudflare:workers";
import { openCdpSocket } from "./cdp-socket.ts";
import { HandoffHost } from "./handoff.ts";
import { tabOf } from "./tab.ts";

/** What the browser Worker binds (`resource.ts`). */
export type BrowserHostEnv = {
  readonly BROWSER: BrowserBinding;
  readonly LOADER: WorkerLoader;
};

/**
 * `browserTool` as the host calls it: the one thing it reads of a call is its conversation, whose tab (`conversation:<id>`,
 * the `scope` option's default) the code runs in. Its result is plain data: text and image parts and JSON details. It
 * holds them as `output` from agents 0.29, which follows pi-durable 1.3, and as `content` before.
 */
type ConversationTool = {
  execute(
    args: { code: string },
    api: { conversationId: number },
  ): Promise<
    Omit<BrowserRun, "output"> & Partial<Record<"output" | "content", BrowserRun["output"]>>
  >;
};

export class BrowserHost extends DurableObject<BrowserHostEnv> implements BrowserHostRpc {
  readonly #store: DurableBrowserSessionStore;
  readonly #browser: Browser;
  readonly #tool: PiBrowserTool;
  readonly #handoffs: HandoffHost;

  constructor(ctx: DurableObjectState, env: BrowserHostEnv) {
    super(ctx, env);
    this.#store = new DurableBrowserSessionStore(ctx.storage);
    this.#browser = new Browser({
      provider: browserRun(env.BROWSER, { keepAliveMs: BROWSER_KEEP_ALIVE_MS }),
      store: this.#store,
    });
    this.#tool = browserTool({ ctx, browser: this.#browser, loader: env.LOADER });
    this.#handoffs = new HandoffHost({
      records: ctx.storage.kv,
      schedule: (at) => this.#wakeAt(at),
      browser: {
        tabOf: (conversationId) =>
          tabOf(
            { name: this.#browser.name, store: this.#store, binding: env.BROWSER },
            conversationId,
          ),
        connect: (browserSessionId) => openCdpSocket(env.BROWSER, browserSessionId),
      },
    });
  }

  /** Wake this object at `at` (epoch milliseconds) or sooner, to drop expired handoffs (`alarm`). */
  #wakeAt(at: number): void {
    void this.ctx.storage
      .getAlarm()
      .then((current) =>
        current === null || current > at ? this.ctx.storage.setAlarm(at) : undefined,
      )
      .catch((error: Error) => console.warn(`Setting the handoff alarm failed: ${String(error)}`));
  }

  /** Drop the handoffs whose deadline has long passed (the Session did not end them), and wake again for the next. */
  alarm(): void {
    const next = this.#handoffs.prune();

    if (next !== undefined) void this.ctx.storage.setAlarm(next);
  }

  /** The tool's description: how the model drives the browser. */
  describe(): Promise<string> {
    return Promise.resolve(this.#tool.description);
  }

  /**
   * Run `code` in conversation `conversationId`'s tab. The result is the tool result `browserTool` makes: its output as
   * text, a screenshot as an image part, and its details.
   */
  async run(code: string, conversationId: number): Promise<BrowserRun> {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `browserTool` takes no Chord context and reads only `api.conversationId`; see `ConversationTool`.
    const tool = this.#tool as unknown as ConversationTool;

    const { output, content, ...rest } = await tool.execute({ code }, { conversationId });

    return { ...rest, output: output ?? content ?? [] };
  }

  /** Hand conversation `input.conversationId`'s tab to the owner (`Cloudflare.handoff`), noting its viewport. */
  startHandoff(input: HandoffStartInput): Promise<HandoffStarted> {
    return this.#handoffs.start(input);
  }

  /**
   * Mint 60-second Live View links to handoff `requestId`'s tab and the windows it opened. They are for the owner alone
   * and go only to the Session DO, which answers the one client that asked; none is kept.
   */
  liveView(requestId: string): Promise<LiveViewLinks> {
    return this.#handoffs.liveView(requestId);
  }

  /** Wait up to `maxMs` for the handoff `requestId` to end, and say where it stands. */
  waitHandoff(requestId: string, maxMs: number): Promise<HandoffStatus> {
    return this.#handoffs.wait(requestId, maxMs);
  }

  /**
   * Finish handoff `requestId`, ending it in Browser Run if the owner has not, give the agent its viewport back, and
   * forget it; says the origins of the windows the tab left open.
   */
  endHandoff(requestId: string): Promise<HandoffEnded> {
    return this.#handoffs.end(requestId);
  }

  /** Close the browser: its record is retired and its Browser Run session ends. False when there was none. */
  close(): Promise<boolean> {
    return this.#browser.close();
  }
}
