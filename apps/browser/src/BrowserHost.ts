// @effect-diagnostics asyncFunction:off preferEffectArray:off globalConsole:off newPromise:off globalTimers:off -- a plain Durable Object class, reached over Workers RPC, which is Promise-based.
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
  type OwnerTabLinks,
  type OwnerTabListing,
} from "@cloudpid/extensions/browser/contract";
import {
  Browser,
  type BrowserBinding,
  browserRun,
  DurableBrowserSessionStore,
} from "agents/browser";
import { browserTool, type PiBrowserTool } from "agents/browser/pi";
import { DurableObject } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import { openCdpSocket } from "./cdp-socket.ts";
import { HandoffHost } from "./handoff.ts";
import { confinedToOwnerTabs, runInOwnerTab } from "./owner-tab-agent.ts";
import { OwnerTabs } from "./owner-tabs.ts";
import {
  adoptTab,
  conversationScope,
  forgetScope,
  openTab,
  type TabLookup,
  tabIn,
  tabOf,
  tabStatesIn,
  tabsIn,
} from "./tab.ts";

/** How long closing the browser waits to note where the Owner tabs are, at most. */
const RECORD_BEFORE_CLOSE_MS = 2_000;

/** What the browser Worker binds (`resource.ts`). */
export type BrowserHostEnv = {
  readonly BROWSER: BrowserBinding;
  readonly LOADER: WorkerLoader;
};

/**
 * `browserTool` as the host calls it: the one thing it reads of a call is the scope the code runs in (`scopeOf`): a
 * conversation's tab (`conversation:<id>`) or an Owner tab (`owner-tab:<id>`). Its result is plain data: text and image
 * parts and JSON details. It holds them as `output` from agents 0.29, which follows pi-durable 1.3, and as `content`
 * before.
 */
type ScopedTool = {
  execute(
    args: { code: string },
    api: { conversationId: number; scope: string },
  ): Promise<
    Omit<BrowserRun, "output"> & Partial<Record<"output" | "content", BrowserRun["output"]>>
  >;
};

/** The scope a call to `browserTool` runs in: the one the host gave it, else its conversation's. */
const scopeOf = (api: object & { readonly conversationId: unknown }): string =>
  Predicate.hasProperty(api, "scope") && Predicate.isString(api.scope)
    ? api.scope
    : conversationScope(Number(api.conversationId));

export class BrowserHost extends DurableObject<BrowserHostEnv> implements BrowserHostRpc {
  readonly #store: DurableBrowserSessionStore;
  readonly #browser: Browser;
  readonly #tool: PiBrowserTool;
  readonly #handoffs: HandoffHost;
  readonly #ownerTabs: OwnerTabs;

  constructor(ctx: DurableObjectState, env: BrowserHostEnv) {
    super(ctx, env);
    this.#store = new DurableBrowserSessionStore(ctx.storage);
    this.#browser = new Browser({
      provider: browserRun(env.BROWSER, { keepAliveMs: BROWSER_KEEP_ALIVE_MS }),
      store: this.#store,
    });
    // One tool for every scope: it builds a scope's connector when first asked, and runs each scope's calls in turn.
    this.#tool = browserTool({
      ctx,
      browser: confinedToOwnerTabs(this.#browser),
      loader: env.LOADER,
      scope: scopeOf,
    });
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
    this.#ownerTabs = new OwnerTabs({
      records: ctx.storage.kv,
      browser: {
        tabOf: (scope) => tabIn(this.#lookup, scope),
        tabsOf: (scopes) => tabsIn(this.#lookup, scopes),
        statesOf: (scopes) => tabStatesIn(this.#lookup, scopes),
        adoptTab: (scope, targetId, browserSessionId) =>
          adoptTab(
            { name: this.#browser.name, store: this.#store },
            scope,
            targetId,
            browserSessionId,
          ),
        openTab: (scope, url) => openTab(this.#browser, scope, url),
        forget: (scope) => forgetScope({ name: this.#browser.name, store: this.#store }, scope),
        connect: (browserSessionId) => openCdpSocket(env.BROWSER, browserSessionId),
      },
    });
  }

  /** Where the stored records say the scopes' tabs are, read without starting anything. */
  get #lookup(): TabLookup {
    return { name: this.#browser.name, store: this.#store, binding: this.env.BROWSER };
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
   * Run `code` in conversation `conversationId`'s tab or, given `ownerTabId`, in that Owner tab (`runInOwnerTab`). The
   * result is the tool result `browserTool` makes: its output as text, a screenshot as an image part, and its details.
   */
  run(code: string, conversationId: number, ownerTabId?: string): Promise<BrowserRun> {
    if (ownerTabId === undefined) {
      return this.#runIn(code, conversationId, conversationScope(conversationId));
    }

    return runInOwnerTab(
      ownerTabId,
      { list: () => this.#ownerTabs.list(), tabOf: (scope) => tabIn(this.#lookup, scope) },
      (scope) => this.#runIn(code, conversationId, scope),
    );
  }

  async #runIn(code: string, conversationId: number, scope: string): Promise<BrowserRun> {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: `browserTool` takes no Chord context and reads only `api.conversationId` and the `scope` `scopeOf` reads; see `ScopedTool`.
    const tool = this.#tool as unknown as ScopedTool;

    const { output, content, ...rest } = await tool.execute({ code }, { conversationId, scope });

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

  /**
   * Mint 60-second Live View links to the Owner tab the owner's Browser Pane shows and the windows it opened; with `open`
   * (the Pane opening), start the browser when none runs and open an Owner tab when the owner has none, saying so. They
   * go only to the Session DO, which answers the one client that asked; none is kept.
   */
  ownerTabView(open: boolean): Promise<OwnerTabLinks> {
    return this.#ownerTabs.view(open);
  }

  /**
   * The Owner tabs by title and the one shown, as the browser has them now. A link a page opened in a new tab joins the
   * list; a pop-up stays a window of its tab. Starts nothing: with no browser running the list is empty.
   */
  ownerTabs(): Promise<OwnerTabListing> {
    return this.#ownerTabs.tabs();
  }

  /** Open a blank Owner tab and show it, starting the browser when none runs. */
  openOwnerTab(): Promise<OwnerTabListing> {
    return this.#ownerTabs.open();
  }

  /** Show Owner tab `id`, on every device (the one shown is this object's). */
  showOwnerTab(id: string): Promise<OwnerTabListing> {
    return this.#ownerTabs.show(id);
  }

  /** Close Owner tab `id` and the windows it opened; the conversations' tabs are never touched. */
  closeOwnerTab(id: string): Promise<OwnerTabListing> {
    return this.#ownerTabs.close(id);
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

  /**
   * Close the browser: its record is retired and its Browser Run session ends. False when there was none. The Owner tabs'
   * addresses are noted first (for as long as `RECORD_BEFORE_CLOSE_MS`, so a slow browser does not hold the close up), so
   * that the browser that replaces this one reopens them where the owner left them.
   */
  async close(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.#ownerTabs.tabs(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RECORD_BEFORE_CLOSE_MS);
        }),
      ]);
    } catch (error) {
      console.warn(`Recording the Owner tabs before closing the browser failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    return this.#browser.close();
  }
}
