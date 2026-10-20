// @effect-diagnostics asyncFunction:off -- a plain Durable Object class, reached over Workers RPC, which is Promise-based.
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
} from "@cloudpid/extensions/browser/contract";
import {
  Browser,
  type BrowserBinding,
  browserRun,
  DurableBrowserSessionStore,
} from "agents/browser";
import { browserTool, type PiBrowserTool } from "agents/browser/pi";
import { DurableObject } from "cloudflare:workers";

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
  readonly #browser: Browser;
  readonly #tool: PiBrowserTool;

  constructor(ctx: DurableObjectState, env: BrowserHostEnv) {
    super(ctx, env);
    this.#browser = new Browser({
      provider: browserRun(env.BROWSER, { keepAliveMs: BROWSER_KEEP_ALIVE_MS }),
      store: new DurableBrowserSessionStore(ctx.storage),
    });
    this.#tool = browserTool({ ctx, browser: this.#browser, loader: env.LOADER });
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

  /** Close the browser: its record is retired and its Browser Run session ends. False when there was none. */
  close(): Promise<boolean> {
    return this.#browser.close();
  }
}
