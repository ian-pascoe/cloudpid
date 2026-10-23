// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain constructors of CDP commands over native arrays.

// The CDP commands the Live View sends a page for the owner's input, as plain data: the input modules make them and the
// connection sends them, so what a touch or a key turns into is testable without a socket.

/** A point in CSS px. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A touch point of `Input.dispatchTouchEvent`. */
export interface TouchPoint extends Point {
  readonly id: number;
}

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export type MouseButton = "none" | "left" | "middle" | "right";

/** What every key event of one key carries. */
interface KeyFields {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers?: number;
}

export type CdpCommand =
  | {
      readonly method: "Input.dispatchTouchEvent";
      readonly params: {
        readonly type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
        readonly touchPoints: readonly TouchPoint[];
        readonly modifiers?: number;
      };
    }
  | {
      readonly method: "Input.dispatchMouseEvent";
      readonly params: {
        readonly type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
        readonly x: number;
        readonly y: number;
        readonly button: MouseButton;
        readonly buttons?: number;
        readonly clickCount?: number;
        readonly deltaX?: number;
        readonly deltaY?: number;
        readonly modifiers?: number;
      };
    }
  | {
      readonly method: "Input.dispatchKeyEvent";
      readonly params: Readonly<KeyFields> & {
        readonly type: "keyDown" | "rawKeyDown" | "keyUp";
        readonly text?: string;
        readonly unmodifiedText?: string;
        readonly autoRepeat?: boolean;
      };
    }
  | { readonly method: "Input.insertText"; readonly params: { readonly text: string } };

/** The Windows virtual key codes of the keys that are not a letter or a digit, which CDP's key events carry. */
const NAMED_KEY_CODES: ReadonlyMap<string, number> = new Map([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Shift", 16],
  ["Control", 17],
  ["Alt", 18],
  ["Pause", 19],
  ["CapsLock", 20],
  ["Escape", 27],
  [" ", 32],
  ["PageUp", 33],
  ["PageDown", 34],
  ["End", 35],
  ["Home", 36],
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Insert", 45],
  ["Delete", 46],
  ["Meta", 91],
  ["ContextMenu", 93],
  ["F1", 112],
  ["F2", 113],
  ["F3", 114],
  ["F4", 115],
  ["F5", 116],
  ["F6", 117],
  ["F7", 118],
  ["F8", 119],
  ["F9", 120],
  ["F10", 121],
  ["F11", 122],
  ["F12", 123],
  [";", 186],
  ["=", 187],
  [",", 188],
  ["-", 189],
  [".", 190],
  ["/", 191],
  ["`", 192],
  ["[", 219],
  ["\\", 220],
  ["]", 221],
  ["'", 222],
]);

/** The physical keys whose code tells the virtual key code better than the character they type (Shift+1 types "!"). */
const CODE_KEY_CODES: ReadonlyMap<string, number> = new Map([
  ["Semicolon", 186],
  ["Equal", 187],
  ["Comma", 188],
  ["Minus", 189],
  ["Period", 190],
  ["Slash", 191],
  ["Backquote", 192],
  ["BracketLeft", 219],
  ["Backslash", 220],
  ["BracketRight", 221],
  ["Quote", 222],
  ["Space", 32],
]);

/** The Windows virtual key code of a key, from its `code` where that names a letter, a digit or a symbol key. */
export const keyCodeOf = (key: string, code: string): number => {
  const letter = /^Key([A-Z])$/.exec(code);

  if (letter?.[1] !== undefined) return letter[1].charCodeAt(0);

  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);

  if (digit?.[1] !== undefined) return 48 + Number(digit[1]);

  const named = CODE_KEY_CODES.get(code) ?? NAMED_KEY_CODES.get(key);

  if (named !== undefined) return named;

  // A letter typed with no physical key behind it (a soft keyboard): its upper case is its key code.
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);

  return /^[0-9]$/.test(key) ? key.charCodeAt(0) : 0;
};

/**
 * A press of `key` (down, then up), both sent at once so they keep their order with the text around them. With `text`
 * the down types it, as a printable key's does; without, it is a raw key down, as for Backspace or an arrow.
 */
export const keyPress = (
  key: string,
  code: string = key,
  text?: string,
  modifiers = 0,
): readonly CdpCommand[] => {
  const keyCode = keyCodeOf(key, code);

  const base: KeyFields = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };

  if (modifiers !== 0) base.modifiers = modifiers;

  return [
    {
      method: "Input.dispatchKeyEvent",
      params:
        text === undefined
          ? { type: "rawKeyDown", ...base }
          : { type: "keyDown", ...base, text, unmodifiedText: text },
    },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
  ];
};

/** Enter, as a key that types a line break. */
export const ENTER: readonly CdpCommand[] = keyPress("Enter", "Enter", "\r");

/** Backspace, deleting one character before the caret. */
export const BACKSPACE: readonly CdpCommand[] = keyPress("Backspace");

/**
 * Pasted `text`, as one `Input.insertText`: its line breaks are inserted as text, never pressed as Enter, so pasting
 * several lines into a field does not submit its form.
 */
export const insertText = (text: string): readonly CdpCommand[] =>
  text === "" ? [] : [{ method: "Input.insertText", params: { text } }];

/**
 * `text` as the tab gets typed text: `Input.insertText` for each line, and Enter between lines, so a textarea gets a
 * line break and a form field submits as it would for a typed Enter.
 */
export const typeText = (text: string): readonly CdpCommand[] =>
  text
    .split(/\r\n|\r|\n/)
    .flatMap((line, index) => [
      ...(index > 0 ? ENTER : []),
      ...(line === "" ? [] : [{ method: "Input.insertText", params: { text: line } } as const]),
    ]);
