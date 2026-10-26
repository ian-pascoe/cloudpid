// @effect-diagnostics asyncFunction:off preferEffectArray:off cryptoRandomUUID:off globalConsole:off
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
// one; `view(true)` shows another and says the one shown before is gone (`replaced`).
//
// The owner keeps several Owner tabs (the Pane's tab strip): `tabs()` lists them by title with the one shown, `open`
// adds a blank one and shows it, `show` shows another, and `close` closes one and the windows it opened. Which is shown
// is this object's, so every device shows the same one. A page an Owner tab opened joins the list when `tabs()` next
// looks: a link that opens a new tab (`target=_blank`, a middle click) leaves the page unable to reach its opener
// (`canAccessOpener` is false: `noopener` is implied), a pop-up (`window.open`, an OAuth window) can reach it and needs
// to, so the first becomes an Owner tab of its own, shown when the tab it came from was, and the second stays a window of
// its tab (`./cdp.ts`). The conversations' tabs are never listed, shown or closed here: only pages that descend from an
// Owner tab are looked at. Keeping the Owner tabs across a new browser and the agent in them come later.
import {
  OWNER_TAB_GONE,
  type OwnerTabLinks,
  type OwnerTabListing,
} from "@cloudpid/extensions/browser/contract";
import {
  BrowserGoneError,
  type CdpTransport,
  isNoTarget,
  mintViewLinks,
  type PageTarget,
  pagesOf,
  windowsAmong,
} from "./cdp.ts";
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
  /** The tabs of scopes `scopes` that are still there (`tabOf` for several, asking Browser Run once). */
  readonly tabsOf: (scopes: ReadonlyArray<string>) => Promise<Map<string, Tab>>;
  /** Record page `targetId`, which a page of the browser opened, as scope `scope`'s tab. */
  readonly adoptTab: (scope: string, targetId: string) => Promise<Tab>;
  /** Open a blank tab for scope `scope`, in the browser that runs or in a new one when none does, and record it. */
  readonly openTab: (scope: string) => Promise<Tab>;
  /** Delete scope `scope`'s record: an Owner tab that is gone, done with. */
  readonly forget: (scope: string) => Promise<void>;
  /** A new CDP connection to Browser Run session `browserSessionId`. */
  readonly connect: (browserSessionId: string) => Promise<CdpTransport>;
};

/** The object's synchronous key-value storage, as the Owner tabs use it. */
export type OwnerTabRecords = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** The Owner tabs, in the order they were opened, and the one the Browser Pane shows. */
export type OwnerTabList = {
  readonly tabs: ReadonlyArray<{ readonly id: string }>;
  readonly shown?: string;
};

const KEY = "owner-tabs";

/**
 * The most Owner tabs the list takes: a page that keeps opening tabs does not fill the browser's scopes
 * (`MAX_BROWSER_SCOPES`, which the conversations share). Pages past it are left alone.
 */
export const MAX_OWNER_TABS = 20;

const EMPTY: OwnerTabList = { tabs: [] };

/** Whether a page that opened `target` made it an Owner tab rather than a window: it cannot reach its opener. */
const isTab = (target: PageTarget): boolean => target.canAccessOpener === false;

/** The tab shown, found: its `id` and where it is. */
type Shown = { readonly id: string; readonly tab: Tab };

/** The tab an ask with `open` shows, and what it did to show it (`OwnerTabLinks`' `opened` and `replaced`). */
type Opened = { readonly shown: Shown; readonly opened: boolean; readonly replaced: boolean };

export class OwnerTabs {
  readonly #records: OwnerTabRecords;
  readonly #browser: OwnerTabsBrowser;
  readonly #newId: () => string;
  /** What changes the list runs one after another, so that two Panes opening at once open one Owner tab. */
  #queue: Promise<unknown> = Promise.resolve();

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

  /** Run `run` after what was asked before it, whether that worked or not. */
  #serial<A>(run: () => Promise<A>): Promise<A> {
    const result = this.#queue.then(run, run);

    this.#queue = result.catch(() => undefined);

    return result;
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
   * the browser that runs, or a new one) and shown. The ones that are gone leave the list, and their scope records go.
   */
  #open(): Promise<Opened> {
    return this.#serial(async (): Promise<Opened> => {
      const shown = await this.#shown();

      if (shown !== undefined) return { shown, opened: false, replaced: false };

      const list = this.list();
      const left: Array<{ readonly id: string }> = [];
      const gone: string[] = [];
      let found: Shown | undefined;

      for (const { id } of list.tabs) {
        const tab = id === list.shown ? undefined : await this.#browser.tabOf(ownerTabScope(id));

        if (tab === undefined) {
          gone.push(id);
          continue;
        }

        left.push({ id });
        found ??= { id, tab };
      }

      const opened = found === undefined;

      if (found === undefined) {
        const id = this.#newId();

        found = { id, tab: await this.#browser.openTab(ownerTabScope(id)) };
        left.push({ id });
      }

      this.#save({ tabs: left, shown: found.id });
      await this.#forget(gone);

      return { shown: found, opened, replaced: list.shown !== undefined };
    });
  }

  /**
   * The Owner tab shown, if it is still there. When it is gone and others are not (a page closed itself), the list is
   * looked at first: it shows a neighbour in its place.
   */
  async #shownNow(): Promise<Shown | undefined> {
    const shown = await this.#shown();

    if (shown !== undefined || this.list().tabs.length < 2) return shown;

    await this.#serial(() => this.#sync());

    return this.#shown();
  }

  /**
   * The Owner tabs by title and the one shown, as the browser has them now. The ones that are gone leave the list (and
   * their scope records go) while another is still there, the one shown giving way to its neighbour; with none left (the
   * browser was closed or replaced) the list is kept as it is, for `view(true)` to say it was replaced. A page an Owner
   * tab opened that cannot reach its opener joins as an Owner tab, and is shown when the tab it came from was.
   */
  async #sync(): Promise<OwnerTabListing> {
    const stored = this.list();

    if (stored.tabs.length === 0) return { tabs: [] };

    const found = await this.#browser.tabsOf(stored.tabs.map(({ id }) => ownerTabScope(id)));
    const present = stored.tabs.flatMap(({ id }) => {
      const tab = found.get(ownerTabScope(id));

      return tab === undefined ? [] : [{ id, tab }];
    });

    const first = present[0];

    if (first === undefined) return { tabs: [] };

    let pages: PageTarget[];

    try {
      const transport = await this.#browser.connect(first.tab.browserSessionId);

      try {
        pages = await pagesOf(transport);
      } finally {
        transport.close();
      }
    } catch (error) {
      if (error instanceof BrowserGoneError) return { tabs: [] };

      throw error;
    }

    const owned = new Map(present.map(({ id, tab }) => [tab.targetId, id]));
    const joined: Array<{ readonly id: string; readonly tab: Tab; readonly page: PageTarget }> = [];

    // Every page that descends from an Owner tab; those that cannot reach their opener are tabs.
    const family = new Set(owned.keys());
    const tabsLeft = MAX_OWNER_TABS - present.length;

    for (let grew = true; grew;) {
      grew = false;

      for (const page of pages) {
        if (
          family.has(page.targetId) ||
          page.openerId === undefined ||
          !family.has(page.openerId)
        ) {
          continue;
        }

        if (isTab(page) && joined.length >= tabsLeft) continue;

        family.add(page.targetId);
        grew = true;

        if (!isTab(page)) continue;

        const id = this.#newId();

        try {
          joined.push({
            id,
            tab: await this.#browser.adoptTab(ownerTabScope(id), page.targetId),
            page,
          });
        } catch (error) {
          // Looked at again next time.
          family.delete(page.targetId);
          console.warn(`Recording a page an Owner tab opened failed: ${String(error)}`);
        }
      }
    }

    const ownerOf = (page: PageTarget): string | undefined => {
      for (
        let at: PageTarget | undefined = page;
        at !== undefined;
        at = pages.find((other) => other.targetId === at?.openerId)
      ) {
        const id = owned.get(at.targetId);

        if (id !== undefined) return id;
      }

      return undefined;
    };

    const kept = present.map(({ id }) => ({ id }));
    const tabs = [...kept, ...joined.map(({ id }) => ({ id }))];
    const stillThere = new Set(present.map(({ id }) => id));

    let shown = stored.shown;

    if (shown !== undefined && !stillThere.has(shown)) {
      const at = stored.tabs.findIndex(({ id }) => id === shown);

      shown = (
        stored.tabs.slice(at + 1).find(({ id }) => stillThere.has(id)) ??
        stored.tabs
          .slice(0, at)
          .reverse()
          .find(({ id }) => stillThere.has(id))
      )?.id;
    }

    // A tab opened from the tab shown is shown, as in a browser.
    const fromShown = joined.filter(({ page }) => shown !== undefined && ownerOf(page) === shown);

    shown = fromShown.at(-1)?.id ?? shown ?? tabs[0]?.id;

    const next: OwnerTabList = shown === undefined ? { tabs } : { tabs, shown };

    if (JSON.stringify(next) !== JSON.stringify(stored)) this.#save(next);

    await this.#forget(stored.tabs.filter(({ id }) => !stillThere.has(id)).map(({ id }) => id));

    const titles = new Map(pages.map((page) => [page.targetId, page.title]));
    const targets = new Map([...present, ...joined].map(({ id, tab }) => [id, tab.targetId]));

    return {
      tabs: tabs.map(({ id }) => ({ id, title: titles.get(targets.get(id) ?? "") ?? "" })),
      ...(shown === undefined ? {} : { shown }),
    };
  }

  /** The Owner tabs by title and the one shown (`#sync`); starts nothing, and is empty when no browser runs. */
  tabs(): Promise<OwnerTabListing> {
    return this.#serial(() => this.#sync());
  }

  /** Open a blank Owner tab, in the browser that runs or a new one, and show it. */
  open(): Promise<OwnerTabListing> {
    return this.#serial(async () => {
      if (this.list().tabs.length >= MAX_OWNER_TABS) {
        throw new Error(`There are ${MAX_OWNER_TABS} Owner tabs open: close one to open another`);
      }

      const id = this.#newId();

      await this.#browser.openTab(ownerTabScope(id));

      const { tabs } = this.list();

      this.#save({ tabs: [...tabs, { id }], shown: id });

      return this.#sync();
    });
  }

  /** Show Owner tab `id`; fails with `OWNER_TAB_GONE` when it is not in the list or no longer in the browser. */
  show(id: string): Promise<OwnerTabListing> {
    return this.#serial(async () => {
      const { tabs } = this.list();

      if (
        !tabs.some((tab) => tab.id === id) ||
        (await this.#browser.tabOf(ownerTabScope(id))) === undefined
      ) {
        throw new Error(OWNER_TAB_GONE);
      }

      this.#save({ tabs, shown: id });

      return this.#sync();
    });
  }

  /**
   * Close Owner tab `id` and the windows it opened, and drop it from the list; the one shown, if it was that, gives way to
   * its neighbour on the right, else on the left. Tabs it opened are Owner tabs of their own and stay. An Owner tab that
   * is not in the list, or already gone, is not an error.
   */
  close(id: string): Promise<OwnerTabListing> {
    return this.#serial(async () => {
      // The tabs it opened join the list first, so that closing it does not leave them without an owner.
      await this.#sync();

      const { tabs, shown } = this.list();
      const at = tabs.findIndex((tab) => tab.id === id);

      if (at < 0) return this.#sync();

      const tab = await this.#browser.tabOf(ownerTabScope(id));

      if (tab !== undefined) await this.#closePages(tab);

      const left = tabs.filter((other) => other.id !== id);
      const next = shown === id ? (left[at] ?? left[at - 1]) : undefined;

      this.#save(
        shown !== id
          ? { tabs: left, ...(shown === undefined ? {} : { shown }) }
          : next === undefined
            ? { tabs: left }
            : { tabs: left, shown: next.id },
      );
      await this.#forget([id]);

      return this.#sync();
    });
  }

  /** Close `tab` and the windows it opened (not the Owner tabs it opened); a page that is already gone is left. */
  async #closePages(tab: Tab): Promise<void> {
    let transport: CdpTransport;

    try {
      transport = await this.#browser.connect(tab.browserSessionId);
    } catch (error) {
      if (error instanceof BrowserGoneError) return;

      throw error;
    }

    try {
      const windows = windowsAmong(await pagesOf(transport), tab.targetId, isTab);

      for (const { targetId } of [...windows.reverse(), tab]) {
        try {
          await transport.send("Target.closeTarget", { targetId });
        } catch (error) {
          if (!isNoTarget(error)) throw error;
        }
      }
    } finally {
      transport.close();
    }
  }

  /** Delete the scope records of Owner tabs `ids`, which are gone; one that cannot be deleted is left. */
  async #forget(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) {
      try {
        await this.#browser.forget(ownerTabScope(id));
      } catch (error) {
        console.warn(`Forgetting an Owner tab that is gone failed: ${String(error)}`);
      }
    }
  }

  /**
   * Fresh Live View links to the Owner tab shown and to every window it opened that is still open, each good for 60 s
   * and named by its target. With `open`, the browser is started when none runs and an Owner tab opened when the owner
   * has none still there; without it, a tab that is gone (or none) fails with `OWNER_TAB_GONE`.
   */
  async view(open: boolean): Promise<OwnerTabLinks> {
    const found: Opened | undefined = open
      ? await this.#open()
      : await this.#shownNow().then((shown) =>
          shown === undefined ? undefined : { shown, opened: false, replaced: false },
        );

    if (found === undefined) throw new Error(OWNER_TAB_GONE);

    const {
      shown: { id, tab },
      opened,
      replaced,
    } = found;

    let transport: CdpTransport;

    try {
      transport = await this.#browser.connect(tab.browserSessionId);
    } catch (error) {
      if (error instanceof BrowserGoneError) throw new Error(OWNER_TAB_GONE, { cause: error });

      throw error;
    }

    try {
      // A page that cannot reach its opener is an Owner tab of its own (or will be, once the list looks), not a window.
      const links = await mintViewLinks(transport, tab, undefined, isTab);

      return { ownerTabId: id, ...links, opened, replaced };
    } catch (error) {
      // Browser Run says the tab is not there (it closed since the records were read). A window that closed is left
      // out of the links instead.
      if (isNoTarget(error)) throw new Error(OWNER_TAB_GONE, { cause: error });

      throw error;
    } finally {
      transport.close();
    }
  }
}
