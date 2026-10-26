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
// one; `view(true)` shows another and says the one shown before is gone (`replaced`). The tab strip (several Owner
// tabs), keeping them across a new browser, and the agent in them come later; the list is here so they have somewhere
// to go.
import { OWNER_TAB_GONE, type OwnerTabLinks } from "@cloudpid/extensions/browser/contract";
import { BrowserGoneError, type CdpTransport, isNoTarget, mintViewLinks } from "./cdp.ts";
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

const EMPTY: OwnerTabList = { tabs: [] };

/** The tab shown, found: its `id` and where it is. */
type Shown = { readonly id: string; readonly tab: Tab };

/** The tab an ask with `open` shows, and what it did to show it (`OwnerTabLinks`' `opened` and `replaced`). */
type Opened = { readonly shown: Shown; readonly opened: boolean; readonly replaced: boolean };

export class OwnerTabs {
  readonly #records: OwnerTabRecords;
  readonly #browser: OwnerTabsBrowser;
  readonly #newId: () => string;
  /** Opening in flight, so that two Panes opening at once open one Owner tab. */
  #opening: Promise<Opened> | undefined;

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
   * the browser that runs, or a new one) and shown. The ones that are gone leave the list, and their scope records go.
   */
  #open(): Promise<Opened> {
    this.#opening ??= (async (): Promise<Opened> => {
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
    })().finally(() => {
      this.#opening = undefined;
    });

    return this.#opening;
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
      : await this.#shown().then((shown) =>
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
      return { ownerTabId: id, ...(await mintViewLinks(transport, tab)), opened, replaced };
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
