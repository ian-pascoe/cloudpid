// @effect-diagnostics asyncFunction:off preferEffectArray:off cryptoRandomUUID:off
// The Browser Pane's Owner tabs in the browser host (`docs/spec.md` → Browser, ADR-0013): pages of the Session's one
// shared browser (ADR-0007) that the owner opened, apart from the conversations' tabs but sharing their cookies and
// logins. Each Owner tab is a scope of `agents/browser` of its own (`owner-tab:<id>`), whose record names the tab and the
// browser it lives in, as a conversation's scope does; this object keeps the list of Owner tabs (by `id`) and the one
// the Pane shows, never a link.
//
// The Pane asks for links when it opens (`view(true)`: the browser is started when none runs, and an Owner tab opened
// and shown when the owner has none), and again on every reconnect and when a window opens or closes (`view(false)`,
// which starts and opens nothing). Each answer is fresh 60-second links to the tab and its windows, minted as a
// Browser Handoff's are (`./cdp.ts`), for the Session to answer the asking client alone. A tab whose browser was closed
// or replaced, or that was closed, is gone: `view(false)` says so (`OWNER_TAB_GONE`), and the Pane offers to open a new
// one. The tab strip (several Owner tabs), keeping them across a new browser, and the agent in them come later; the list
// is here so they have somewhere to go.
import { OWNER_TAB_GONE, type OwnerTabLinks } from "@cloudpid/extensions/browser/contract";
import { BrowserGoneError, type CdpTransport, isNoTarget, mintLink, windowsOf } from "./cdp.ts";
import type { Tab } from "./tab.ts";

/** The `agents/browser` scope of Owner tab `id`: its record names the tab and the browser it is in. */
export const ownerTabScope = (id: string): string => `owner-tab:${id}`;

/** What the host's browser provides the Owner tabs. */
export type OwnerTabsBrowser = {
  /**
   * The tab scope `scope` works in, if its browser is the current one and the tab is still open; read from the stored
   * records, starting no browser.
   */
  readonly tabOf: (scope: string) => Promise<Tab | undefined>;
  /** Open a blank tab for scope `scope`, in the browser that runs or in a new one when none does, and record it. */
  readonly openTab: (scope: string) => Promise<Tab>;
  /** A new CDP connection to Browser Run session `browserSessionId`. */
  readonly connect: (browserSessionId: string) => Promise<CdpTransport>;
};

/** The object's synchronous key-value storage, as the Owner tabs use it. */
export type OwnerTabRecords = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** The owner's tabs, in the order they were opened, and the one the Browser Pane shows. */
export type OwnerTabList = {
  readonly tabs: ReadonlyArray<{ readonly id: string }>;
  readonly shown?: string;
};

const KEY = "owner-tabs";

const EMPTY: OwnerTabList = { tabs: [] };

/** The tab shown, found: its `id` and where it is. */
type Shown = { readonly id: string; readonly tab: Tab };

export class OwnerTabs {
  readonly #records: OwnerTabRecords;
  readonly #browser: OwnerTabsBrowser;
  readonly #newId: () => string;
  /** Opening in flight, so that two Panes opening at once open one Owner tab. */
  #opening: Promise<Shown> | undefined;

  constructor(options: {
    readonly records: OwnerTabRecords;
    readonly browser: OwnerTabsBrowser;
    /** A new Owner tab's ID. Defaults to a random UUID. */
    readonly newId?: () => string;
  }) {
    this.#records = options.records;
    this.#browser = options.browser;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** The Owner tabs and the one shown, as kept. */
  list(): OwnerTabList {
    return this.#records.get<OwnerTabList>(KEY) ?? EMPTY;
  }

  #save(list: OwnerTabList): void {
    this.#records.put(KEY, list);
  }

  /** The Owner tab shown, if it is still there; never starts or opens anything. */
  async #shown(): Promise<Shown | undefined> {
    const { shown } = this.list();

    if (shown === undefined) return undefined;

    const tab = await this.#browser.tabOf(ownerTabScope(shown));

    return tab === undefined ? undefined : { id: shown, tab };
  }

  /**
   * The Owner tab shown, or, when it is gone, another of the owner's that is still there, or else a new one, opened (in
   * the browser that runs, or a new one) and shown. The ones that are gone leave the list.
   */
  #open(): Promise<Shown> {
    this.#opening ??= (async () => {
      const shown = await this.#shown();

      if (shown !== undefined) return shown;

      const list = this.list();
      const left: Array<{ readonly id: string }> = [];
      let found: Shown | undefined;

      for (const { id } of list.tabs) {
        const tab = id === list.shown ? undefined : await this.#browser.tabOf(ownerTabScope(id));

        if (tab === undefined) continue;

        left.push({ id });
        found ??= { id, tab };
      }

      if (found === undefined) {
        const id = this.#newId();

        found = { id, tab: await this.#browser.openTab(ownerTabScope(id)) };
        left.push({ id });
      }

      this.#save({ tabs: left, shown: found.id });

      return found;
    })().finally(() => {
      this.#opening = undefined;
    });

    return this.#opening;
  }

  /**
   * Fresh Live View links to the Owner tab shown and to every window it opened that is still open, each good for 60 s
   * and named by its target. With `open`, the browser is started when none runs and an Owner tab opened when the owner
   * has none still there; without it, a tab that is gone (or none) fails with `OWNER_TAB_GONE`.
   */
  async view(open: boolean): Promise<OwnerTabLinks> {
    const shown = open ? await this.#open() : await this.#shown();

    if (shown === undefined) throw new Error(OWNER_TAB_GONE);

    const { id, tab } = shown;
    let transport: CdpTransport;

    try {
      transport = await this.#browser.connect(tab.browserSessionId);
    } catch (error) {
      if (error instanceof BrowserGoneError) throw new Error(OWNER_TAB_GONE, { cause: error });

      throw error;
    }

    try {
      const [link, found] = await Promise.all([
        mintLink(transport, tab.targetId),
        windowsOf(transport, tab.targetId),
      ]);

      const windows = await Promise.all(
        found.map(async ({ targetId, openerId, title }) => ({
          targetId,
          openerId,
          title,
          link: await mintLink(transport, targetId),
        })),
      );

      return { ownerTabId: id, tab: { targetId: tab.targetId, link }, windows };
    } catch (error) {
      // Browser Run says the tab is not there (it closed since the records were read).
      if (isNoTarget(error)) throw new Error(OWNER_TAB_GONE, { cause: error });

      throw error;
    } finally {
      transport.close();
    }
  }
}
