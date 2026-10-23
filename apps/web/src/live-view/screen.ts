// @effect-diagnostics preferEffectArray:off asyncFunction:off newPromise:off globalTimers:off globalDate:off -- the DOM side of the Live View: event listeners, the browser's timers and clock (a field map read at most every 250 ms, a long press) and the clipboard's promises over native arrays.

// The Live View's screen (#154): the DOM around one connection. It draws the frames of the page shown to fit the Pane,
// turns the owner's pointer, wheel and keys into CDP input (`input.ts`), opens the phone's keyboard through the typing
// textarea (`keyboard.ts`), opens native pickers locally (`pickers.ts`), shows the edit menu (`edit-menu.ts`), sizes
// the tab to the Pane (`viewport.ts`), and checks the connection when the page comes back. The decisions live in those
// modules; this is the wiring, kept to what needs a real page.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BACKSPACE, MODIFIER, typeText, type CdpCommand, type Point } from "./cdp.ts";
import type { Frame, FrameMetadata, LiveView } from "./connection.ts";
import {
  EDIT_FOCUS_SCRIPT,
  EDIT_SELECT_ALL_SCRIPT,
  menuItems,
  menuProbeScript,
  MenuProbe,
  placeMenu,
  SELECTION_SCRIPT,
  wordAtScript,
  type MenuItem,
} from "./edit-menu.ts";
import {
  EMPTY_FIELD_MAP,
  FIELD_MAP_SCRIPT,
  FieldMapReading,
  FOCUSED_SCRIPT,
  FocusedElement,
  hitTest,
  type Field,
  type FieldMap,
  type Picker,
} from "./field-map.ts";
import {
  keyAction,
  LONG_PRESS_MS,
  PointerInput,
  type Gesture,
  type PointerSample,
} from "./input.ts";
import { Keyboard, type TypingTextarea } from "./keyboard.ts";
import { PickerWrites, type PickerChoice } from "./pickers.ts";
import {
  deviceMetrics,
  fromPage,
  pinch,
  screencastSize,
  toPage,
  type FrameMeta,
  type PinchStart,
} from "./viewport.ts";

/** The elements the screen drives, rendered by the Pane. */
export interface ScreenElements {
  /** The frame's container: it scrolls in the Desktop layout, and takes the keys of a desktop. */
  readonly container: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  /** The invisible textarea the phone's keyboard types into. */
  readonly textarea: HTMLTextAreaElement;
  /** The edit menu, with a button per item (`data-action`). */
  readonly menu: HTMLDivElement;
  /** The local controls of a native picker. */
  readonly pickSelect: HTMLSelectElement;
  readonly pickInput: HTMLInputElement;
  /** The paste box, shown when iOS refuses to read the clipboard, and its textarea. */
  readonly pasteBox: HTMLDivElement;
  readonly pasteField: HTMLTextAreaElement;
  /** The ⌨︎ button: highlighted when the tab focused a field the screen did not predict. */
  readonly keyboardButton: HTMLButtonElement | null;
}

/** How often the field map is read while the Live View is open, and at most how often, in ms. */
const MAP_INTERVAL_MS = 1000;
const MAP_THROTTLE_MS = 250;

/** How long after a tap the tab is asked what it focused, in ms. */
const AFTER_TAP_MS = 250;

/** How long a resize settles before the tab is sized again, in ms. */
const RESIZE_DEBOUNCE_MS = 150;

/** The Desktop layout's local zoom, relative to the frame fitting the Pane's width. */
const ZOOM_LIMITS = { min: 1, max: 4 };

/** How close in time and place two mouse presses are to count as a double click, in ms and px. */
const CLICK_MS = 500;
const CLICK_SLOP = 4;

/** A script's answer that is a string (the selection), or true or false. */
const MenuText = Schema.String;
const MenuFlag = Schema.Boolean;

/** A picker opened locally, and what it has written to the tab. */
interface OpenPicker {
  readonly local: HTMLSelectElement | HTMLInputElement;
  readonly picker: Picker;
  readonly writes: PickerWrites;
}

/** The edit menu as shown: where it was asked for. */
interface ShownMenu {
  readonly point: Point;
  readonly probe: MenuProbe;
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

const modifiersOf = (event: MouseEvent | KeyboardEvent): number =>
  (event.altKey ? MODIFIER.alt : 0) |
  (event.ctrlKey ? MODIFIER.ctrl : 0) |
  (event.metaKey ? MODIFIER.meta : 0) |
  (event.shiftKey ? MODIFIER.shift : 0);

/** The textarea as the keyboard uses it. */
const typingTextarea = (element: HTMLTextAreaElement): TypingTextarea => ({
  get focused() {
    return document.activeElement === element;
  },
  focus: () => {
    element.focus({ preventScroll: true });
  },
  blur: () => {
    element.blur();
  },
  get value() {
    return element.value;
  },
  set value(value: string) {
    element.value = value;
  },
  get spellcheck() {
    return element.spellcheck;
  },
  set spellcheck(value: boolean) {
    element.spellcheck = value;
  },
  setSelectionRange: (start, end) => {
    element.setSelectionRange(start, end);
  },
  getAttribute: (name) => element.getAttribute(name),
  setAttribute: (name, value) => {
    element.setAttribute(name, value);
  },
});

/** The screen of one Live View, until `dispose`. */
export class LiveViewScreen {
  private readonly input = new PointerInput();
  private readonly keyboard: Keyboard;
  private readonly touch = matchMedia("(pointer: coarse)").matches;
  private readonly mac = isMac();
  private readonly cleanups: Array<() => void> = [];
  private readonly image = new Image();
  private meta: FrameMetadata | undefined;
  private pending: Frame | undefined;
  private drawing = false;
  private fields: FieldMap = EMPTY_FIELD_MAP;
  private mapTimer: ReturnType<typeof setTimeout> | undefined;
  private mapReading = false;
  private lastMapRead = 0;
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private desktop = false;
  private zoom = 1;
  private pinching: PinchStart | undefined;
  private readonly fingers = new Map<number, Point>();
  private picker: OpenPicker | undefined;
  private pickerHit: Field | undefined;
  private menu: ShownMenu | undefined;
  /** Bumped by every touch on the frame, so a probe that answers after the next gesture began is dropped. */
  private gestures = 0;
  private lastPress: { readonly time: number; readonly at: Point; count: number } | undefined;
  private disposed = false;

  constructor(
    private readonly elements: ScreenElements,
    private readonly view: LiveView,
  ) {
    this.keyboard = new Keyboard(typingTextarea(elements.textarea));

    this.cleanups.push(view.frames((frame) => this.frame(frame)));
    this.listen();
    this.resized();

    const timer = setInterval(() => {
      this.scheduleMap();
    }, MAP_INTERVAL_MS);

    this.cleanups.push(() => {
      clearInterval(timer);
    });
    this.readMap();
  }

  /** The Desktop layout on or off: the tab is sized again, and the frame fits the Pane's width. */
  setDesktop(desktop: boolean): void {
    if (this.desktop === desktop) return;

    this.desktop = desktop;
    this.zoom = 1;
    this.elements.container.scrollTo(0, 0);
    this.applyViewport();
  }

  /** Open the keyboard by hand (the ⌨︎ button), in its tap. */
  forceKeyboard(): void {
    this.attention(false);
    this.keyboard.force(undefined);
    void this.run(this.view.evaluate(FOCUSED_SCRIPT, FocusedElement)).then((focused) => {
      if (focused?.editable === true) this.keyboard.check(focused);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.keyboard.close();
    this.closePicker();
    this.hideMenu();
    clearTimeout(this.mapTimer);
    clearTimeout(this.pressTimer);
    clearTimeout(this.resizeTimer);

    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  /** Run one of the Live View's effects, its failure dropped: undefined when it failed. */
  private run<A, E>(effect: Effect.Effect<A, E>): Promise<A | undefined> {
    return Effect.runPromise(effect.pipe(Effect.orElseSucceed(() => undefined)));
  }

  private evaluate<A>(expression: string, schema: Schema.Decoder<A>): Promise<A | undefined> {
    return this.run(this.view.evaluate(expression, schema));
  }

  private send(commands: readonly CdpCommand[]): void {
    if (commands.length > 0) this.view.input(commands);
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  private onWindow<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): void {
    window.addEventListener(type, listener);
    this.cleanups.push(() => {
      window.removeEventListener(type, listener);
    });
  }

  // ---- frames ----------------------------------------------------------------------------------

  private frame(frame: Frame): void {
    if (this.drawing) {
      this.pending = frame;

      return;
    }

    this.draw(frame);
  }

  private draw(frame: Frame): void {
    this.drawing = true;

    const previous = this.meta;

    this.meta = frame.metadata;

    if (
      previous === undefined ||
      previous.scrollOffsetX !== frame.metadata.scrollOffsetX ||
      previous.scrollOffsetY !== frame.metadata.scrollOffsetY ||
      previous.deviceWidth !== frame.metadata.deviceWidth
    ) {
      this.scheduleMap();
      // An open local picker no longer covers its element once the tab scrolls.
      this.closePicker();
      this.hideMenu();
    }

    const done = () => {
      this.paint();
      this.drawing = false;

      const next = this.pending;

      this.pending = undefined;

      if (next !== undefined && !this.disposed) this.draw(next);
    };

    this.image.onload = done;
    this.image.onerror = done;
    this.image.src = `data:image/jpeg;base64,${frame.data}`;
  }

  /** Size the canvas to the frame (the Pane's width, or the Desktop layout's zoom) and draw the last image. */
  private paint(): void {
    const { canvas, container } = this.elements;
    const meta = this.meta;

    if (meta === undefined) return;

    const width = container.clientWidth * (this.desktop ? this.zoom : 1);
    const height = (width * meta.deviceHeight) / Math.max(1, meta.deviceWidth);
    const ratio = Math.min(devicePixelRatio, 3);

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);

    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;

    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    canvas.getContext("2d")?.drawImage(this.image, 0, 0, pixelWidth, pixelHeight);
  }

  private frameMeta(): FrameMeta {
    return {
      deviceWidth: this.meta?.deviceWidth ?? this.elements.canvas.clientWidth,
      offsetTop: this.meta?.offsetTop ?? 0,
    };
  }

  private toPage(clientX: number, clientY: number): Point {
    const rect = this.elements.canvas.getBoundingClientRect();

    return toPage(
      { x: clientX, y: clientY },
      { left: rect.left, top: rect.top, width: rect.width },
      this.frameMeta(),
    );
  }

  /** A rect in the tab's viewport, in the screen wrapper's coordinates (where the overlays are placed). */
  private overlayRect(rect: { x: number; y: number; w: number; h: number }) {
    const canvas = this.elements.canvas.getBoundingClientRect();
    const wrapper = this.wrapperRect();
    const frame = { left: canvas.left, top: canvas.top, width: canvas.width };
    const meta = this.frameMeta();
    const topLeft = fromPage({ x: rect.x, y: rect.y }, frame, meta);
    const zoom = canvas.width / Math.max(1, meta.deviceWidth);

    return {
      x: topLeft.x - wrapper.left,
      y: topLeft.y - wrapper.top,
      w: rect.w * zoom,
      h: rect.h * zoom,
    };
  }

  private wrapperRect(): DOMRect {
    return (
      this.elements.container.parentElement ?? this.elements.container
    ).getBoundingClientRect();
  }

  // ---- the viewport ----------------------------------------------------------------------------

  private resized(): void {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.applyViewport();
    }, RESIZE_DEBOUNCE_MS);
  }

  private applyViewport(): void {
    const { container } = this.elements;

    if (container.clientWidth === 0 || container.clientHeight === 0) return;

    const dpr = devicePixelRatio;

    const metrics = deviceMetrics(
      { width: container.clientWidth, height: container.clientHeight, dpr, touch: this.touch },
      this.desktop,
    );

    void this.run(this.view.resize(metrics, screencastSize(metrics.metrics, dpr)));
    this.paint();
  }

  // ---- the field map ---------------------------------------------------------------------------

  private scheduleMap(): void {
    if (this.mapTimer !== undefined || this.disposed) return;

    this.mapTimer = setTimeout(
      () => {
        this.mapTimer = undefined;
        this.readMap();
      },
      Math.max(0, MAP_THROTTLE_MS - (Date.now() - this.lastMapRead)),
    );
  }

  private readMap(): void {
    if (this.mapReading || this.disposed) return;

    this.mapReading = true;
    this.lastMapRead = Date.now();
    void this.evaluate(FIELD_MAP_SCRIPT, FieldMapReading).then((reading) => {
      this.mapReading = false;

      if (reading !== undefined) this.fields = { ...reading, at: Date.now() };
    });
  }

  private hit(point: Point): Field | undefined {
    const scroll = {
      x: this.meta?.scrollOffsetX ?? this.fields.scrollX,
      y: this.meta?.scrollOffsetY ?? this.fields.scrollY,
    };

    return hitTest(this.fields, point, scroll);
  }

  // ---- pointer input ---------------------------------------------------------------------------

  private sample(event: PointerEvent, detail = 1): PointerSample {
    return {
      pointerId: event.pointerId,
      pointerType: event.pointerType === "mouse" ? "mouse" : "touch",
      isPrimary: event.isPrimary,
      buttons: event.buttons,
      button: event.button,
      detail,
      client: { x: event.clientX, y: event.clientY },
      page: this.toPage(event.clientX, event.clientY),
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
      page: this.toPage(event.clientX, event.clientY),
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
    const rect = this.elements.container.getBoundingClientRect();

    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private listen(): void {
    const { canvas, container, textarea, menu, pasteField } = this.elements;

    this.on(canvas, "contextmenu", (event) => {
      event.preventDefault();
    });
    // Touching the frame must not move focus (blurring the textarea closes the keyboard) or make mouse events.
    this.on(canvas, "touchstart", (event) => event.preventDefault(), { passive: false });
    this.on(canvas, "touchend", (event) => event.preventDefault(), { passive: false });
    this.on(canvas, "mousedown", (event) => {
      event.preventDefault();
    });
    this.on(canvas, "pointerdown", (event) => {
      this.pointerDown(event);
    });
    this.on(canvas, "pointermove", (event) => {
      this.pointerMove(event);
    });
    this.on(canvas, "pointerup", (event) => {
      this.pointerUp(event, false);
    });
    this.on(canvas, "pointercancel", (event) => {
      this.pointerUp(event, true);
    });
    this.on(
      canvas,
      "wheel",
      (event) => {
        event.preventDefault();
        this.hideMenu();
        this.send(this.input.wheel(this.wheelSample(event), event.deltaX, event.deltaY));
      },
      { passive: false },
    );

    // The phone's keyboard.
    this.on(textarea, "input", () => {
      this.hideMenu();
      this.send(this.keyboard.input());
      this.scheduleMap();
    });
    this.on(textarea, "compositionstart", () => {
      this.keyboard.compositionStart();
    });
    this.on(textarea, "compositionend", () => {
      this.send(this.keyboard.compositionEnd());
    });
    this.on(textarea, "paste", (event) => {
      event.preventDefault();
      this.send(this.keyboard.paste(event.clipboardData?.getData("text/plain") ?? ""));
    });
    this.on(textarea, "keydown", (event) => {
      const commands = this.keyboard.key(event.key);

      if (commands === undefined) return;

      event.preventDefault();
      this.send(commands);
    });

    // A desktop's keys, while the frame has the focus.
    this.on(container, "keydown", (event) => {
      this.key(event, "down");
    });
    this.on(container, "keyup", (event) => {
      this.key(event, "up");
    });
    this.on(container, "paste", (event) => {
      if (event.target === textarea) return;

      event.preventDefault();

      const text = event.clipboardData?.getData("text/plain") ?? "";

      if (text !== "") this.send(typeText(text));
    });

    // The edit menu: touching it neither moves focus (the keyboard stays as it was) nor reaches the frame.
    this.on(menu, "touchstart", (event) => event.preventDefault(), { passive: false });
    this.on(menu, "mousedown", (event) => {
      event.preventDefault();
    });
    this.on(menu, "contextmenu", (event) => {
      event.preventDefault();
    });

    let pressed: HTMLButtonElement | null = null;

    this.on(menu, "pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pressed = event.target instanceof Element ? event.target.closest("button") : null;
    });
    this.on(menu, "pointerup", (event) => {
      event.preventDefault();

      const button = pressed;

      pressed = null;

      // A touch's pointerup targets where it began: it acts only when it ended on the same item.
      const under = document.elementFromPoint(event.clientX, event.clientY)?.closest("button");

      if (button !== null && under === button) this.menuAction(button.dataset.action ?? "");
    });

    // The paste box, when iOS refuses to read the clipboard: what is pasted into it is typed into the tab.
    this.on(pasteField, "input", () => {
      const text = pasteField.value;

      if (text === "") return;

      pasteField.value = "";
      this.elements.pasteBox.hidden = true;
      void this.paste(text);
    });

    // Native pickers: each of these may be the one that carries the value, depending on the control and the OS.
    for (const local of [this.elements.pickSelect, this.elements.pickInput]) {
      for (const type of ["input", "change"] as const) {
        this.on(local, type, () => {
          const open = this.picker;

          if (open?.local !== local) return;

          this.commitPicker(open);

          // A single choice is done; a multiple select, a date or a colour can still change until it closes.
          if (type === "change" && local instanceof HTMLSelectElement && !local.multiple) {
            this.closePicker();
          }
        });
      }

      this.on(local, "blur", () => {
        const open = this.picker;

        if (open?.local !== local) return;

        this.commitPicker(open);
        // Some pickers set the value just after the blur.
        setTimeout(() => {
          this.commitPicker(open);

          if (this.picker === open && document.activeElement !== local) this.closePicker();
        }, 400);
      });
    }

    const observer = new ResizeObserver(() => {
      this.resized();
    });

    observer.observe(container);
    this.cleanups.push(() => {
      observer.disconnect();
    });

    // Back from the background: iOS may have killed the sockets without a word.
    const returned = () => {
      if (document.visibilityState === "visible") void this.run(this.view.returned);
    };

    document.addEventListener("visibilitychange", returned);
    this.cleanups.push(() => {
      document.removeEventListener("visibilitychange", returned);
    });
    this.onWindow("pageshow", returned);
    this.onWindow("pagehide", () => {
      this.view.clearViewport();
    });
  }

  private pointerDown(event: PointerEvent): void {
    event.preventDefault();

    const { canvas, container } = this.elements;

    // The frame's preventDefault keeps a local picker focused: close it here instead.
    if (event.isPrimary) this.closePicker();

    this.gestures += 1;
    this.hideMenu();
    canvas.setPointerCapture(event.pointerId);

    if (event.pointerType === "mouse") {
      // The keys of a desktop go to the frame's container.
      container.focus({ preventScroll: true });
      this.send(this.input.down(this.sample(event, this.clickCount(event))));

      return;
    }

    this.fingers.set(event.pointerId, this.containerPoint(event));

    // Two fingers in the Desktop layout pan and zoom the frame here; the tab does not get them.
    if (this.desktop && this.fingers.size >= 2) {
      this.send(this.input.abandon());
      clearTimeout(this.pressTimer);

      const [a, b] = Array.from(this.fingers.values());

      if (a !== undefined && b !== undefined) {
        this.pinching = {
          a,
          b,
          zoom: this.zoom,
          scroll: { x: container.scrollLeft, y: container.scrollTop },
        };
      }

      return;
    }

    if (this.pinching !== undefined) return;

    this.send(this.input.down(this.sample(event)));

    const pointerId = event.pointerId;

    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => {
      const commands = this.input.held(pointerId);

      if (commands.length > 0) this.hideMenu();

      this.send(commands);
    }, LONG_PRESS_MS);
  }

  private pointerMove(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && this.fingers.has(event.pointerId)) {
      this.fingers.set(event.pointerId, this.containerPoint(event));
    }

    if (this.pinching !== undefined) {
      const [a, b] = Array.from(this.fingers.values());

      if (a === undefined || b === undefined) return;

      const next = pinch(this.pinching, a, b, ZOOM_LIMITS);

      this.zoom = next.zoom;
      this.paint();
      this.elements.container.scrollTo(next.scroll.x, next.scroll.y);

      return;
    }

    this.send(this.input.move(this.sample(event)));
  }

  private pointerUp(event: PointerEvent, cancelled: boolean): void {
    this.fingers.delete(event.pointerId);

    if (this.pinching !== undefined) {
      if (this.fingers.size === 0) this.pinching = undefined;

      return;
    }

    clearTimeout(this.pressTimer);

    const detail = event.pointerType === "mouse" ? (this.lastPress?.count ?? 1) : 1;
    const sample = this.sample(event, detail);

    if (cancelled) {
      this.send(this.input.cancel(sample).commands);

      return;
    }

    this.pickerHit = undefined;

    const release = this.input.up(sample, (point) => {
      this.pickerHit = this.hit(point);

      return this.pickerHit?.picker !== undefined;
    });

    this.send(release.commands);

    if (release.gesture !== undefined) this.gestureEnded(release.gesture);
  }

  /** What a gesture does beyond its input: the keyboard, a local picker, the edit menu. */
  private gestureEnded(gesture: Gesture): void {
    if (gesture.picker) {
      if (this.pickerHit !== undefined) this.openPicker(this.pickerHit);

      return;
    }

    this.scheduleMap();

    // The keyboard and the edit menu are for touch screens; a desktop has its own keys and clipboard.
    if (gesture.pointerType === "mouse") return;

    const { kind, point } = gesture;

    if (kind === "tap") {
      // Decided now, inside the tap, so a focus opens the keyboard on iOS.
      const field = this.hit(point);

      this.keyboard.tap(field?.picker === undefined ? field : undefined);
      this.afterTap();

      if (gesture.double) void this.doubleTap(point);

      return;
    }

    if (kind === "long-press") void this.showMenu(point);

    // The mouse release that ends the selection was sent with this release.
    if (kind === "select") {
      setTimeout(() => {
        void this.showMenu(point);
      }, 200);
    }
  }

  /** The safety net after a tap: what the tab focused, against what the tap predicted. */
  private afterTap(): void {
    setTimeout(() => {
      void this.evaluate(FOCUSED_SCRIPT, FocusedElement).then((focused) => {
        if (focused === undefined) return;

        this.attention(this.keyboard.check(focused) === "attention");
      });
    }, AFTER_TAP_MS);
  }

  private attention(on: boolean): void {
    const button = this.elements.keyboardButton;

    if (button === null) return;

    if (on) button.dataset.attention = "";
    else delete button.dataset.attention;
  }

  // ---- desktop keys ----------------------------------------------------------------------------

  private key(event: KeyboardEvent, type: "down" | "up"): void {
    if (event.target !== this.elements.container || event.isComposing) return;

    const action = keyAction(
      {
        type,
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      },
      this.mac,
    );

    switch (action.type) {
      case "send":
        event.preventDefault();
        this.send(action.commands);
        break;
      case "copy":
        event.preventDefault();
        void this.copy(this.evaluate(SELECTION_SCRIPT, MenuText).then((text) => text ?? ""));
        break;
      case "cut":
        event.preventDefault();
        void this.copy(this.evaluate(SELECTION_SCRIPT, MenuText).then((text) => text ?? "")).then(
          () => {
            this.send(BACKSPACE);
          },
        );
        break;
      case "paste":
      case "ignore":
        // Paste is the page's `paste` event, which carries the clipboard's text.
        break;
    }
  }

  // ---- the clipboard and the edit menu -----------------------------------------------------------

  /** Write `text` to the clipboard inside the gesture: a `ClipboardItem` whose data is a promise, as iOS wants. */
  private copy(text: Promise<string>): Promise<void> {
    // Undefined outside a secure context.
    const clipboard: Clipboard | undefined = navigator.clipboard;

    if (clipboard === undefined) return text.then(() => undefined);

    if ("ClipboardItem" in window) {
      return clipboard
        .write([
          new ClipboardItem({
            "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })),
          }),
        ])
        .catch(() => undefined);
    }

    return text.then((value) => clipboard.writeText(value)).catch(() => undefined);
  }

  /** Type `text` into the field the menu was for (focused, caret at its end, if it was not). */
  private async paste(text: string): Promise<void> {
    const focused = await this.evaluate(EDIT_FOCUS_SCRIPT, MenuFlag);

    if (focused !== true) return;

    this.keyboard.reset();
    this.send(typeText(text));
    this.scheduleMap();
  }

  private async doubleTap(point: Point): Promise<void> {
    const gesture = this.gestures;
    const word = await this.evaluate(wordAtScript(point.x, point.y), MenuFlag);

    if (word !== true || gesture !== this.gestures) return;

    this.send([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 2 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 2 },
      },
    ]);
    setTimeout(() => {
      if (gesture === this.gestures) void this.showMenu(point);
    }, 120);
  }

  /** Ask the tab what is at `point` and show the items that apply, above the selection (below without room). */
  private async showMenu(point: Point): Promise<void> {
    const gesture = this.gestures;
    const probe = await this.evaluate(menuProbeScript(point.x, point.y), MenuProbe);

    if (probe === undefined || gesture !== this.gestures || this.disposed) return;

    const items = menuItems(probe);

    if (items.length === 0) {
      this.hideMenu();

      return;
    }

    const { menu } = this.elements;

    for (const button of Array.from(menu.querySelectorAll<HTMLButtonElement>("button"))) {
      // SAFETY: the menu renders one button per item, named by `data-action`.
      button.hidden = !items.includes(button.dataset.action as MenuItem);
    }

    menu.hidden = false;

    const anchor = this.overlayRect(probe.rect ?? { x: point.x, y: point.y, w: 0, h: 0 });
    const wrapper = this.wrapperRect();
    const canvas = this.elements.canvas.getBoundingClientRect();
    const top = Math.max(0, canvas.top - wrapper.top);
    const left = Math.max(0, canvas.left - wrapper.left);

    const place = placeMenu(
      anchor,
      {
        left,
        top,
        width: Math.min(wrapper.width, canvas.right - wrapper.left) - left,
        height: Math.min(wrapper.height, canvas.bottom - wrapper.top) - top,
      },
      { width: menu.offsetWidth, height: menu.offsetHeight },
    );

    menu.style.left = `${place.x}px`;
    menu.style.top = `${place.y}px`;
    this.menu = { point, probe };
  }

  private hideMenu(): void {
    this.menu = undefined;
    this.elements.menu.hidden = true;
  }

  private menuAction(action: string): void {
    const shown = this.menu;

    if (shown === undefined) return;

    const { point, probe } = shown;

    // The selection's text, read again when the item is tapped; the probe's when that fails.
    const selection = () =>
      this.evaluate(menuProbeScript(point.x, point.y), MenuProbe).then(
        (fresh) => fresh?.text || probe.text,
      );

    if (action === "Copy") {
      void this.copy(selection());
      this.hideMenu();
    } else if (action === "Cut") {
      const text = selection();

      void this.copy(text);
      void text.then(() => {
        this.send(BACKSPACE);
        this.keyboard.reset();
        this.scheduleMap();
      });
      this.hideMenu();
    } else if (action === "Paste") {
      this.hideMenu();

      // Read inside the tap; iOS may show its own Paste bubble first, or refuse.
      // Undefined outside a secure context.
      const clipboard: Clipboard | undefined = navigator.clipboard;
      const read = clipboard?.readText();

      if (read === undefined) {
        this.showPasteBox();

        return;
      }

      read.then(
        (text) => {
          if (text !== "") void this.paste(text);
        },
        () => {
          this.showPasteBox();
        },
      );
    } else if (action === "Select All") {
      void this.evaluate(EDIT_SELECT_ALL_SCRIPT, MenuFlag).then(() => {
        this.keyboard.reset();
        void this.showMenu(point);
      });
    }
  }

  private showPasteBox(): void {
    this.elements.pasteBox.hidden = false;
    this.elements.pasteField.value = "";
    this.elements.pasteField.focus({ preventScroll: true });
  }

  // ---- native pickers --------------------------------------------------------------------------

  /** A local control of the picker's kind over the tapped element, opened inside the tap. */
  private openPicker(field: Field): void {
    const picker = field.picker;

    if (picker === undefined) return;

    const { pickSelect, pickInput } = this.elements;

    this.keyboard.close();
    this.closePicker();

    let local: HTMLSelectElement | HTMLInputElement;
    let initial: PickerChoice;

    if (picker.kind === "select") {
      local = pickSelect;
      pickSelect.multiple = picker.multiple;
      pickSelect.size = picker.multiple ? Math.min(picker.options.length, 4) : 0;
      pickSelect.replaceChildren();

      let group: HTMLOptGroupElement | null = null;

      picker.options.forEach((option, index) => {
        const element = new Option(option.text, String(index), false, option.selected);

        element.disabled = option.disabled;

        if (option.group === "") {
          group = null;
          pickSelect.append(element);

          return;
        }

        if (group?.label !== option.group) {
          group = document.createElement("optgroup");
          group.label = option.group;
          pickSelect.append(group);
        }

        group.append(element);
      });
      initial = { indexes: this.selected(pickSelect) };
    } else {
      local = pickInput;
      pickInput.type = field.type;
      pickInput.min = picker.min;
      pickInput.max = picker.max;
      pickInput.step = picker.step;
      pickInput.value = picker.value;
      initial = { value: pickInput.value };
    }

    // Exactly over the element, so a tap beside it still reaches the frame.
    const rect = this.overlayRect(field);

    local.style.left = `${rect.x}px`;
    local.style.top = `${rect.y}px`;
    local.style.width = `${Math.max(60, rect.w)}px`;
    local.style.height = `${Math.max(32, rect.h)}px`;
    local.hidden = false;
    this.picker = { local, picker, writes: new PickerWrites(picker.index, initial) };
    local.focus({ preventScroll: true });

    try {
      local.showPicker();
    } catch {
      // A browser without `showPicker` for it, or one that refuses: the focused control still opens on a tap.
    }
  }

  private selected(select: HTMLSelectElement): number[] {
    return Array.from(select.selectedOptions, (option) => Number(option.value));
  }

  private choiceOf(open: OpenPicker): PickerChoice {
    return open.local instanceof HTMLSelectElement
      ? { indexes: this.selected(open.local) }
      : { value: open.local.value };
  }

  /** Write the control's value to the tab, unless it is the one last written. */
  private commitPicker(open: OpenPicker): void {
    const script = open.writes.next(this.choiceOf(open));

    if (script === undefined) return;

    void this.evaluate(script, MenuFlag).then(() => {
      this.scheduleMap();
    });
  }

  private closePicker(): void {
    const open = this.picker;

    if (open === undefined) return;

    this.picker = undefined;
    this.commitPicker(open);
    open.local.hidden = true;

    if (document.activeElement === open.local) open.local.blur();
  }
}
