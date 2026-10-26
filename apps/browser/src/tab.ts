// @effect-diagnostics globalDate:off asyncFunction:off preferEffectArray:off missingPipeableSignature:off schemaSync:off preferTypedSchemaDecoder:off
// The tab an `agents/browser` scope works in, as `agents/browser` has stored it: a conversation's, for a Browser Handoff
// (`./handoff.ts`), and an Owner tab's, for the Browser Pane (`./owner-tabs.ts`); and opening an Owner tab, recording a
// page a tab opened as one, and forgetting one that is gone.
import {
  type Browser,
  type BrowserBinding,
  type BrowserSessionStore,
  BrowserRenderingError,
  listBrowserTargets,
} from "agents/browser";
import * as Schema from "effect/Schema";

/** What `Target.createTarget` answers: the new page's target; any other field is ignored. */
const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ targetId: Schema.String }));

/** The part of a `Browser` the lookup reads: its name, its store, and Browser Run. */
export type TabLookup = {
  readonly name: string;
  readonly store: Pick<BrowserSessionStore, "get">;
  readonly binding: BrowserBinding;
};

/** A scope's tab: the Browser Run session it is in and its CDP target. */
export type Tab = { readonly browserSessionId: string; readonly targetId: string };

/** The scope `agents/browser/pi`'s `browserTool` gives conversation `conversationId` (its `scope` option's default). */
export const conversationScope = (conversationId: number): string =>
  `conversation:${conversationId}`;

/**
 * The store keys `agents/browser` keeps a browser and a scope under. They are private to the package
 * (`namedBrowserSessionKey` and `browserScopeKeyPrefix`, in `agents` 0.28.1, the version pinned in `package.json`), so
 * `tab.test.ts` creates the records through a real `Browser` and fails when an upgrade changes them: check it, and these
 * two functions and `scopesLockKey` (the lock key, `browserScopeKeyPrefix` too), whenever `agents` is upgraded.
 */
export const browserKey = (name: string): string => `browser:session:${name}`;

export const scopeKey = (name: string, scope: string): string =>
  `browser:scope:${name.length}:${name}:${scope}`;

/** The lock `agents/browser` writes every scope record of browser `name` under: their keys' prefix (private too). */
const scopesLockKey = (name: string): string => scopeKey(name, "");

/**
 * Where a scope's tab stands: open in the browser that runs; `closed` (the browser that runs is the one the scope's record
 * names, and the tab is not among its pages); or `replaced` (the scope's browser is closed, replaced or gone from Browser
 * Run, or the scope has no record: whatever the tab showed went with it).
 */
export type TabState =
  | { readonly state: "open"; readonly tab: Tab }
  | { readonly state: "closed" }
  | { readonly state: "replaced" };

/**
 * Where each of scopes `scopes`' tab stands (`TabState`). `agents/browser` keeps each in the scope's record beside the
 * browser's own record, and both are read as they are stored: `Browser.connect` would create a browser for a scope that
 * has none and move a stale scope record to it, and neither a handoff nor a Pane asking again may change either. Browser
 * Run is asked for its pages once, however many scopes.
 */
export const tabStatesIn = async (
  { name, store, binding }: TabLookup,
  scopes: ReadonlyArray<string>,
): Promise<Map<string, TabState>> => {
  const states = new Map<string, TabState>();
  const browser = await store.get(browserKey(name));
  const replaced: TabState = { state: "replaced" };

  if (browser === undefined || browser.closedAt !== undefined) {
    for (const scope of scopes) states.set(scope, replaced);

    return states;
  }

  const candidates: Array<readonly [string, Tab]> = [];

  for (const scope of scopes) {
    const record = await store.get(scopeKey(name, scope));

    // The scope's record names the browser it last worked in: one that was replaced since has no tab there.
    if (record?.sessionId === browser.sessionId && record.activeTargetId !== undefined) {
      candidates.push([
        scope,
        { browserSessionId: browser.sessionId, targetId: record.activeTargetId },
      ]);
    } else {
      states.set(scope, replaced);
    }
  }

  if (candidates.length === 0) return states;

  try {
    const targets = await listBrowserTargets(binding, browser.sessionId);

    for (const [scope, tab] of candidates) {
      states.set(
        scope,
        targets.some((target) => target.id === tab.targetId)
          ? { state: "open", tab }
          : { state: "closed" },
      );
    }

    return states;
  } catch (error) {
    // Browser Run no longer has the browser; any other failure is not an answer.
    if (error instanceof BrowserRenderingError && (error.status === 404 || error.status === 410)) {
      return new Map(scopes.map((scope) => [scope, replaced]));
    }

    throw error;
  }
};

/** The tabs scopes `scopes` work in, those that are open in the browser that runs (`tabStatesIn`). */
export const tabsIn = async (
  lookup: TabLookup,
  scopes: ReadonlyArray<string>,
): Promise<Map<string, Tab>> => {
  const found = new Map<string, Tab>();

  for (const [scope, tab] of await tabStatesIn(lookup, scopes)) {
    if (tab.state === "open") found.set(scope, tab.tab);
  }

  return found;
};

/** The tab scope `scope` works in, if its browser is still there (`tabsIn`). */
export const tabIn = async (lookup: TabLookup, scope: string): Promise<Tab | undefined> =>
  (await tabsIn(lookup, [scope])).get(scope);

/** The tab conversation `conversationId` works in, if its browser is still there (`tabIn`). */
export const tabOf = (lookup: TabLookup, conversationId: number): Promise<Tab | undefined> =>
  tabIn(lookup, conversationScope(conversationId));

/**
 * Open a tab for scope `scope` (blank, or at `url`) and record it as the scope's tab. `Browser.connect` reattaches to the
 * browser that runs and starts one only when none does (or it is gone), so this never starts a second browser.
 */
export const openTab = async (
  browser: Pick<Browser, "connect">,
  scope: string,
  url = "about:blank",
): Promise<Tab> => {
  const connection = await browser.connect({ scope });

  try {
    const { targetId } = decodeCreated(await connection.cdp.send("Target.createTarget", { url }), {
      onExcessProperty: "ignore",
    });

    // False when the browser was closed or replaced meanwhile: the tab is not where the record would say.
    if (!(await connection.setActiveTarget(targetId))) {
      throw new Error("The browser was closed while the tab opened");
    }

    return { browserSessionId: connection.sessionId, targetId };
  } finally {
    connection.cdp.disconnect();
  }
};

/**
 * Record page `targetId`, which a page of browser session `browserSessionId` opened, as scope `scope`'s tab: the scope's
 * record then names the tab and the browser it is in, as for a tab `openTab` made. It starts no browser, which
 * `Browser.connect` would when the browser has closed since: the records are checked and written under the lock
 * `agents/browser` writes scope records under, and fail when the browser is closed or is not `browserSessionId` any
 * more. (The record's shape is `agents/browser`'s private one, like its keys: `tab.test.ts` reads it back through a real
 * `Browser`.)
 */
export const adoptTab = async (
  {
    name,
    store,
  }: {
    readonly name: string;
    readonly store: Pick<BrowserSessionStore, "acquireLock" | "get" | "set">;
  },
  scope: string,
  targetId: string,
  browserSessionId: string,
): Promise<Tab> => {
  const lock = await store.acquireLock(scopesLockKey(name));

  try {
    const browser = await store.get(browserKey(name));

    if (
      browser === undefined ||
      browser.closedAt !== undefined ||
      browser.sessionId !== browserSessionId
    ) {
      throw new Error("The browser was closed while the tab was recorded");
    }

    const now = Date.now();

    await store.set(scopeKey(name, scope), {
      sessionId: browserSessionId,
      createdAt: now,
      updatedAt: now,
      activeTargetId: targetId,
    });

    return { browserSessionId, targetId };
  } finally {
    await lock.release();
  }
};

/**
 * Delete scope `scope`'s record, under the lock `agents/browser` writes scope records under: for a scope that is done
 * with (an Owner tab that is gone), so it does not count against `MAX_BROWSER_SCOPES`. Its tab, if still open, is left.
 */
export const forgetScope = async (
  {
    name,
    store,
  }: { readonly name: string; readonly store: Pick<BrowserSessionStore, "acquireLock" | "delete"> },
  scope: string,
): Promise<void> => {
  const lock = await store.acquireLock(scopesLockKey(name));

  try {
    await store.delete(scopeKey(name, scope));
  } finally {
    await lock.release();
  }
};
