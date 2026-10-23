// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- the fingers on the screen, a few at most, in a native map and arrays, and plain functions rather than combinators.

// The owner's pointer and keys, as CDP input for the tab (#154). Touches go as `Input.dispatchTouchEvent`, so the tab
// scrolls and taps as it would under a finger; a mouse goes as `Input.dispatchMouseEvent`, as the hosted Live View
// sends it. A long press becomes a mouse double press and the drag after it mouse moves, since Browser Run's headless
// Chrome makes no long-press gesture (and selects nothing) from touch events.
//
// Each release of the last pointer says what the gesture was, which is what decides the keyboard (only a tap may focus
// it: `keyboard.ts`), the edit menu, and a local picker. A tap is one pointer, under 500 ms and 10 CSS px.

import {
  keyCodeOf,
  keyPress,
  MODIFIER,
  type CdpCommand,
  type MouseButton,
  type Point,
  type TouchPoint,
} from "./cdp.ts";

/** One pointer event, as the Pane reads it from the DOM. */
export interface PointerSample {
  readonly pointerId: number;
  /** `mouse`, `touch` or `pen` (a pen goes as a touch). */
  readonly pointerType: string;
  readonly isPrimary: boolean;
  /** The buttons held, as the DOM's bit mask. */
  readonly buttons: number;
  /** The button that changed: 0 main, 1 middle, 2 secondary. */
  readonly button: number;
  /** A mouse's click count (the DOM's `detail`). */
  readonly detail: number;
  /** Where it is on our page, in CSS px. */
  readonly client: Point;
  /** Where it is in the tab's viewport, in CSS px. */
  readonly page: Point;
  /** When, in ms. */
  readonly time: number;
  /** CDP's modifier bits of the keys held. */
  readonly modifiers: number;
}

export type GestureKind = "tap" | "drag" | "long-press" | "multi-touch" | "select";

/** What a gesture was, said when its last pointer is released. */
export interface Gesture {
  readonly kind: GestureKind;
  /** Where it ended, in the tab's viewport. */
  readonly point: Point;
  readonly pointerType: string;
  /** A tap close to the last one and soon after it. */
  readonly double: boolean;
  /** A tap on a native picker, withheld from the tab: the Pane opens a local one. */
  readonly picker: boolean;
}

/** A release: what to send the tab, and what the gesture was when this was its last pointer. */
export interface Release {
  readonly commands: readonly CdpCommand[];
  readonly gesture?: Gesture;
}

/** How long a press is held before it is a long press, in ms. */
export const LONG_PRESS_MS = 500;

/** How far a tap may move, in CSS px. */
const TAP_SLOP = 10;

/** How close in time and place a second tap is to make a double tap, in ms and px. */
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_SLOP = 25;

/** The shortest gap between two moves sent, in ms: about a frame. */
const MOVE_INTERVAL_MS = 16;

interface Tracked {
  readonly start: number;
  readonly from: Point;
  readonly pointerType: string;
  moved: number;
  pointers: number;
  selecting: boolean;
}

/** A press that may become a long press. */
interface Press {
  readonly pointerId: number;
  readonly at: Point;
  selecting: boolean;
}

const isMouse = (sample: PointerSample): boolean => sample.pointerType === "mouse";

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const BUTTONS: ReadonlyMap<number, MouseButton> = new Map([
  [1, "middle"],
  [2, "right"],
]);

const buttonOf = (button: number): MouseButton => BUTTONS.get(button) ?? "left";

/** A mouse event of `type` at `point`, with the modifiers only when one is held. */
const mouseEvent = (
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
  point: Point,
  fields: {
    readonly button: MouseButton;
    readonly buttons?: number;
    readonly clickCount?: number;
    readonly deltaX?: number;
    readonly deltaY?: number;
  },
  modifiers = 0,
): CdpCommand => ({
  method: "Input.dispatchMouseEvent",
  params:
    modifiers === 0
      ? { type, x: point.x, y: point.y, ...fields }
      : { type, x: point.x, y: point.y, ...fields, modifiers },
});

const touchEvent = (
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  touchPoints: readonly TouchPoint[],
): CdpCommand => ({ method: "Input.dispatchTouchEvent", params: { type, touchPoints } });

/** The pointer input of one Live View: pointer events in, CDP commands and gestures out. */
export class PointerInput {
  private readonly touches = new Map<number, TouchPoint>();
  private gesture: Tracked | null = null;
  private press: Press | undefined;
  private lastTap: { readonly time: number; readonly point: Point } | undefined;
  private lastMove = Number.NEGATIVE_INFINITY;

  down(sample: PointerSample): readonly CdpCommand[] {
    const commands: CdpCommand[] = [];

    // A primary pointer starts a new gesture: drop whatever an earlier one left (a release that never came).
    if (sample.isPrimary && (this.gesture !== null || this.touches.size > 0)) {
      if (this.touches.size > 0) commands.push(touchEvent("touchCancel", []));

      this.touches.clear();
      this.gesture = null;
    }

    if (this.gesture === null) {
      this.gesture = {
        start: sample.time,
        from: sample.client,
        pointerType: sample.pointerType,
        moved: 0,
        pointers: 1,
        selecting: false,
      };
    } else {
      this.gesture.pointers += 1;
    }

    this.press = undefined;

    if (isMouse(sample)) {
      commands.push(
        mouseEvent(
          "mousePressed",
          sample.page,
          { button: buttonOf(sample.button), buttons: sample.buttons, clickCount: sample.detail },
          sample.modifiers,
        ),
      );

      return commands;
    }

    this.touches.set(sample.pointerId, { id: sample.pointerId, ...sample.page });
    commands.push(touchEvent("touchStart", this.points()));

    if (this.touches.size === 1) {
      this.press = { pointerId: sample.pointerId, at: sample.page, selecting: false };
    }

    return commands;
  }

  /**
   * The press of `pointerId` has been held for `LONG_PRESS_MS`: if it is still down and still, the tab gets a mouse
   * double press there, which selects the word, and the drag after it selects on.
   */
  held(pointerId: number): readonly CdpCommand[] {
    const press = this.press;

    if (press?.pointerId !== pointerId || press.selecting) return [];

    press.selecting = true;

    if (this.gesture !== null) this.gesture.selecting = true;

    return [
      touchEvent("touchCancel", []),
      mouseEvent("mousePressed", press.at, { button: "left", buttons: 1, clickCount: 1 }),
      mouseEvent("mouseReleased", press.at, { button: "left", buttons: 0, clickCount: 1 }),
      mouseEvent("mousePressed", press.at, { button: "left", buttons: 1, clickCount: 2 }),
    ];
  }

  move(sample: PointerSample): readonly CdpCommand[] {
    if (this.gesture !== null && (sample.buttons !== 0 || this.touches.has(sample.pointerId))) {
      this.gesture.moved = Math.max(this.gesture.moved, distance(sample.client, this.gesture.from));
    }

    if (this.press !== undefined && !this.press.selecting) {
      if (distance(sample.page, this.press.at) > TAP_SLOP) this.press = undefined;
    }

    if (sample.time - this.lastMove < MOVE_INTERVAL_MS) return [];

    this.lastMove = sample.time;

    if (isMouse(sample)) {
      return [
        mouseEvent(
          "mouseMoved",
          sample.page,
          { button: sample.buttons === 0 ? "none" : "left", buttons: sample.buttons },
          sample.modifiers,
        ),
      ];
    }

    if (this.press?.selecting === true && this.press.pointerId === sample.pointerId) {
      return [mouseEvent("mouseMoved", sample.page, { button: "left", buttons: 1 })];
    }

    if (!this.touches.has(sample.pointerId)) return [];

    this.touches.set(sample.pointerId, { id: sample.pointerId, ...sample.page });

    return [touchEvent("touchMove", this.points())];
  }

  /**
   * A pointer is released. When it is the last of a gesture that is a tap and `picker` says the tap is on a native
   * picker, the tab gets no tap (a touch cancel, or a mouse release and Escape for the pop-up the press opened).
   */
  up(sample: PointerSample, picker?: (point: Point) => boolean): Release {
    const press = this.press;
    const gesture = this.gesture;

    this.press = undefined;

    if (press?.selecting === true && press.pointerId === sample.pointerId) {
      this.touches.delete(sample.pointerId);
      this.gesture = null;

      const commands = [
        mouseEvent("mouseReleased", sample.page, { button: "left", buttons: 0, clickCount: 2 }),
      ];

      return gesture === null ? { commands } : { commands, gesture: this.ended(gesture, sample) };
    }

    const last = gesture !== null && (isMouse(sample) || this.touches.size <= 1);

    if (
      last &&
      picker !== undefined &&
      this.kindOf(gesture, sample.time) === "tap" &&
      picker(sample.page)
    ) {
      this.gesture = null;
      this.touches.delete(sample.pointerId);

      const commands = isMouse(sample)
        ? [
            mouseEvent("mouseReleased", sample.page, {
              button: "left",
              buttons: 0,
              clickCount: sample.detail,
            }),
            ...keyPress("Escape"),
          ]
        : [touchEvent("touchCancel", [])];

      return {
        commands,
        gesture: {
          kind: "tap",
          point: sample.page,
          pointerType: sample.pointerType,
          double: false,
          picker: true,
        },
      };
    }

    return this.release(sample, "touchEnd");
  }

  /** A pointer is cancelled (the browser took the gesture): the tab's touch is cancelled, and nothing is decided. */
  cancel(sample: PointerSample): Release {
    this.press = undefined;

    const { commands } = this.release(sample, "touchCancel");

    return { commands };
  }

  /** Give the gesture up to the Pane itself (a local pinch): the tab's touch is cancelled and its release is ignored. */
  abandon(): readonly CdpCommand[] {
    const held = this.touches.size > 0;

    this.touches.clear();
    this.gesture = null;
    this.press = undefined;

    return held ? [touchEvent("touchCancel", [])] : [];
  }

  wheel(sample: PointerSample, deltaX: number, deltaY: number): readonly CdpCommand[] {
    return [
      mouseEvent("mouseWheel", sample.page, { button: "none", deltaX, deltaY }, sample.modifiers),
    ];
  }

  private release(sample: PointerSample, type: "touchEnd" | "touchCancel"): Release {
    const gesture = this.gesture;
    let commands: readonly CdpCommand[];

    if (isMouse(sample)) {
      commands = [
        mouseEvent(
          "mouseReleased",
          sample.page,
          { button: buttonOf(sample.button), buttons: sample.buttons, clickCount: sample.detail },
          sample.modifiers,
        ),
      ];
    } else if (this.touches.delete(sample.pointerId)) {
      commands = [touchEvent(type, this.points())];
    } else {
      commands = [];
    }

    // The gesture ends with its last pointer.
    if (gesture === null || (!isMouse(sample) && this.touches.size > 0)) return { commands };

    this.gesture = null;

    if (type === "touchCancel") return { commands };

    return { commands, gesture: this.ended(gesture, sample) };
  }

  private kindOf(gesture: Tracked, time: number): GestureKind {
    if (gesture.selecting) return "select";

    if (gesture.pointers > 1) return "multi-touch";

    if (gesture.moved >= TAP_SLOP) return "drag";

    return time - gesture.start >= LONG_PRESS_MS ? "long-press" : "tap";
  }

  /** What `gesture` was, ending at `sample`; a tap close to the last one is a double tap. */
  private ended(gesture: Tracked, sample: PointerSample): Gesture {
    const kind = this.kindOf(gesture, sample.time);
    const point = sample.page;
    let double = false;

    if (kind === "tap") {
      const previous = this.lastTap;

      double =
        previous !== undefined &&
        sample.time - previous.time < DOUBLE_TAP_MS &&
        distance(point, previous.point) < DOUBLE_TAP_SLOP;
      this.lastTap = double ? undefined : { time: sample.time, point };
    } else {
      this.lastTap = undefined;
    }

    return { kind, point, pointerType: gesture.pointerType, double, picker: false };
  }

  private points(): TouchPoint[] {
    return Array.from(this.touches.values());
  }
}

/** One key event, as the Pane reads it from the DOM. */
export interface KeySample {
  readonly type: "down" | "up";
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/** What a desktop key does: CDP key events, or copy, cut or paste through the clipboard, or nothing. */
export type KeyAction =
  | { readonly type: "send"; readonly commands: readonly CdpCommand[] }
  | { readonly type: "copy" }
  | { readonly type: "cut" }
  | { readonly type: "paste" }
  | { readonly type: "ignore" };

const CLIPBOARD_KEYS: ReadonlyMap<string, "copy" | "cut" | "paste"> = new Map([
  ["KeyC", "copy"],
  ["KeyX", "cut"],
  ["KeyV", "paste"],
]);

/**
 * A desktop key as CDP key events. The tab runs on Linux, so on a Mac Cmd goes as Ctrl (Cmd+A selects all there too).
 * Copy, cut and paste go through the owner's clipboard instead: paste is left to the page's `paste` event, which
 * carries the clipboard's text.
 */
export const keyAction = (sample: KeySample, mac: boolean): KeyAction => {
  const ctrl = sample.ctrl || (mac && sample.meta);
  const meta = sample.meta && !mac;

  const clipboard = CLIPBOARD_KEYS.get(sample.code);

  if (ctrl && !sample.alt && clipboard !== undefined) {
    return sample.type === "down" ? { type: clipboard } : { type: "ignore" };
  }

  const modifiers =
    (sample.alt ? MODIFIER.alt : 0) |
    (ctrl ? MODIFIER.ctrl : 0) |
    (meta ? MODIFIER.meta : 0) |
    (sample.shift ? MODIFIER.shift : 0);

  const keyCode = keyCodeOf(sample.key, sample.code);

  const base = {
    key: sample.key,
    code: sample.code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };

  const withModifiers = modifiers === 0 ? base : { ...base, modifiers };

  if (sample.type === "up") {
    return {
      type: "send",
      commands: [{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...withModifiers } }],
    };
  }

  const text =
    sample.key === "Enter"
      ? "\r"
      : !ctrl && !meta && Array.from(sample.key).length === 1
        ? sample.key
        : undefined;

  const autoRepeat = sample.repeat ? { autoRepeat: true } : {};

  return {
    type: "send",
    commands: [
      {
        method: "Input.dispatchKeyEvent",
        params:
          text === undefined
            ? { type: "rawKeyDown", ...withModifiers, ...autoRepeat }
            : { type: "keyDown", ...withModifiers, ...autoRepeat, text, unmodifiedText: text },
      },
    ],
  };
};
