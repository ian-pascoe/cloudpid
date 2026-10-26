// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off strictEffectProvide:off -- a fake browser over native arrays, speaking CDP's plain JSON, given to each test's Browser Pane.

import { OWNER_TAB_GONE, type OwnerTabLinks } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { settle } from "../session/client.testing.ts";
import { openBrowserPaneView } from "./browser-pane.ts";
import { fakeBrowser } from "./connection.testing.ts";

/** The Owner tab's history, as `Page.getNavigationHistory` answers it. */
interface History {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

/**
 * A Browser Pane over a fake Browser Run and Session: `owner_tab_view` answers with links to the fake's tab (`T`) until
 * `lose` says the Owner tab is gone, and an ask to open after that says it replaced the one that is gone; `opens` is
 * what each ask said of opening. The tab's history is `history`; `archived` is the Pane's Session's.
 */
const setup = (
  history: History = {
    currentIndex: 0,
    entries: [{ id: 1, url: "https://example.com/", title: "Example" }],
  },
  { archived = false }: { readonly archived?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fake = fakeBrowser({
      answer: (method) => {
        if (method === "Page.getNavigationHistory") {
          return {
            currentIndex: history.currentIndex,
            entries: history.entries.map((entry) => ({ ...entry })),
          };
        }

        return method === "Page.navigate" ? { frameId: "F", loaderId: "L" } : undefined;
      },
    });

    const opens: boolean[] = [];
    let gone = false;

    const mint = (open: boolean) =>
      Effect.suspend(() => {
        opens.push(open);

        if (gone && !open) return Effect.fail({ message: OWNER_TAB_GONE });

        const replaced = gone;

        gone = false;

        return fake.mint.pipe(
          Effect.map((links): OwnerTabLinks => ({
            ownerTabId: "owner-1",
            ...links,
            opened: open,
            replaced,
          })),
        );
      });

    const view = yield* openBrowserPaneView(mint, { opens: !archived }).pipe(
      Effect.provide(fake.layer),
    );

    yield* settle;

    return {
      ...fake,
      view,
      history,
      opens,
      lose: () => {
        gone = true;
      },
      state: () => SubscriptionRef.getUnsafe(view.state),
      page: () => SubscriptionRef.getUnsafe(view.page),
      replaced: () => SubscriptionRef.getUnsafe(view.replaced),
    };
  });

describe("the Browser Pane's view of the Owner tab", () => {
  it.effect("opens the Owner tab on its first ask, and only reads it on a reconnect", () =>
    Effect.gen(function* () {
      const { opens, to, state } = yield* setup();

      expect(state().status).toBe("live");
      expect(opens).toEqual([true]);

      // The connection drops: it asks again, opening nothing.
      yield* to("T")[0]!.drop();
      yield* settle;

      expect(opens).toEqual([true, false]);
      expect(state().status).toBe("live");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "ends when the Owner tab is gone: it was closed, or its browser was closed or replaced",
    () =>
      Effect.gen(function* () {
        const { lose, to, state, opens } = yield* setup();

        lose();
        yield* to("T")[0]!.drop();
        yield* settle;

        expect(opens).toEqual([true, false]);
        expect(state().status).toBe("ended");
      }).pipe(Effect.scoped),
  );

  it.effect("says the Owner tab it opened on replaced one that is gone, until dismissed", () =>
    Effect.gen(function* () {
      expect((yield* setup()).replaced()).toBe(false);

      // The Pane opens (Open a new Owner tab) after the one it showed was lost: the host says it replaced it.
      const fake = fakeBrowser();

      const view = yield* openBrowserPaneView((open: boolean) =>
        fake.mint.pipe(
          Effect.map((links) => ({
            ownerTabId: "owner-2",
            ...links,
            opened: open,
            replaced: open,
          })),
        ),
      ).pipe(Effect.provide(fake.layer));

      yield* settle;

      expect(SubscriptionRef.getUnsafe(view.replaced)).toBe(true);

      // A reconnect neither says it again nor takes it back; the owner dismisses it.
      yield* fake.to("T")[0]!.drop();
      yield* settle;

      expect(SubscriptionRef.getUnsafe(view.replaced)).toBe(true);

      yield* view.dismiss;

      expect(SubscriptionRef.getUnsafe(view.replaced)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("never asks to open in an archived Session", () =>
    Effect.gen(function* () {
      const { opens, to, state } = yield* setup(undefined, { archived: true });

      expect(opens).toEqual([false]);
      expect(state().status).toBe("live");

      yield* to("T")[0]!.drop();
      yield* settle;

      expect(opens).toEqual([false, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("shows the tab's URL as it navigates, and whether it can go back or forward", () =>
    Effect.gen(function* () {
      const { history, page, to } = yield* setup();

      expect(page()).toEqual({
        url: "https://example.com/",
        canGoBack: false,
        canGoForward: false,
      });

      history.entries.push({ id: 2, url: "https://example.com/next", title: "Next" });
      history.currentIndex = 1;
      yield* to("T")[0]!.event("Page.frameNavigated", {
        frame: { id: "F", loaderId: "L", url: "https://example.com/next" },
      });

      expect(page()).toEqual({
        url: "https://example.com/next",
        canGoBack: true,
        canGoForward: false,
      });

      // A frame inside the page is not the tab's URL.
      history.entries.push({ id: 3, url: "https://ads.example/frame", title: "" });
      yield* to("T")[0]!.event("Page.frameNavigated", {
        frame: { id: "G", parentId: "F", loaderId: "L", url: "https://ads.example/frame" },
      });

      expect(page().url).toBe("https://example.com/next");

      // A move within the page (a hash, history.pushState) is.
      history.entries.splice(2, 1, { id: 3, url: "https://example.com/next#b", title: "" });
      history.currentIndex = 2;
      yield* to("T")[0]!.event("Page.navigatedWithinDocument", {
        frameId: "F",
        url: "https://example.com/next#b",
      });

      expect(page().url).toBe("https://example.com/next#b");
    }).pipe(Effect.scoped),
  );

  it.effect("navigates, goes back and forward, and reloads, on the tab's own connection", () =>
    Effect.gen(function* () {
      const { view, history, to } = yield* setup({
        currentIndex: 1,
        entries: [
          { id: 1, url: "https://a.example/", title: "A" },
          { id: 2, url: "https://b.example/", title: "B" },
          { id: 3, url: "https://c.example/", title: "C" },
        ],
      });

      const tab = to("T")[0]!;

      yield* view.navigate("https://d.example/");
      expect(tab.last("Page.navigate")?.params).toEqual({ url: "https://d.example/" });

      yield* view.back;
      expect(tab.last("Page.navigateToHistoryEntry")?.params).toEqual({ entryId: 1 });

      yield* view.forward;
      expect(tab.last("Page.navigateToHistoryEntry")?.params).toEqual({ entryId: 3 });

      yield* view.reload;
      expect(tab.methods().at(-1)).toBe("Page.reload");

      // Nowhere to go back to: nothing is sent.
      history.currentIndex = 0;

      const sent = tab.methods().length;

      yield* view.back;
      expect(tab.methods().slice(sent)).toEqual(["Page.getNavigationHistory"]);
    }).pipe(Effect.scoped),
  );

  it.effect("says why a page could not be opened", () =>
    Effect.gen(function* () {
      const fake = fakeBrowser({
        answer: (method) =>
          method === "Page.navigate"
            ? { frameId: "F", loaderId: "L", errorText: "net::ERR_NAME_NOT_RESOLVED" }
            : undefined,
      });

      const view = yield* openBrowserPaneView((open: boolean) =>
        fake.mint.pipe(
          Effect.map((links) => ({
            ownerTabId: "owner-1",
            ...links,
            opened: open,
            replaced: false,
          })),
        ),
      ).pipe(Effect.provide(fake.layer));

      yield* settle;

      const failure = yield* view.navigate("https://nowhere.invalid/").pipe(Effect.flip);

      expect(failure.message).toContain("net::ERR_NAME_NOT_RESOLVED");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "follows the Owner tab the Session says is shown: it connects afresh only to another one",
    () =>
      Effect.gen(function* () {
        const fake = fakeBrowser();
        const asked: boolean[] = [];
        let shown = "owner-1";

        const view = yield* openBrowserPaneView((open: boolean) =>
          Effect.suspend(() => {
            asked.push(open);

            return fake.mint.pipe(
              Effect.map((links): OwnerTabLinks => ({
                ownerTabId: shown,
                ...links,
                opened: open,
                replaced: false,
              })),
            );
          }),
        ).pipe(Effect.provide(fake.layer));

        yield* settle;

        // The one it shows, none, or no news: nothing happens.
        yield* view.follow("owner-1");
        yield* view.follow(undefined);
        yield* settle;
        expect(asked).toEqual([true]);

        // Another device switched: the links are minted again, for the tab the Session shows.
        shown = "owner-2";
        yield* view.follow("owner-2");
        yield* settle;
        expect(asked).toEqual([true, false]);
        expect(SubscriptionRef.getUnsafe(view.state).status).toBe("live");
        expect(fake.to("T")).toHaveLength(2);

        // It is on that tab now.
        yield* view.follow("owner-2");
        yield* settle;
        expect(asked).toEqual([true, false]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "tells the Pane when a page of the Owner tab opens a window, which may be a tab of its own",
    () =>
      Effect.gen(function* () {
        const fake = fakeBrowser();
        let told = 0;

        yield* openBrowserPaneView(
          (open: boolean) =>
            fake.mint.pipe(
              Effect.map((links): OwnerTabLinks => ({
                ownerTabId: "owner-1",
                ...links,
                opened: open,
                replaced: false,
              })),
            ),
          {
            windowOpened: Effect.sync(() => {
              told += 1;
            }),
          },
        ).pipe(Effect.provide(fake.layer));

        yield* settle;
        yield* fake.to("T")[0]!.event("Page.windowOpen", { url: "https://example.com/next" });
        yield* settle;

        expect(told).toBe(1);
      }).pipe(Effect.scoped),
  );
});
