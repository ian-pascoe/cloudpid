// @effect-diagnostics preferEffectArray:off -- Pane keys in native arrays, as the code under test keeps them.

import { liveViewPaneKey } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  applyPaneAction,
  NO_PANES,
  paneAreaOf,
  paneKeyOf,
  samePaneArea,
  searchWithPaneArea,
  tabForKey,
  type PaneAction,
  type PaneArea,
  type PaneType,
} from "./panes.ts";

/** Pane types for the rules, apart from the app's: the New pane, one open once (`tasks`), two open more than once. */
const TYPES: readonly PaneType[] = [
  { id: "new", multiple: false, label: () => ({ name: "New pane" }) },
  { id: "tasks", multiple: false, label: () => ({ name: "Tasks" }) },
  {
    id: "live-view",
    multiple: true,
    label: (argument) => ({ name: "Live View", agent: argument }),
  },
  { id: "terminal", multiple: true, label: (argument) => ({ name: `Terminal ${argument}` }) },
];

const area = (
  open: readonly string[],
  shown: string | undefined = open[0],
  hidden = false,
): PaneArea => ({ open, shown, hidden });

/** The area after `actions`, one after the other. */
const after = (start: PaneArea, ...actions: PaneAction[]): PaneArea =>
  actions.reduce((current, action) => applyPaneAction(current, action, TYPES), start);

describe("a Pane key", () => {
  it("is a type's ID alone when the type may be open once", () => {
    expect(paneKeyOf("tasks", TYPES)).toMatchObject({ type: { id: "tasks" }, argument: undefined });
    expect(paneKeyOf("tasks:1", TYPES)).toBeUndefined();
  });

  it("is the type's ID and an argument when it may be open more than once", () => {
    expect(paneKeyOf("live-view:r1", TYPES)).toMatchObject({
      type: { id: "live-view" },
      argument: "r1",
    });
    expect(paneKeyOf("live-view", TYPES)).toBeUndefined();
    expect(paneKeyOf("live-view:", TYPES)).toBeUndefined();
  });

  it("keeps a colon in the argument", () => {
    expect(paneKeyOf("terminal:a:b", TYPES)?.argument).toBe("a:b");
  });

  it("is none when no type has the ID", () => {
    expect(paneKeyOf("diff", TYPES)).toBeUndefined();
    expect(paneKeyOf("", TYPES)).toBeUndefined();
  });

  it("knows the Subagents Pane by default", () => {
    expect(paneKeyOf("subagents")?.type.label(undefined, () => undefined)).toEqual({
      name: "Subagents",
    });
    expect(paneKeyOf("terminal:1")).toBeUndefined();
  });

  it("knows a Live View per Browser Handoff, named for a subagent's handoff by the agent", () => {
    const pane = paneKeyOf(liveViewPaneKey("call-7"));

    const agentOfHandoff = (requestId: string) =>
      requestId === "call-7" ? "a2 (scout)" : undefined;

    expect(pane?.argument).toBe("call-7");
    expect(pane?.type.label(pane.argument, agentOfHandoff)).toEqual({
      name: "Live View",
      agent: "a2 (scout)",
    });
    // The root agent's handoff, or one the page does not know (yet): no agent.
    expect(pane?.type.label("call-1", agentOfHandoff)).toEqual({ name: "Live View" });
    expect(paneKeyOf("live-view")).toBeUndefined();
  });
});

describe("two areas", () => {
  it("are the same with the same Panes in the same order, the same one shown, and both hidden or not", () => {
    const open = area(["tasks", "terminal:1"], "terminal:1");

    expect(samePaneArea(open, area(["tasks", "terminal:1"], "terminal:1"))).toBe(true);
    expect(samePaneArea(open, area(["terminal:1", "tasks"], "terminal:1"))).toBe(false);
    expect(samePaneArea(open, area(["tasks", "terminal:1"], "tasks"))).toBe(false);
    expect(samePaneArea(open, area(["tasks", "terminal:1"], "terminal:1", true))).toBe(false);
    expect(samePaneArea(open, area(["tasks"], "terminal:1"))).toBe(false);
  });
});

describe("the area a query holds", () => {
  it("is closed for a query with no Pane", () => {
    expect(paneAreaOf("", TYPES)).toEqual(NO_PANES);
    expect(paneAreaOf("?x=1", TYPES)).toEqual(NO_PANES);
  });

  it("opens the Subagents Pane for a link to the Tasks Pane it replaced", () => {
    expect(paneAreaOf("?pane=tree&pane=tasks&shown=tasks")).toEqual(
      area(["tree", "subagents"], "subagents"),
    );
    expect(paneAreaOf("?pane=tasks&pane=subagents")).toEqual(area(["subagents"]));
  });

  it("shows the only Pane, or the first when none is named", () => {
    expect(paneAreaOf("?pane=tasks", TYPES)).toEqual(area(["tasks"]));
    expect(paneAreaOf("?pane=tasks&pane=terminal:1", TYPES)).toEqual(
      area(["tasks", "terminal:1"], "tasks"),
    );
  });

  it("shows the one named", () => {
    expect(paneAreaOf("?pane=tasks&pane=terminal:1&shown=terminal:1", TYPES)).toEqual(
      area(["tasks", "terminal:1"], "terminal:1"),
    );
  });

  it("opens what it can of a stale or edited link", () => {
    // An unknown type, a key missing its argument, a repeat, and a shown Pane that is not open.
    expect(
      paneAreaOf(
        "?pane=diff&pane=tasks&pane=live-view&pane=tasks&pane=terminal:1&shown=gone",
        TYPES,
      ),
    ).toEqual(area(["tasks", "terminal:1"], "tasks"));
    expect(paneAreaOf("?pane=diff", TYPES)).toEqual(NO_PANES);
    expect(paneAreaOf("?shown=tasks", TYPES)).toEqual(NO_PANES);
  });

  it("is hidden with `panes=hidden`, only while a Pane is open", () => {
    expect(paneAreaOf("?pane=tasks&panes=hidden", TYPES)).toEqual(area(["tasks"], "tasks", true));
    expect(paneAreaOf("?panes=hidden", TYPES)).toEqual(NO_PANES);
  });

  it("is written back as it was read", () => {
    for (const search of [
      "?pane=tasks",
      "?pane=tasks&pane=terminal:1",
      "?pane=tasks&pane=live-view:r1&pane=live-view:r2&shown=live-view:r2",
      "?pane=tasks&pane=terminal:1&shown=terminal:1&panes=hidden",
    ]) {
      expect(searchWithPaneArea("", paneAreaOf(search, TYPES))).toBe(search);
    }
  });

  it("is written beside the other parameters, and with none when closed", () => {
    expect(searchWithPaneArea("?x=1", area(["tasks"]))).toBe("?x=1&pane=tasks");
    expect(searchWithPaneArea("?x=1&pane=tasks", NO_PANES)).toBe("?x=1");
    expect(searchWithPaneArea("?pane=tasks", NO_PANES)).toBe("");
  });
});

describe("opening a Pane", () => {
  it("opens the area on it", () => {
    expect(after(NO_PANES, { type: "open", key: "tasks" })).toEqual(area(["tasks"]));
  });

  it("adds a tab after the others and shows it", () => {
    expect(after(area(["tasks"]), { type: "open", key: "terminal:1" })).toEqual(
      area(["tasks", "terminal:1"], "terminal:1"),
    );
  });

  it("shows a Pane that is open already, without a second tab or a move", () => {
    const open = area(["tasks", "terminal:1"], "terminal:1");

    expect(after(open, { type: "open", key: "tasks" })).toEqual(
      area(["tasks", "terminal:1"], "tasks"),
    );
  });

  it("opens a type that may be open more than once under each argument", () => {
    expect(
      after(
        NO_PANES,
        { type: "open", key: "live-view:r1" },
        { type: "open", key: "live-view:r2" },
        { type: "open", key: "live-view:r1" },
      ),
    ).toEqual(area(["live-view:r1", "live-view:r2"], "live-view:r1"));
  });

  it("does nothing for a key no type can open", () => {
    const open = area(["tasks"]);

    expect(after(open, { type: "open", key: "diff" })).toBe(open);
    expect(after(open, { type: "open", key: "live-view" })).toBe(open);
    expect(after(NO_PANES, { type: "open", key: "tasks:1" })).toBe(NO_PANES);
  });
});

describe("closing a Pane", () => {
  const three = area(["tasks", "terminal:1", "terminal:2"], "terminal:1");

  it("closes the area with its last Pane", () => {
    expect(after(area(["tasks"]), { type: "close", key: "tasks" })).toEqual(NO_PANES);
  });

  it("keeps the one shown when another goes", () => {
    expect(after(three, { type: "close", key: "terminal:2" })).toEqual(
      area(["tasks", "terminal:1"], "terminal:1"),
    );
    expect(after(three, { type: "close", key: "tasks" })).toEqual(
      area(["terminal:1", "terminal:2"], "terminal:1"),
    );
  });

  it("shows the next tab when the one shown goes", () => {
    expect(after(three, { type: "close", key: "terminal:1" })).toEqual(
      area(["tasks", "terminal:2"], "terminal:2"),
    );
  });

  it("shows the one before when the last tab, shown, goes", () => {
    expect(
      after(area(["tasks", "terminal:1"], "terminal:1"), { type: "close", key: "terminal:1" }),
    ).toEqual(area(["tasks"], "tasks"));
  });

  it("does nothing for a Pane that is not open", () => {
    expect(after(three, { type: "close", key: "live-view:r1" })).toBe(three);
    expect(after(NO_PANES, { type: "close", key: "tasks" })).toBe(NO_PANES);
  });
});

describe("switching Panes", () => {
  const two = area(["tasks", "terminal:1"], "tasks");

  it("shows an open Pane, leaving the order", () => {
    expect(after(two, { type: "show", key: "terminal:1" })).toEqual(
      area(["tasks", "terminal:1"], "terminal:1"),
    );
  });

  it("does not open a Pane that is not open", () => {
    expect(after(two, { type: "show", key: "live-view:r1" })).toBe(two);
  });
});

describe("the area's button", () => {
  it("opens the New pane when no Pane is open", () => {
    expect(after(NO_PANES, { type: "toggleArea" })).toEqual(area(["new"]));
  });

  it("hides the area with its Panes kept, and shows it again as it was", () => {
    const two = area(["tasks", "terminal:1"], "terminal:1");
    const hidden = after(two, { type: "toggleArea" });

    expect(hidden).toEqual(area(["tasks", "terminal:1"], "terminal:1", true));
    expect(after(hidden, { type: "toggleArea" })).toEqual(two);
  });
});

describe("a hidden area", () => {
  const hidden = area(["tasks", "terminal:1"], "tasks", true);

  it("is hidden by `hide`, which leaves a closed or hidden area alone", () => {
    expect(after(area(["tasks"]), { type: "hide" })).toEqual(area(["tasks"], "tasks", true));
    expect(after(hidden, { type: "hide" })).toBe(hidden);
    expect(after(NO_PANES, { type: "hide" })).toBe(NO_PANES);
  });

  it("shows again when a Pane is opened or shown", () => {
    expect(after(hidden, { type: "open", key: "live-view:r1" })).toEqual(
      area(["tasks", "terminal:1", "live-view:r1"], "live-view:r1"),
    );
    expect(after(hidden, { type: "open", key: "tasks" })).toEqual(
      area(["tasks", "terminal:1"], "tasks"),
    );
    expect(after(hidden, { type: "show", key: "terminal:1" })).toEqual(
      area(["tasks", "terminal:1"], "terminal:1"),
    );
  });

  it("stays hidden when a Pane closes, and is closed with the last", () => {
    expect(after(hidden, { type: "close", key: "tasks" })).toEqual(
      area(["terminal:1"], "terminal:1", true),
    );
    expect(
      after(hidden, { type: "close", key: "tasks" }, { type: "close", key: "terminal:1" }),
    ).toEqual(NO_PANES);
  });
});

describe("the New pane's pick", () => {
  it("takes the New pane's tab, in its place, and is shown", () => {
    expect(
      after(area(["tasks", "new", "terminal:1"], "new"), {
        type: "replace",
        key: "new",
        by: "terminal:2",
      }),
    ).toEqual(area(["tasks", "terminal:2", "terminal:1"], "terminal:2"));
  });

  it("shows a Pane open already, and the New pane goes", () => {
    expect(
      after(area(["tasks", "new"], "new"), { type: "replace", key: "new", by: "tasks" }),
    ).toEqual(area(["tasks"]));
  });

  it("does nothing when the New pane is not open or the pick is no Pane", () => {
    const open = area(["tasks", "new"], "new");

    expect(after(open, { type: "replace", key: "terminal:1", by: "tasks" })).toBe(open);
    expect(after(open, { type: "replace", key: "new", by: "diff" })).toBe(open);
  });
});

describe("the tab a key moves to", () => {
  const three = area(["tasks", "terminal:1", "terminal:2"], "terminal:1");

  it("steps with the arrows, wrapping at the ends", () => {
    expect(tabForKey(three, "ArrowRight")).toBe("terminal:2");
    expect(tabForKey(three, "ArrowLeft")).toBe("tasks");
    expect(tabForKey(area(three.open, "terminal:2"), "ArrowRight")).toBe("tasks");
    expect(tabForKey(area(three.open, "tasks"), "ArrowLeft")).toBe("terminal:2");
  });

  it("goes to the ends with Home and End", () => {
    expect(tabForKey(three, "Home")).toBe("tasks");
    expect(tabForKey(three, "End")).toBe("terminal:2");
  });

  it("is none for another key", () => {
    expect(tabForKey(three, "a")).toBeUndefined();
    expect(tabForKey(three, "ArrowDown")).toBeUndefined();
  });
});
