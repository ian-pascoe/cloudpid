// @effect-diagnostics preferEffectArray:off -- fakes of the page recording what they were asked in native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterEach, beforeEach, vi } from "vitest";
import { exitFailure } from "../registry.ts";
import { settled } from "../registry.testing.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";
import { copyAtom, DOWNLOAD_LINK_MS, sessionCommandAtom, wideAtom } from "./composer-state.ts";
import { conversationKey } from "./conversation.ts";

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

      registry.set(sessionCommandAtom(child), { name: "export", args: "" });
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

      registry.set(sessionCommandAtom(root), { name: "todo", args: "" });
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
      registry.set(copyAtom, "the answer");

      expect(AsyncResult.isSuccess(yield* settled(registry, copyAtom))).toBe(true);
      expect(page.copied).toEqual(["the answer"]);

      registry.set(copyAtom, "refused");

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
