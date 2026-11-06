// docs/architecture/mcp-apps.md → App Views in the transcript (Where it renders, Remounting), App Panes. Which place mounts
// a View, how it moves, and that the next place mounts only once the last one's frame has gone.
import { describe, expect, it } from "vitest";
import { AppPlaces, PLACE_NAMES, placeKey, type AppPlace } from "./places.ts";

/** A store, and a way to make a place that claims a call and wants its View. */
const setup = () => {
  const places = new AppPlaces();

  const place = (id: string, callId: string, kind: AppPlace, live = true) => {
    places.claim(id, callId, kind);
    places.update(id, live);
  };

  return { places, place };
};

describe("which place mounts a View", () => {
  it("mounts a live claim's View, and none for one that wants none", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    expect(places.viewOf("card")).toMatchObject({ kind: "hosting", closing: false });

    place("other", "c2", "card", false);
    expect(places.viewOf("other")).toEqual({ kind: "none" });
  });

  it("prefers an App Pane to a Subagent Pane or page to a card: one mount per page", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    place("sub", "c1", "subagent-pane");

    // The card's frame is told to close, and the Subagent Pane's is next.
    expect(places.viewOf("card")).toMatchObject({ kind: "hosting", closing: true });
    expect(places.viewOf("sub")).toEqual({ kind: "waiting" });

    places.closed("card");
    expect(places.viewOf("sub")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("card")).toEqual({ kind: "elsewhere", place: "subagent-pane" });

    place("pane", "c1", "app-pane");
    places.closed("sub");
    expect(places.viewOf("pane")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("sub")).toEqual({ kind: "elsewhere", place: "app-pane" });
    expect(places.viewOf("card")).toEqual({ kind: "elsewhere", place: "app-pane" });
  });

  it("keeps a Subagent page and a Subagent Pane alike: the one that has it keeps it", () => {
    const { places, place } = setup();

    place("page", "c1", "subagent-page");
    place("pane", "c1", "subagent-pane");

    expect(places.viewOf("page")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("pane")).toEqual({ kind: "elsewhere", place: "subagent-page" });
  });

  it("keeps one call's places apart from another's", () => {
    const { places, place } = setup();

    place("one", "c1", "card");
    place("two", "c2", "card");

    expect(places.viewOf("one")).toMatchObject({ kind: "hosting" });
    expect(places.viewOf("two")).toMatchObject({ kind: "hosting" });
  });
});

describe("moving a View between places: teardown first", () => {
  it("closes the card's frame when an App Pane opens, and mounts the Pane's only once that has gone", () => {
    const { places, place } = setup();

    place("card", "c1", "card");

    const first = places.viewOf("card");

    place("pane", "c1", "app-pane");

    expect(places.viewOf("card")).toMatchObject({ kind: "hosting", closing: true });
    expect(places.viewOf("pane")).toEqual({ kind: "waiting" });

    places.closed("card");

    const second = places.viewOf("pane");

    expect(second).toMatchObject({ kind: "hosting", closing: false });
    expect(first.kind === "hosting" && second.kind === "hosting" && second.key !== first.key).toBe(
      true,
    );
  });

  it("moves it back to the card when the App Pane is unmounted, whose frame went with it", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    place("pane", "c1", "app-pane");
    places.closed("card");
    places.release("pane");

    expect(places.viewOf("card")).toMatchObject({ kind: "hosting", closing: false });
  });

  it("closes a collapsed place's frame, which stays until its View has torn down", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    places.update("card", false);

    expect(places.viewOf("card")).toMatchObject({ kind: "hosting", closing: true });

    places.closed("card");
    expect(places.viewOf("card")).toEqual({ kind: "none" });
  });

  it("mounts a new frame for a place that wants its View again after it closed, never the dead one", () => {
    const { places, place } = setup();

    place("card", "c1", "card");

    const first = places.viewOf("card");

    places.update("card", false);
    places.closed("card");
    places.update("card", true);

    const again = places.viewOf("card");

    expect(again).toMatchObject({ kind: "hosting", closing: false });
    expect(again).not.toEqual(first);
  });

  it("takes a place unmounting as its frame gone: the next one is mounted at once, and none waits for the dead", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    place("pane", "c1", "app-pane");
    // The card's frame is closing when the whole page goes.
    places.release("card");

    expect(places.viewOf("pane")).toMatchObject({ kind: "hosting", closing: false });
  });

  it("hands a place that unmounts and mounts again in one commit (a key change) a frame of its own", () => {
    const { places, place } = setup();

    place("card", "c1", "card");
    places.release("card");
    place("card2", "c1", "card");

    expect(places.viewOf("card2")).toMatchObject({ kind: "hosting", closing: false });
  });

  it("tells its subscribers of each change, and names a place's view as a value", () => {
    const { places, place } = setup();
    let told = 0;

    places.subscribe(() => {
      told += 1;
    });
    place("card", "c1", "card");

    expect(told).toBeGreaterThan(0);

    const key = places.viewKey("card");

    places.update("card", true);
    expect(places.viewKey("card")).toBe(key);
  });
});

describe("a call's key", () => {
  it("keeps an App View's call and a Visual's of the same ID apart, one mount each", () => {
    const { places, place } = setup();

    place("app-card", placeKey("app", "c1"), "card");
    place("visual-card", placeKey("visual", "c1"), "card");

    expect(places.viewOf("app-card")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("visual-card")).toMatchObject({ kind: "hosting", closing: false });
  });
});

describe("a Visual's places", () => {
  it("mounts a Visual Pane's frame over a Subagent Pane's or a card's, which say where it is shown, and gives it back when the Pane goes", () => {
    const { places, place } = setup();
    const key = placeKey("visual", "c1");

    place("card", key, "card");
    place("sub", key, "subagent-pane");
    places.closed("card");
    place("pane", key, "visual-pane");
    places.closed("sub");

    expect(places.viewOf("pane")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("sub")).toEqual({ kind: "elsewhere", place: "visual-pane" });
    expect(places.viewOf("card")).toEqual({ kind: "elsewhere", place: "visual-pane" });
    expect(PLACE_NAMES["visual-pane"]).toBe("the Visual Pane");

    // Show here: the Pane closes, and the Subagent Pane's thread, the higher of the two, mounts it next.
    places.release("pane");
    expect(places.viewOf("sub")).toMatchObject({ kind: "hosting", closing: false });
    expect(places.viewOf("card")).toEqual({ kind: "elsewhere", place: "subagent-pane" });
  });
});
