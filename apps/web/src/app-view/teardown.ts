// docs/architecture/mcp-apps.md → App Views in the transcript (Teardown, Remounting). `ui/resource-teardown` is sent and
// awaited, at most 2 s, before any unmount. A place that ends a View itself (its card, `AppFrame`'s `closing`) keeps the
// frame until the View has answered. An unmount that React drives removes the iframe in the same commit, which ends its
// View at once; so what is about to cause one (the owner leaving the page, closing a subagent's card or a Pane, switching
// the Session branch) asks the Views that will go to tear down first, and only then does it. Every mounted frame is
// registered here for that.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a small registry over a native set.

/** A mounted View's frame, as the page can ask it to end. */
export interface ViewHandle {
  readonly callId: string;
  /** The frame's element, when it has one (a failed View has none). */
  readonly element: () => HTMLElement | null;
  /**
   * Tear the View down: `ui/resource-teardown`, answered or 2 s. With `restart` the frame is made again afterwards, for a
   * place that stays; without it the caller removes the frame, and the dead one stays until then.
   */
  readonly retire: (restart: boolean) => Promise<void>;
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

  /**
   * Tear down the Views of every frame inside `within` (all of them without it) at once, and resolve when each has
   * answered or 2 s have passed. The frames are asked together, so the wait is the slowest View's, not their sum.
   */
  readonly tearDown = (within?: Element | null, restart = false): Promise<void> => {
    const inside = [...this.handles].filter((handle) => {
      if (within === undefined || within === null) return true;

      const element = handle.element();

      return element !== null && within.contains(element);
    });

    return Promise.all(inside.map((handle) => handle.retire(restart))).then(() => undefined);
  };
}

/** The registry of this page's mounted Views. */
export const appViews = new ViewRegistry();

/**
 * Run `action` once the Views inside `within` have torn down (at once when there are none): the owner's own action that
 * unmounts them. A second ask while the first waits does the same, and `action` runs for each.
 */
export const afterTeardown = (
  action: () => void,
  within?: Element | null,
  restart = false,
): void => {
  if (!appViews.any()) {
    action();

    return;
  }

  void appViews.tearDown(within, restart).then(action, action);
};

/** The element of the App Pane that shows call `callId`'s View (`app-pane.tsx` marks it), for what closes it to wait on. */
export const appPaneElement = (callId: string): Element | null =>
  Array.from(document.querySelectorAll("[data-app-pane]")).find(
    (element) => element.getAttribute("data-app-pane") === callId,
  ) ?? null;
