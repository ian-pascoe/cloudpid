// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
// The tab a conversation works in, as `agents/browser` has stored it, for a Browser Handoff (`./handoff.ts`).
import {
  type BrowserBinding,
  type BrowserSessionStore,
  BrowserRenderingError,
  listBrowserTargets,
} from "agents/browser";

/** The part of a `Browser` the lookup reads: its name, its store, and Browser Run. */
export type TabLookup = {
  readonly name: string;
  readonly store: Pick<BrowserSessionStore, "get">;
  readonly binding: BrowserBinding;
};

/** A conversation's tab: the Browser Run session it is in and its CDP target. */
export type Tab = { readonly browserSessionId: string; readonly targetId: string };

/**
 * The store keys `agents/browser` keeps a browser and a conversation's scope under. They are private to the package
 * (`namedBrowserSessionKey` and `browserScopeKeyPrefix`, in `agents` 0.28.1, the version pinned in `package.json`), so
 * `tab.test.ts` creates the records through a real `Browser` and fails when an upgrade changes them: check it, and these
 * two functions, whenever `agents` is upgraded.
 */
export const browserKey = (name: string): string => `browser:session:${name}`;

export const scopeKey = (name: string, conversationId: number): string =>
  `browser:scope:${name.length}:${name}:conversation:${conversationId}`;

/**
 * The tab conversation `conversationId` works in, if its browser is still there. The `browserTool` keeps it in the
 * conversation's scope record (`conversation:<id>`, the `scope` option's default) beside the browser's own record, and
 * both are read as they are stored: `Browser.connect` would create a browser for a conversation that has none and move
 * a stale scope record to it, and a handoff must change neither.
 */
export const tabOf = async (
  { name, store, binding }: TabLookup,
  conversationId: number,
): Promise<Tab | undefined> => {
  const browser = await store.get(browserKey(name));
  const scope = await store.get(scopeKey(name, conversationId));

  // The scope's record names the browser it last worked in: one that was replaced since has no tab to hand over.
  if (
    browser === undefined ||
    browser.closedAt !== undefined ||
    scope?.sessionId !== browser.sessionId ||
    scope.activeTargetId === undefined
  ) {
    return undefined;
  }

  const { activeTargetId } = scope;

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
