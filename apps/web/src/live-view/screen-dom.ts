// @effect-diagnostics newPromise:off -- the clipboard's promises, as the browser gives them.

// What the Live View screen's controllers share (#154): its elements, their listeners (removed together when the
// screen goes), the tab as the DOM side sees it (a script's answer, or undefined when it failed or the Live View
// closed), the typing textarea as the keyboard sees it, and the clipboard.

import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { MODIFIER, type CdpCommand } from "./cdp.ts";
import type { LiveView } from "./connection.ts";
import type { TypingTextarea } from "./keyboard.ts";

/** The elements the screen drives, rendered by the Pane. */
export interface ScreenElements {
  /** The frame's container: it scrolls in the Desktop layout, and takes the keys of a desktop. */
  readonly container: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  /** The invisible textarea the phone's keyboard types into, and a desktop's Cmd/Ctrl+V pastes into. */
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

/** Event listeners, removed together by `dispose`. */
export class Listeners {
  private readonly cleanups: Array<() => void> = [];

  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.add(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  onWindow<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): void {
    window.addEventListener(type, listener);
    this.add(() => {
      window.removeEventListener(type, listener);
    });
  }

  onDocument<K extends keyof DocumentEventMap>(
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void {
    document.addEventListener(type, listener);
    this.add(() => {
      document.removeEventListener(type, listener);
    });
  }

  /** Something else to undo with the listeners. */
  add(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}

/** The tab, as the DOM side uses it. */
export interface Tab {
  /** Evaluate `expression` in the page shown: undefined when it failed, or the Live View closed first. */
  readonly evaluate: <A>(expression: string, schema: Schema.Decoder<A>) => Promise<A | undefined>;
  /** Send the owner's input to the page shown. */
  readonly send: (commands: readonly CdpCommand[]) => void;
  /** Run one of the Live View's effects, its outcome dropped: it ends with the Live View. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => void;
}

/** The tab of `view`: its effects run in the Live View's scope (`LiveView.run`), so the Pane's closing ends them. */
export const tabOf = (view: LiveView): Tab => ({
  evaluate: (expression, schema) =>
    view.run(view.evaluate(expression, schema)).then(
      (value) => value,
      () => undefined,
    ),
  send: (commands) => {
    if (commands.length > 0) view.input(commands);
  },
  run: (effect) => {
    void view.run(effect).then(
      () => undefined,
      () => undefined,
    );
  },
});

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

/** CDP's modifier bits of the keys an event says are held. */
export const modifiersOf = (event: MouseEvent | KeyboardEvent): number =>
  (event.altKey ? MODIFIER.alt : 0) |
  (event.ctrlKey ? MODIFIER.ctrl : 0) |
  (event.metaKey ? MODIFIER.meta : 0) |
  (event.shiftKey ? MODIFIER.shift : 0);

/** The textarea as the keyboard uses it. */
export const typingTextarea = (element: HTMLTextAreaElement): TypingTextarea => ({
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

/** Write `text` to the clipboard inside the gesture: a `ClipboardItem` whose data is a promise, as iOS wants. */
export const writeClipboard = (text: Promise<string>): Promise<void> => {
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
};

/** Read the clipboard's text inside the gesture (iOS may show its Paste bubble first, or refuse); undefined without one. */
export const readClipboard = (): Promise<string> | undefined => {
  // Undefined outside a secure context.
  const clipboard: Clipboard | undefined = navigator.clipboard;

  return clipboard?.readText();
};
