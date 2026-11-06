// docs/architecture/mcp-apps.md → App Views in the transcript (Teardown, Remounting). `ui/resource-teardown` is sent and
// awaited, at most 2 s, before any unmount. A place that ends a View itself (its card, `AppFrame`'s `closing`) keeps the
// frame until the View has answered. An unmount that React drives removes the iframe in the same commit, which ends its
// View at once; so what is about to cause one (the owner leaving the page, closing a subagent's card or a Pane, switching
// the Session branch) asks the Views that will go to tear down first, and only then does it. Every mounted frame is
// registered here for that.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a small registry over a native set.
import type { AppPlace } from "../sandbox-frame/places.ts";

/** Every View on the page: a page change or a reload ends them all. */
export const EVERY_VIEW = "every-view";

/** What an unmount takes with it: the Views inside an element, none (the element is not there), or all of them. */
export type Within = Element | null | typeof EVERY_VIEW;

/** A mounted View's frame, as the page can ask it to end. */
export interface ViewHandle {
  readonly callId: string;
  /** Where it is shown. */
  readonly place: AppPlace;
  /** The frame's element, when it has one (a failed View has none). */
  readonly element: () => HTMLElement | null;
  /** Tear the View down: `ui/resource-teardown`, answered or 2 s. The caller removes the frame; the dead one stays until then. */
  readonly retire: () => Promise<void>;
  /** Make a frame again for a View that was retired and is not going after all: its place mounts a new one. */
  readonly restart: () => void;
}

export class ViewRegistry {
  private readonly handles = new Set<ViewHandle>();

  /** Register a mounted frame; the returned function takes it out when it unmounts. */
  readonly register = (handle: ViewHandle): (() => void) => {
    this.handles.add(handle);

    return () => {
      this.handles.delete(handle);
    };
  };

  /** Whether any View is mounted: a page with none has nothing to wait for. */
  readonly any = (): boolean => this.handles.size > 0;

  /** The mounted Views `keep` accepts. */
  readonly select = (keep: (handle: ViewHandle) => boolean): ReadonlyArray<ViewHandle> =>
    [...this.handles].filter(keep);

  /** The mounted Views inside `within`: no element is no place, so nothing is inside it. */
  readonly inside = (within: Within): ReadonlyArray<ViewHandle> =>
    this.select((handle) => {
      if (within === EVERY_VIEW) return true;

      if (within === null) return false;

      const element = handle.element();

      return element !== null && within.contains(element);
    });

  /**
   * Tear down the Views inside `within` at once, and resolve when each has answered or 2 s have passed. The frames are asked
   * together, so the wait is the slowest View's, not their sum.
   */
  readonly tearDown = (within: Within): Promise<void> => retireAll(this.inside(within));
}

const retireAll = (handles: ReadonlyArray<ViewHandle>): Promise<void> =>
  Promise.all(handles.map((handle) => handle.retire())).then(() => undefined);

/** The registry of this page's mounted Views. */
export const appViews = new ViewRegistry();

/**
 * Run `action` once the Views inside `within` have torn down (at once when there are none): the owner's own action that
 * unmounts them. A second ask while the first waits does the same, and `action` runs for each.
 */
export const afterTeardown = (
  action: () => void,
  within: Within,
  registry: ViewRegistry = appViews,
): void => {
  if (registry.inside(within).length === 0) {
    action();

    return;
  }

  void registry.tearDown(within).then(action, action);
};

/**
 * Run `action`, a move of the active Session branch, once the Views of the calls the branch drops have torn down. The
 * move unmounts those (their messages are gone), so they are asked first; a View the branch keeps is not touched, since the
 * transcript keeps its messages mounted and it is never reloaded, and an App Pane's View stays where it is. `action`
 * answers whether the move happened: when it did not, the Views that were torn down are made again.
 */
export const afterBranchTeardown = (
  dropped: ReadonlySet<string>,
  action: () => Promise<boolean>,
  registry: ViewRegistry = appViews,
): void => {
  const going = registry.select(
    (handle) => handle.place !== "app-pane" && dropped.has(handle.callId),
  );

  if (going.length === 0) {
    void action();

    return;
  }

  const restart = () => {
    for (const handle of going) handle.restart();
  };

  void retireAll(going)
    .then(action)
    .then((moved) => {
      if (!moved) restart();
    }, restart);
};

/** The tab panel of the Pane `key`, which the Pane area marks (`pane-area.tsx`): what closing it waits on. */
export const paneElement = (key: string): Element | null =>
  Array.from(document.querySelectorAll("[role='tabpanel'][data-pane]")).find(
    (element) => element.getAttribute("data-pane") === key,
  ) ?? null;
