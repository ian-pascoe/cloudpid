// @effect-diagnostics preferEffectArray:off -- touch points over native arrays.

import { describe, expect, it } from "vitest";
import { keyPress, MODIFIER } from "./cdp.ts";
import { keyAction, PointerInput, type KeySample, type PointerSample } from "./input.ts";

/** A pointer event at `x`,`y` on the screen, which is also where it is in the tab (a frame drawn at 1:1). */
const at = (
  x: number,
  y: number,
  time: number,
  overrides: Partial<PointerSample> = {},
): PointerSample => ({
  pointerId: 1,
  pointerType: "touch",
  isPrimary: true,
  buttons: 1,
  button: 0,
  detail: 1,
  client: { x, y },
  page: { x, y },
  time,
  modifiers: 0,
  ...overrides,
});

const touch = (type: string, points: ReadonlyArray<readonly [number, number, number]>) => ({
  method: "Input.dispatchTouchEvent",
  params: { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) },
});

const mouse = (
  type: string,
  x: number,
  y: number,
  extra: Readonly<Record<string, string | number>> = {},
) => ({
  method: "Input.dispatchMouseEvent",
  params: { type, x, y, ...extra },
});

describe("touch input to CDP", () => {
  it("sends a tap as a touch start and end, and says it was a tap", () => {
    const input = new PointerInput();

    expect(input.down(at(10, 20, 0))).toEqual([touch("touchStart", [[1, 10, 20]])]);

    const release = input.up(at(11, 21, 120, { buttons: 0 }));

    expect(release.commands).toEqual([touch("touchEnd", [])]);
    expect(release.gesture).toMatchObject({ kind: "tap", point: { x: 11, y: 21 }, double: false });
  });

  it("sends a drag as touch moves, and says it was a drag", () => {
    const input = new PointerInput();

    input.down(at(10, 100, 0));

    expect(input.move(at(10, 80, 20))).toEqual([touch("touchMove", [[1, 10, 80]])]);
    expect(input.move(at(10, 40, 40))).toEqual([touch("touchMove", [[1, 10, 40]])]);
    expect(input.up(at(10, 40, 60, { buttons: 0 })).gesture?.kind).toBe("drag");
  });

  it("drops moves closer together than a frame, but never the release", () => {
    const input = new PointerInput();

    input.down(at(10, 100, 0));
    input.move(at(10, 90, 20));

    expect(input.move(at(10, 85, 25))).toEqual([]);
    expect(input.up(at(10, 80, 30, { buttons: 0 })).commands).toEqual([touch("touchEnd", [])]);
  });

  it("says a press held without moving was a long press when nothing selected it", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    expect(input.up(at(10, 20, 700, { buttons: 0 })).gesture?.kind).toBe("long-press");
  });

  it("turns a held press into a mouse double press, and the drag after it into mouse moves", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    expect(input.held(1)).toEqual([
      touch("touchCancel", []),
      mouse("mousePressed", 10, 20, { button: "left", buttons: 1, clickCount: 1 }),
      mouse("mouseReleased", 10, 20, { button: "left", buttons: 0, clickCount: 1 }),
      mouse("mousePressed", 10, 20, { button: "left", buttons: 1, clickCount: 2 }),
    ]);
    expect(input.move(at(60, 20, 600))).toEqual([
      mouse("mouseMoved", 60, 20, { button: "left", buttons: 1 }),
    ]);

    const release = input.up(at(60, 20, 700, { buttons: 0 }));

    expect(release.commands).toEqual([
      mouse("mouseReleased", 60, 20, { button: "left", buttons: 0, clickCount: 2 }),
    ]);
    expect(release.gesture?.kind).toBe("select");
  });

  it("does nothing when the press timer fires after the finger moved away or lifted", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));
    input.move(at(10, 60, 100));

    expect(input.held(1)).toEqual([]);

    input.up(at(10, 60, 200, { buttons: 0 }));

    expect(input.held(1)).toEqual([]);
  });

  it("sends every finger of a multi-touch gesture, and says it was one", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    expect(input.down(at(50, 60, 10, { pointerId: 2, isPrimary: false }))).toEqual([
      touch("touchStart", [
        [1, 10, 20],
        [2, 50, 60],
      ]),
    ]);

    const first = input.up(at(10, 20, 100, { buttons: 0 }));

    expect(first.commands).toEqual([touch("touchEnd", [[2, 50, 60]])]);
    expect(first.gesture).toBeUndefined();
    expect(input.up(at(50, 60, 110, { pointerId: 2, buttons: 0 })).gesture?.kind).toBe(
      "multi-touch",
    );
  });

  it("says a second tap close by and soon after was a double tap", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));
    input.up(at(10, 20, 80, { buttons: 0 }));
    input.down(at(14, 22, 250));

    expect(input.up(at(14, 22, 320, { buttons: 0 })).gesture?.double).toBe(true);

    // A third tap starts again.
    input.down(at(14, 22, 500));

    expect(input.up(at(14, 22, 560, { buttons: 0 })).gesture?.double).toBe(false);
  });

  it("withholds a tap on a native picker from the tab", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    const release = input.up(at(10, 20, 100, { buttons: 0 }), () => true);

    expect(release.commands).toEqual([touch("touchCancel", [])]);
    expect(release.gesture).toMatchObject({ kind: "tap", picker: true });
  });

  it("drops a gesture whose release never came when the next one starts", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    expect(input.down(at(30, 40, 900, { pointerId: 5 }))).toEqual([
      touch("touchCancel", []),
      touch("touchStart", [[5, 30, 40]]),
    ]);
  });

  it("gives the tab up for a local gesture: a touch cancel, and no gesture at the release", () => {
    const input = new PointerInput();

    input.down(at(10, 20, 0));

    expect(input.abandon()).toEqual([touch("touchCancel", [])]);
    expect(input.up(at(10, 20, 50, { buttons: 0 }))).toEqual({ commands: [] });
  });
});

describe("mouse input to CDP", () => {
  const click = { pointerType: "mouse" } as const;

  it("sends presses, moves and releases with the button and the click count", () => {
    const input = new PointerInput();

    expect(input.down(at(5, 6, 0, { ...click, detail: 2 }))).toEqual([
      mouse("mousePressed", 5, 6, { button: "left", buttons: 1, clickCount: 2 }),
    ]);
    expect(input.move(at(9, 6, 20, click))).toEqual([
      mouse("mouseMoved", 9, 6, { button: "left", buttons: 1 }),
    ]);
    expect(input.up(at(9, 6, 40, { ...click, buttons: 0, detail: 2 })).commands).toEqual([
      mouse("mouseReleased", 9, 6, { button: "left", buttons: 0, clickCount: 2 }),
    ]);
  });

  it("sends a hover as a move with no button, and keeps the modifiers", () => {
    const input = new PointerInput();

    expect(input.move(at(1, 2, 0, { ...click, buttons: 0, modifiers: MODIFIER.shift }))).toEqual([
      mouse("mouseMoved", 1, 2, { button: "none", buttons: 0, modifiers: MODIFIER.shift }),
    ]);
  });

  it("sends the wheel at the pointer", () => {
    const input = new PointerInput();

    expect(input.wheel(at(3, 4, 0, { ...click, buttons: 0 }), 0, 120)).toEqual([
      mouse("mouseWheel", 3, 4, { button: "none", deltaX: 0, deltaY: 120 }),
    ]);
  });

  it("releases and closes the tab's own pop-up when a click opens a local picker", () => {
    const input = new PointerInput();

    input.down(at(5, 6, 0, click));

    expect(input.up(at(5, 6, 50, { ...click, buttons: 0 }), () => true).commands).toEqual([
      mouse("mouseReleased", 5, 6, { button: "left", buttons: 0, clickCount: 1 }),
      ...keyPress("Escape"),
    ]);
  });
});

describe("desktop keys to CDP", () => {
  const key = (overrides: Partial<KeySample>): KeySample => ({
    type: "down",
    key: "a",
    code: "KeyA",
    repeat: false,
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
    ...overrides,
  });

  it("types a printable key as it goes down, and releases it", () => {
    expect(keyAction(key({}), false)).toEqual({
      type: "send",
      commands: [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
            text: "a",
            unmodifiedText: "a",
          },
        },
      ],
    });
    expect(keyAction(key({ type: "up" }), false)).toMatchObject({
      type: "send",
      commands: [{ params: { type: "keyUp", key: "a", windowsVirtualKeyCode: 65 } }],
    });
  });

  it("sends a key that types nothing as a raw key down, with its modifiers", () => {
    expect(keyAction(key({ key: "ArrowLeft", code: "ArrowLeft", shift: true }), false)).toEqual({
      type: "send",
      commands: [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type: "rawKeyDown",
            key: "ArrowLeft",
            code: "ArrowLeft",
            windowsVirtualKeyCode: 37,
            nativeVirtualKeyCode: 37,
            modifiers: MODIFIER.shift,
          },
        },
      ],
    });
  });

  it("types Enter as a line break", () => {
    expect(keyAction(key({ key: "Enter", code: "Enter" }), false)).toMatchObject({
      commands: [{ params: { type: "keyDown", text: "\r", windowsVirtualKeyCode: 13 } }],
    });
  });

  it("sends a shortcut without typing it, Cmd as Ctrl on a Mac, since the tab runs on Linux", () => {
    expect(keyAction(key({ meta: true }), true)).toMatchObject({
      commands: [{ params: { type: "rawKeyDown", key: "a", modifiers: MODIFIER.ctrl } }],
    });
    expect(keyAction(key({ ctrl: true }), false)).toMatchObject({
      commands: [{ params: { type: "rawKeyDown", modifiers: MODIFIER.ctrl } }],
    });
  });

  it("leaves copy, cut and paste to the clipboard", () => {
    expect(keyAction(key({ key: "c", code: "KeyC", meta: true }), true)).toEqual({ type: "copy" });
    expect(keyAction(key({ key: "x", code: "KeyX", ctrl: true }), false)).toEqual({
      type: "cut",
    });
    expect(keyAction(key({ key: "v", code: "KeyV", ctrl: true }), false)).toEqual({
      type: "paste",
    });
    expect(keyAction(key({ type: "up", key: "v", code: "KeyV", ctrl: true }), false)).toEqual({
      type: "ignore",
    });
  });
});
