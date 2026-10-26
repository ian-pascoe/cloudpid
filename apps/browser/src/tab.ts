// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
// The tab an `agents/browser` scope works in, as `agents/browser` has stored it: a conversation's, for a Browser Handoff
// (`./handoff.ts`), and an Owner tab's, for the Browser Pane (`./owner-tabs.ts`); and opening an Owner tab.
import {
  type Browser,
  type BrowserBinding,
  type BrowserSessionStore,
  BrowserRenderingError,
  listBrowserTargets,
} from "agents/browser";
import * as Predicate from "effect/Predicate";

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
 * two functions, whenever `agents` is upgraded.
 */
export const browserKey = (name: string): string => `browser:session:${name}`;

export const scopeKey = (name: string, scope: string): string =>
  `browser:scope:${name.length}:${name}:${scope}`;

/**
 * The tab scope `scope` works in, if its browser is still there. `agents/browser` keeps it in the scope's record beside
 * the browser's own record, and both are read as they are stored: `Browser.connect` would create a browser for a scope
 * that has none and move a stale scope record to it, and neither a handoff nor a Pane asking again may change either.
 */
export const tabIn = async (
  { name, store, binding }: TabLookup,
  scope: string,
): Promise<Tab | undefined> => {
  const browser = await store.get(browserKey(name));
  const record = await store.get(scopeKey(name, scope));

  // The scope's record names the browser it last worked in: one that was replaced since has no tab there.
  if (
    browser === undefined ||
    browser.closedAt !== undefined ||
    record?.sessionId !== browser.sessionId ||
    record.activeTargetId === undefined
  ) {
    return undefined;
  }

  const { activeTargetId } = record;

  try {
    const targets = await listBrowserTargets(binding, browser.sessionId);

    return targets.some((target) => target.id === activeTargetId)
      ? { browserSessionId: browser.sessionId, targetId: activeTargetId }
      : undefined;
  } catch (error) {
    // Browser Run no longer has the browser; any other failure is not an answer.
    if (error instanceof BrowserRenderingError && (error.status === 404 || error.status === 410)) {
      return undefined;
    }

    throw error;
  }
};

/** The tab conversation `conversationId` works in, if its browser is still there (`tabIn`). */
export const tabOf = (lookup: TabLookup, conversationId: number): Promise<Tab | undefined> =>
  tabIn(lookup, conversationScope(conversationId));

/**
 * Open a blank tab for scope `scope` and record it as the scope's tab. `Browser.connect` reattaches to the browser that
 * runs and starts one only when none does (or it is gone), so this never starts a second browser.
 */
export const openTab = async (browser: Pick<Browser, "connect">, scope: string): Promise<Tab> => {
  const connection = await browser.connect({ scope });

  try {
    const created = await connection.cdp.send("Target.createTarget", { url: "about:blank" });

    const targetId =
      Predicate.isObject(created) && "targetId" in created && Predicate.isString(created.targetId)
        ? created.targetId
        : undefined;

    if (targetId === undefined) throw new Error("Browser Run opened no tab");

    // False when the browser was closed or replaced meanwhile: the tab is not where the record would say.
    if (!(await connection.setActiveTarget(targetId))) {
      throw new Error("The browser was closed while the tab opened");
    }

    return { browserSessionId: connection.sessionId, targetId };
  } finally {
    connection.cdp.disconnect();
  }
};
