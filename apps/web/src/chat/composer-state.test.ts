// @effect-diagnostics preferEffectArray:off -- fakes of the page recording what they were asked in native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterEach, beforeEach, vi } from "vitest";
import { callOf } from "../calls.ts";
import { exitFailure } from "../registry.ts";
import { settled } from "../registry.testing.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";
import {
  composerState,
  copyAtom,
  DOWNLOAD_LINK_MS,
  sessionCommandAtom,
  wideAtom,
} from "./composer-state.ts";
import { conversationKey } from "./conversation.ts";
import { FILE_SEARCH_DEBOUNCE_MS, fileSearchAtom } from "./file-search.ts";

/** A page whose links and clipboard the test watches, and whose width it sets. */
const stubPage = () => {
  const clicked: string[] = [];
  const copied: string[] = [];
  const revoked: string[] = [];
  const media = { matches: false, listeners: new Set<() => void>() };

  vi.stubGlobal("window", {
    location: { href: "https://example.test/sessions/s1" },
    matchMedia: () => ({
      get matches() {
        return media.matches;
      },
      addEventListener: (_type: string, listener: () => void) => {
        media.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        media.listeners.delete(listener);
      },
    }),
  });
  vi.stubGlobal("document", {
    body: { append: () => {} },
    createElement: () => {
      const link = {
        href: "",
        download: "",
        hidden: false,
        click: () => {
          clicked.push(`${link.download} ${link.href}`);
        },
        remove: () => {},
      };

      return link;
    },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: (text: string) =>
        text === "refused"
          ? Promise.reject(new Error("Not allowed"))
          : Promise.resolve().then(() => {
              copied.push(text);
            }),
    },
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });

  const resize = (wide: boolean) =>
    Effect.sync(() => {
      media.matches = wide;

      for (const listener of media.listeners) listener();
    });

  return { clicked, copied, revoked, resize };
};

let page: ReturnType<typeof stubPage>;

beforeEach(() => {
  page = stubPage();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the composer's page and commands", () => {
  it.effect("run a Session command on the conversation, handing its file over as a download", () =>
    Effect.gen(function* () {
      const { registry, latest } = chatRegistry();
      const child = conversationKey("s1", 2);

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(sessionCommandAtom(child));
      yield* settle;
      yield* live(latest());

      registry.set(sessionCommandAtom(child), callOf({ name: "export", args: "" }));
      yield* settle;

      const [command] = sent(latest(), "command");

      expect(command).toMatchObject({ name: "export", args: "", conversationId: 2 });

      yield* latest().say({
        type: "result",
        id: command?.id,
        result: {
          notice: "Exported.",
          file: { name: "session.md", mimeType: "text/markdown", content: "# Hi" },
        },
      });

      const result = yield* settled(registry, sessionCommandAtom(child));

      expect(AsyncResult.getOrElse(result, () => "none")).toBe("Exported.");
      expect(page.clicked).toEqual(["session.md blob:export"]);

      // Safari reads the file after the click returns: the link is kept a while.
      vi.advanceTimersByTime(DOWNLOAD_LINK_MS - 1);
      yield* settle;

      expect(page.revoked).toEqual([]);

      vi.advanceTimersByTime(1);
      yield* settle;

      expect(page.revoked).toEqual(["blob:export"]);
    }),
  );

  it.effect("say why a Session command could not run", () =>
    Effect.gen(function* () {
      const { registry, latest } = chatRegistry();
      const root = conversationKey("s1", undefined);

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(sessionCommandAtom(root));
      yield* settle;
      yield* live(latest());

      registry.set(sessionCommandAtom(root), callOf({ name: "todo", args: "" }));
      yield* settle;
      yield* latest().say({
        type: "error",
        id: sent(latest(), "command")[0]?.id,
        message: "/todo takes clear.",
      });

      const result = yield* settled(registry, sessionCommandAtom(root));

      expect(exitFailure(AsyncResult.toExit(result))).toBe("/todo takes clear.");
    }),
  );

  it.effect("copy through the clipboard, failing when the browser refuses", () =>
    Effect.gen(function* () {
      const { registry } = chatRegistry();

      registry.mount(copyAtom);
      registry.set(copyAtom, callOf("the answer"));

      expect(AsyncResult.isSuccess(yield* settled(registry, copyAtom))).toBe(true);
      expect(page.copied).toEqual(["the answer"]);

      registry.set(copyAtom, callOf("refused"));

      expect(AsyncResult.isFailure(yield* settled(registry, copyAtom))).toBe(true);
    }),
  );

  it.effect("follow the screen's width", () =>
    Effect.gen(function* () {
      const { registry } = chatRegistry();

      registry.mount(wideAtom);

      expect(registry.get(wideAtom)).toBe(false);

      yield* page.resize(true);

      expect(registry.get(wideAtom)).toBe(true);
    }),
  );
});

/** A composer over a fake assistant-ui and input, for the conversation `key`. */
const composerOf = (key = conversationKey("s1", undefined)) => {
  let text = "";
  const listeners = new Set<() => void>();
  const input = { value: "", selectionStart: 0 };

  const told = () => {
    for (const listener of listeners) listener();
  };

  const state = composerState({
    key,
    text: () => text,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    input: () => input,
  });

  return {
    state,
    /** The owner edits: the input shows `next`, the caret at `caret`, and then assistant-ui holds it. */
    type: (next: string, caret = next.length) => {
      input.value = next;
      input.selectionStart = caret;
      text = next;
      told();
    },
    /** The composer sets the text itself: the input shows it only once it renders. */
    setText: (next: string) => {
      text = next;
      told();
    },
  };
};

describe("one composer's state", () => {
  it.effect(
    "takes the owner's caret from the input once assistant-ui holds the text, and drops the note",
    () =>
      Effect.sync(() => {
        const { registry } = chatRegistry();
        const composer = composerOf();
        const { state } = composer;

        registry.mount(state.text);
        registry.set(state.note, { tone: "info", text: "Copied the last answer." });
        composer.type("hello world", 5);

        expect(registry.get(state.text)).toBe("hello world");
        expect(registry.get(state.caret)).toBe(5);
        expect(registry.get(state.note)).toBeNull();
      }),
  );

  it.effect("keeps the caret and the note when the composer sets the text itself", () =>
    Effect.sync(() => {
      const { registry } = chatRegistry();
      const composer = composerOf();
      const { state } = composer;

      registry.mount(state.text);
      composer.type("/copy");
      registry.set(state.note, { tone: "info", text: "Copied the last answer." });
      composer.setText("");

      expect(registry.get(state.text)).toBe("");
      expect(registry.get(state.caret)).toBe(5);
      expect(registry.get(state.note)).toEqual({ tone: "info", text: "Copied the last answer." });
    }),
  );

  it.effect("completes at the caret only while the input has the focus", () =>
    Effect.sync(() => {
      const { registry } = chatRegistry();
      const composer = composerOf();
      const { state } = composer;

      registry.mount(state.trigger);
      composer.type("/co");

      expect(registry.get(state.trigger)).toBeNull();

      registry.set(state.focused, true);

      expect(registry.get(state.trigger)).toMatchObject({ kind: "command", start: 0, query: "co" });
    }),
  );

  it.effect("holds a dismissed menu closed until its trigger goes", () =>
    Effect.sync(() => {
      const { registry } = chatRegistry();
      const composer = composerOf();
      const { state } = composer;

      registry.mount(state.dismissed);
      registry.mount(state.fileQuery);
      registry.set(state.focused, true);
      composer.type("see @sr");

      expect(registry.get(state.fileQuery)).toBe("sr");

      registry.set(state.dismissed, 4);
      composer.type("see @src");

      expect(registry.get(state.dismissed)).toBe(4);
      expect(registry.get(state.fileQuery)).toBeNull();

      composer.type("see ");

      expect(registry.get(state.dismissed)).toBeNull();

      composer.type("see @src");

      expect(registry.get(state.fileQuery)).toBe("src");
    }),
  );

  it.effect("starts a new menu, or a changed query, from its first row", () =>
    Effect.sync(() => {
      const { registry } = chatRegistry();
      const composer = composerOf();
      const { state } = composer;

      registry.mount(state.highlighted);
      registry.set(state.focused, true);
      composer.type("/");
      registry.set(state.highlighted, "command:copy");

      expect(registry.get(state.highlighted)).toBe("command:copy");

      registry.set(state.caret, 1);

      expect(registry.get(state.highlighted)).toBe("command:copy");

      composer.type("/c");

      expect(registry.get(state.highlighted)).toBeNull();
    }),
  );

  it.effect(
    "asks for the catalog as a menu that lists it opens, and searches the `@` menu's files",
    () =>
      Effect.gen(function* () {
        const { registry, latest } = chatRegistry();
        const composer = composerOf();
        const { state } = composer;

        registry.mount(sessionStatusAtom("s1"));
        registry.mount(state.effects);
        // As the composer does: the search runs while its answers are read.
        registry.mount(fileSearchAtom(conversationKey("s1", undefined)));
        yield* settle;
        yield* live(latest());
        registry.set(state.focused, true);
        composer.type("/");
        yield* settle;

        expect(sent(latest(), "catalog")).toHaveLength(1);

        composer.type("@src");
        yield* settle;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS));
        yield* settle;

        expect(sent(latest(), "files")).toMatchObject([{ query: "src" }]);
      }),
  );
});
