// @effect-diagnostics preferEffectArray:off -- two fingers at most in a native map.

// The Live View frame's pointer events (#154): a finger, a pen or a mouse on the canvas, as `input.ts` samples, sent
// to the tab; the long press's timer; a mouse's click count; the wheel; and the Desktop layout's two-finger pan and
// zoom, done here and never sent. What a gesture means beyond its input (the keyboard, the edit menu, a local picker)
// is the screen's, told through `PointerHost.ended`.

import type { CdpCommand, Point } from "./cdp.ts";
import type { FrameView } from "./frame-view.ts";
import { LONG_PRESS_MS, PointerInput, type Gesture, type PointerSample } from "./input.ts";
import { modifiersOf, type Listeners } from "./screen-dom.ts";
import type { TimerGroup } from "./timers.ts";
import { pinch, type PinchStart } from "./viewport.ts";

/** The Desktop layout's local zoom, relative to the frame fitted inside the Pane. */
const ZOOM_LIMITS = { min: 1, max: 4 };

/** How close in time and place two mouse presses are to count as a double click, in ms and px. */
const CLICK_MS = 500;
const CLICK_SLOP = 4;

/** What the pointer controller asks of the screen. */
export interface PointerHost {
  readonly send: (commands: readonly CdpCommand[]) => void;
  /** Whether the Desktop layout is on: two fingers pan and zoom the frame here. */
  readonly desktop: () => boolean;
  /** A pointer went down on the frame (`primary`: a new gesture): what was shown over the frame goes. */
  readonly touched: (primary: boolean) => void;
  /** A long press began selecting in the tab. */
  readonly selecting: () => void;
  /** Whether a tap at `point` (in the tab) lands on a native picker, which opens locally instead. */
  readonly pickerAt: (point: Point) => boolean;
  /** A gesture ended, with its last pointer. */
  readonly ended: (gesture: Gesture) => void;
}

export class PointerController {
  private readonly input = new PointerInput();
  private readonly fingers = new Map<number, Point>();
  private pinching: PinchStart | undefined;
  private cancelPress: () => void = () => undefined;
  private lastPress: { readonly time: number; readonly at: Point; count: number } | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLDivElement,
    private readonly frame: FrameView,
    private readonly timers: TimerGroup,
    private readonly host: PointerHost,
    listeners: Listeners,
  ) {
    listeners.on(canvas, "contextmenu", (event) => {
      event.preventDefault();
    });
    // Touching the frame must not move focus (blurring the textarea closes the keyboard) or make mouse events.
    listeners.on(canvas, "touchstart", (event) => event.preventDefault(), { passive: false });
    listeners.on(canvas, "touchend", (event) => event.preventDefault(), { passive: false });
    listeners.on(canvas, "mousedown", (event) => {
      event.preventDefault();
    });
    listeners.on(canvas, "pointerdown", (event) => {
      this.down(event);
    });
    listeners.on(canvas, "pointermove", (event) => {
      this.move(event);
    });
    listeners.on(canvas, "pointerup", (event) => {
      this.up(event, false);
    });
    listeners.on(canvas, "pointercancel", (event) => {
      this.up(event, true);
    });
    listeners.on(
      canvas,
      "wheel",
      (event) => {
        event.preventDefault();
        this.host.touched(false);
        this.host.send(this.input.wheel(this.wheelSample(event), event.deltaX, event.deltaY));
      },
      { passive: false },
    );
  }

  /** The Desktop layout went on or off: back to the frame fitted inside the Pane. */
  resetZoom(): void {
    this.frame.zoom = 1;
    this.pinching = undefined;
    this.container.scrollTo(0, 0);
  }

  private sample(event: PointerEvent, detail = 1): PointerSample {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType === "mouse" ? "mouse" : "touch",
      isPrimary: event.isPrimary,
      buttons: event.buttons,
      button: event.button,
      detail,
      client: { x: event.clientX, y: event.clientY },
      page: this.frame.toPage(event.clientX, event.clientY),
      time: event.timeStamp,
      modifiers: modifiersOf(event),
    };
  }

  /** The wheel, as a sample of the mouse where it is. */
  private wheelSample(event: WheelEvent): PointerSample {
    return {
      pointerId: 0,
      pointerType: "mouse",
      isPrimary: true,
      buttons: event.buttons,
      button: 0,
      detail: 0,
      client: { x: event.clientX, y: event.clientY },
      page: this.frame.toPage(event.clientX, event.clientY),
      time: event.timeStamp,
      modifiers: modifiersOf(event),
    };
  }

  /** A mouse press's click count: two presses close in time and place make a double click. */
  private clickCount(event: PointerEvent): number {
    const at = { x: event.clientX, y: event.clientY };
    const last = this.lastPress;

    if (
      last !== undefined &&
      event.timeStamp - last.time < CLICK_MS &&
      Math.hypot(at.x - last.at.x, at.y - last.at.y) < CLICK_SLOP
    ) {
      this.lastPress = { time: event.timeStamp, at, count: last.count + 1 };
    } else {
      this.lastPress = { time: event.timeStamp, at, count: 1 };
    }

    return this.lastPress.count;
  }

  /** Where a finger is, in the frame container's visible area. */
  private containerPoint(event: PointerEvent): Point {
    const rect = this.container.getBoundingClientRect();

    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private down(event: PointerEvent): void {
    event.preventDefault();
    this.host.touched(event.isPrimary);
    this.canvas.setPointerCapture(event.pointerId);

    if (event.pointerType === "mouse") {
      // The keys of a desktop go to the frame's container.
      this.container.focus({ preventScroll: true });
      this.host.send(this.input.down(this.sample(event, this.clickCount(event))));

      return;
    }

    this.fingers.set(event.pointerId, this.containerPoint(event));

    // Two fingers in the Desktop layout pan and zoom the frame here; the tab does not get them.
    if (this.host.desktop() && this.fingers.size >= 2) {
      this.host.send(this.input.abandon());
      this.cancelPress();

      const [a, b] = Array.from(this.fingers.values());

      if (a !== undefined && b !== undefined) {
        this.pinching = {
          a,
          b,
          zoom: this.frame.zoom,
          scroll: { x: this.container.scrollLeft, y: this.container.scrollTop },
        };
      }

      return;
    }

    if (this.pinching !== undefined) return;

    this.host.send(this.input.down(this.sample(event)));

    const pointerId = event.pointerId;

    this.cancelPress();
    this.cancelPress = this.timers.after(LONG_PRESS_MS, () => {
      const commands = this.input.held(pointerId);

      if (commands.length > 0) this.host.selecting();

      this.host.send(commands);
    });
  }

  private move(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && this.fingers.has(event.pointerId)) {
      this.fingers.set(event.pointerId, this.containerPoint(event));
    }

    if (this.pinching !== undefined) {
      const [a, b] = Array.from(this.fingers.values());

      if (a === undefined || b === undefined) return;

      const next = pinch(this.pinching, a, b, ZOOM_LIMITS);

      this.frame.zoom = next.zoom;
      this.frame.paint();
      this.container.scrollTo(next.scroll.x, next.scroll.y);

      return;
    }

    this.host.send(this.input.move(this.sample(event)));
  }

  private up(event: PointerEvent, cancelled: boolean): void {
    this.fingers.delete(event.pointerId);

    if (this.pinching !== undefined) {
      if (this.fingers.size === 0) this.pinching = undefined;

      return;
    }

    this.cancelPress();

    const detail = event.pointerType === "mouse" ? (this.lastPress?.count ?? 1) : 1;
    const sample = this.sample(event, detail);

    if (cancelled) {
      this.host.send(this.input.cancel(sample).commands);

      return;
    }

    const release = this.input.up(sample, this.host.pickerAt);

    this.host.send(release.commands);

    if (release.gesture !== undefined) this.host.ended(release.gesture);
  }
}
