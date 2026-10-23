// The Live View's screen (#154): the DOM around one connection, from when the Pane has its elements until it unmounts.
//
// Why an imperative controller and not atoms (ADR-0011): this is gesture wiring on a canvas and an invisible textarea.
// iOS opens the keyboard, a native picker or the clipboard only from inside the event handler of the touch that asked
// for it, synchronously; frames are drawn as they decode, many times a second; pointer moves are sent at frame rate.
// None of that may wait for a render. So the state here is the gesture's own (fingers, a long press, the frame drawn,
// the field map last read) and lives as long as the DOM it wires. What the rest of the Pane renders comes from atoms:
// the Live View's state, and the Desktop layout flag, which this reads from its atom (`desktop`) and never copies.
//
// Each concern is its own controller: `frame-view.ts` draws the frames and maps points, `pointer-controller.ts` sends
// the pointer, `keys-controller.ts` the keys, `edit-menu-controller.ts` the edit menu and the clipboard, and
// `picker-controller.ts` the local pickers. This module ties them together: the keyboard at the end of a tap, the
// field map, the tab's viewport for the Pane's size, and the check when the page comes back. The decisions live in
// the plain modules they use (`input.ts`, `keyboard.ts`, `field-map.ts`, `edit-menu.ts`, `pickers.ts`,
// `viewport.ts`); every effect runs in the Live View's scope (`LiveView.run`), and every timer in one `TimerGroup`, so
// none outlives the Pane.

import type { Point } from "./cdp.ts";
import type { LiveView } from "./connection.ts";
import { EditMenuController } from "./edit-menu-controller.ts";
import {
  EMPTY_FIELD_MAP,
  FIELD_MAP_SCRIPT,
  FOCUSED_SCRIPT,
  FieldMapReading,
  FocusedElement,
  hitTest,
  type Field,
  type FieldMap,
} from "./field-map.ts";
import { FrameView } from "./frame-view.ts";
import type { Gesture } from "./input.ts";
import { Keyboard } from "./keyboard.ts";
import { KeysController } from "./keys-controller.ts";
import { PickerController } from "./picker-controller.ts";
import { PointerController } from "./pointer-controller.ts";
import { Listeners, tabOf, typingTextarea, type ScreenElements, type Tab } from "./screen-dom.ts";
import { browserTimers, TimerGroup, Throttle, type Timers } from "./timers.ts";
import { deviceMetrics, screencastSize } from "./viewport.ts";

export type { ScreenElements } from "./screen-dom.ts";

/** How often the field map is read while the Live View is open, and at most how often, in ms. */
const MAP_INTERVAL_MS = 1000;
const MAP_THROTTLE_MS = 250;

/** How long after a tap the tab is asked what it focused, in ms. */
const AFTER_TAP_MS = 250;

/** How long a resize settles before the tab is sized again, in ms. */
const RESIZE_DEBOUNCE_MS = 150;

/** How long after a long-press selection ends the edit menu is asked for, in ms: the tab's release lands first. */
const AFTER_SELECT_MS = 200;

/** A value the screen reads and follows: an atom, through the Pane's registry. */
export interface Followed<A> {
  readonly get: () => A;
  /** Hear each new value; returns how to stop. */
  readonly subscribe: (listener: (value: A) => void) => () => void;
}

export class LiveViewScreen {
  private readonly listeners = new Listeners();
  private readonly timers: TimerGroup;
  private readonly tab: Tab;
  private readonly keyboard: Keyboard;
  private readonly frame: FrameView;
  private readonly pointer: PointerController;
  private readonly menu: EditMenuController;
  private readonly pickers: PickerController;
  private readonly keys: KeysController;
  private readonly map: Throttle;
  private readonly touch: boolean;
  private fields: FieldMap = EMPTY_FIELD_MAP;
  private mapReading = false;
  private cancelResize: () => void = () => undefined;
  /** The field a tap that landed on a native picker was for: opened locally once the tap ends. */
  private pickerHit: Field | undefined;
  private disposed = false;

  constructor(
    private readonly elements: ScreenElements,
    private readonly view: LiveView,
    /** Whether the Desktop layout is on: its atom. */
    private readonly desktop: Followed<boolean>,
    options: { readonly touch: boolean; readonly timers?: Timers },
  ) {
    const { listeners } = this;

    this.touch = options.touch;
    this.timers = new TimerGroup(options.timers ?? browserTimers);
    this.tab = tabOf(view);
    this.keyboard = new Keyboard(typingTextarea(elements.textarea));
    this.map = new Throttle(this.timers, MAP_THROTTLE_MS, () => {
      this.readMap();
    });

    const changed = () => {
      this.map.schedule();
    };

    this.frame = new FrameView(elements.canvas, elements.container, () => {
      changed();
      // A local picker or the menu no longer covers its element once the tab scrolls.
      this.pickers.close();
      this.menu.hide();
    });
    this.menu = new EditMenuController(
      elements.menu,
      elements.pasteBox,
      elements.pasteField,
      this.frame,
      this.keyboard,
      this.tab,
      this.timers,
      changed,
      listeners,
    );
    this.pickers = new PickerController(
      elements.pickSelect,
      elements.pickInput,
      this.frame,
      this.keyboard,
      this.tab,
      this.timers,
      changed,
      listeners,
    );
    this.pointer = new PointerController(
      elements.canvas,
      elements.container,
      this.frame,
      this.timers,
      {
        send: this.tab.send,
        desktop: desktop.get,
        touched: (primary) => {
          // The frame's preventDefault keeps a local picker focused: close it here instead.
          if (primary) this.pickers.close();

          this.menu.touched();
        },
        selecting: () => {
          this.menu.hide();
        },
        pickerAt: (point) => {
          this.pickerHit = this.hit(point);

          return this.pickerHit?.picker !== undefined;
        },
        ended: (gesture) => {
          this.gestureEnded(gesture);
        },
      },
      listeners,
    );
    this.keys = new KeysController(
      elements.container,
      elements.textarea,
      this.keyboard,
      this.tab,
      this.timers,
      () => {
        this.menu.hide();
      },
      changed,
      listeners,
    );

    listeners.add(view.frames((frame) => this.frame.show(frame)));
    listeners.add(
      desktop.subscribe(() => {
        this.pointer.resetZoom();
        this.applyViewport();
      }),
    );

    const observer = new ResizeObserver(() => {
      this.resized();
    });

    observer.observe(elements.container);
    listeners.add(() => {
      observer.disconnect();
    });

    // Back from the background: iOS may have killed the sockets without a word.
    const returned = () => {
      if (document.visibilityState === "visible") this.tab.run(this.view.returned);
    };

    listeners.onDocument("visibilitychange", returned);
    listeners.onWindow("pageshow", returned);
    listeners.onWindow("pagehide", () => {
      this.view.clearViewport();
    });

    this.resized();
    this.timers.every(MAP_INTERVAL_MS, changed);
    this.map.runNow();
  }

  /** Open the keyboard by hand (the ⌨︎ button), in its tap. */
  forceKeyboard(): void {
    this.attention(false);
    this.keyboard.force(undefined);
    void this.tab.evaluate(FOCUSED_SCRIPT, FocusedElement).then((focused) => {
      if (focused?.editable === true) this.keyboard.check(focused);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.keyboard.close();
    this.pickers.close();
    this.menu.hide();
    this.timers.dispose();
    this.frame.dispose();
    this.listeners.dispose();
  }

  // ---- the viewport ----------------------------------------------------------------------------

  private resized(): void {
    this.cancelResize();
    this.cancelResize = this.timers.after(RESIZE_DEBOUNCE_MS, () => {
      this.applyViewport();
    });
  }

  /** Size the tab to the Pane (or the Desktop layout), and the frame to fit it. */
  private applyViewport(): void {
    const { container } = this.elements;

    if (container.clientWidth === 0 || container.clientHeight === 0) return;

    const dpr = devicePixelRatio;

    const metrics = deviceMetrics(
      { width: container.clientWidth, height: container.clientHeight, dpr, touch: this.touch },
      this.desktop.get(),
    );

    this.tab.run(this.view.resize(metrics, screencastSize(metrics.metrics, dpr)));
    this.frame.paint();
  }

  // ---- the field map ---------------------------------------------------------------------------

  private readMap(): void {
    if (this.mapReading || this.disposed) return;

    this.mapReading = true;
    void this.tab.evaluate(FIELD_MAP_SCRIPT, FieldMapReading).then((reading) => {
      this.mapReading = false;

      if (reading !== undefined) this.fields = { ...reading, at: this.timers.now() };
    });
  }

  private hit(point: Point): Field | undefined {
    const meta = this.frame.metadata();

    const scroll = {
      x: meta?.scrollOffsetX ?? this.fields.scrollX,
      y: meta?.scrollOffsetY ?? this.fields.scrollY,
    };

    return hitTest(this.fields, point, scroll);
  }

  // ---- gestures --------------------------------------------------------------------------------

  /** What a gesture does beyond its input: the keyboard, a local picker, the edit menu. */
  private gestureEnded(gesture: Gesture): void {
    if (gesture.picker) {
      if (this.pickerHit !== undefined) this.pickers.show(this.pickerHit);

      this.pickerHit = undefined;

      return;
    }

    this.pickerHit = undefined;
    this.map.schedule();

    // The keyboard and the edit menu are for touch screens; a desktop has its own keys and clipboard.
    if (gesture.pointerType === "mouse") return;

    const { kind, point } = gesture;

    if (kind === "tap") {
      // Decided now, inside the tap, so a focus opens the keyboard on iOS.
      const field = this.hit(point);

      this.keyboard.tap(field?.picker === undefined ? field : undefined);
      this.afterTap();

      if (gesture.double) void this.menu.doubleTap(point);

      return;
    }

    if (kind === "long-press") void this.menu.show(point);

    // The mouse release that ends the selection was sent with this release.
    if (kind === "select") this.menu.showAfter(point, AFTER_SELECT_MS);
  }

  /** The safety net after a tap: what the tab focused, against what the tap predicted. */
  private afterTap(): void {
    this.timers.after(AFTER_TAP_MS, () => {
      void this.tab.evaluate(FOCUSED_SCRIPT, FocusedElement).then((focused) => {
        if (focused === undefined) return;

        this.attention(this.keyboard.check(focused) === "attention");
      });
    });
  }

  private attention(on: boolean): void {
    const button = this.elements.keyboardButton;

    if (button === null) return;

    if (on) button.dataset.attention = "";
    else delete button.dataset.attention;
  }
}
