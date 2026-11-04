// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live). Which View holds the keyboard
// focus: the one whose frame is the document's active element. Focus moving into a frame from the page blurs the window, but
// from one frame straight to another nothing is fired at the page, so while a frame holds the focus the active element is also
// read on a short poll (and on `focusin`, which the page's own elements do fire). One watch serves every frame.
// @effect-diagnostics globalTimers:off preferEffectArray:off missingPipeableSignature:off -- DOM events and a native poll over a small set of listeners.

/** How often the active element is read while a frame holds the focus. */
export const POLL_MS = 250;

type Listener = (active: Element | null) => void;

export class FocusWatch {
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
  ) {}

  /** Be told the active element at each change of focus the watch sees; the returned function stops it. */
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);

    if (this.listeners.size === 1) this.start();

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size === 0) this.stop();
    };
  };

  private readonly check = (): void => {
    const active = this.doc.activeElement;

    for (const listener of this.listeners) listener(active);

    // A poll runs only while a frame has the focus: otherwise the window's own events say when it gets one.
    if (active instanceof HTMLIFrameElement) this.poll();
    else this.unpoll();
  };

  private poll(): void {
    this.timer ??= setInterval(this.check, POLL_MS);
  }

  private unpoll(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private start(): void {
    this.win.addEventListener("blur", this.check);
    this.win.addEventListener("focus", this.check);
    this.doc.addEventListener("focusin", this.check);
  }

  private stop(): void {
    this.win.removeEventListener("blur", this.check);
    this.win.removeEventListener("focus", this.check);
    this.doc.removeEventListener("focusin", this.check);
    this.unpoll();
  }
}

let shared: FocusWatch | undefined;

/** The page's watch, made when the first View asks. */
export const focusWatch = (): FocusWatch => (shared ??= new FocusWatch(document, window));
