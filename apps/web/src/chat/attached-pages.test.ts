// What the composer offers to attach: the Session's Owner tabs with their titles, and what attaching one takes.
// @effect-diagnostics preferEffectArray:off asyncFunction:off -- assertions over what the fakes recorded, in native arrays.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { ownerTabsAtom, sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import {
  askOwnerTabsAtom,
  type OfferedPage,
  offeredPages,
  pageHost,
  pageLabel,
  toAttach,
} from "./attached-pages.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";

const SHOWN: OfferedPage = { ownerTabId: "tab-1", title: "Guide", shown: true };

const OTHER: OfferedPage = { ownerTabId: "tab-2", title: "", shown: false };

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pages a composer offers to attach", () => {
  const LISTING = {
    tabs: [
      { id: "tab-2", title: "" },
      { id: "tab-1", title: "Guide" },
    ],
    shown: "tab-1",
  };

  it.effect(
    "are the Session's Owner tabs, asked for when a composer opens and again on refresh, the one shown first",
    () =>
      Effect.gen(function* () {
        const chat = chatRegistry();

        chat.registry.mount(sessionStatusAtom("s1"));
        chat.registry.mount(askOwnerTabsAtom("s1"));
        yield* settle;
        yield* live(chat.latest());

        expect(offeredPages(chat.registry.get(ownerTabsAtom("s1")))).toEqual([]);

        const [ask] = sent(chat.latest(), "owner_tab_list");

        expect(ask).toBeDefined();
        yield* chat.latest().say({ type: "result", id: ask?.id, result: LISTING });
        expect(offeredPages(chat.registry.get(ownerTabsAtom("s1")))).toEqual([SHOWN, OTHER]);

        // Opening the menu asks again.
        chat.registry.refresh(askOwnerTabsAtom("s1"));
        yield* settle;

        expect(sent(chat.latest(), "owner_tab_list")).toHaveLength(2);
      }),
  );

  it.effect("are none when the Session cannot say", () =>
    Effect.gen(function* () {
      const chat = chatRegistry();

      chat.registry.mount(sessionStatusAtom("s1"));
      chat.registry.mount(askOwnerTabsAtom("s1"));
      yield* settle;
      yield* live(chat.latest());

      const [ask] = sent(chat.latest(), "owner_tab_list");

      yield* chat.latest().say({ type: "error", id: ask?.id, message: "unreachable" });

      expect(offeredPages(chat.registry.get(ownerTabsAtom("s1")))).toEqual([]);
    }),
  );

  it("name a page by its title, else that it has none, and a URL by its host", () => {
    expect(pageLabel(SHOWN)).toBe("Guide");
    expect(pageLabel(OTHER)).toBe("Untitled page");
    expect(pageHost("https://docs.example.com/guide?x=1")).toBe("docs.example.com");
    expect(pageHost("not a url")).toBe("not a url");
  });
});

describe("attaching a page", () => {
  const frame = {
    targetId: "page",
    data: btoa("jpeg bytes"),
    metadata: {
      deviceWidth: 1,
      deviceHeight: 1,
      offsetTop: 0,
      pageScaleFactor: 1,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  };

  it("takes the Browser Pane's latest screen with the Owner tab it shows, and no picture with another", async () => {
    const shown = toAttach(SHOWN, frame);
    const other = toAttach(OTHER, frame);

    expect(shown).toMatchObject({ ownerTabId: "tab-1", title: "Guide", shown: true });
    expect(await shown.screen?.text()).toBe("jpeg bytes");
    expect(other).toMatchObject({ ownerTabId: "tab-2", shown: false, screen: undefined });
  });

  it("takes no picture when no Browser Pane is open on the Session (no frame)", () => {
    expect(toAttach(SHOWN, undefined).screen).toBeUndefined();
  });
});
