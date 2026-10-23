// @effect-diagnostics preferEffectArray:off -- Pane keys in native arrays, as the code under test keeps them.

import { liveViewPaneKey } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  applyPaneAction,
  NO_PANES,
  paneAreaOf,
  paneKeyOf,
  searchWithPaneArea,
  tabForKey,
  type PaneAction,
  type PaneArea,
  type PaneType,
} from "./panes.ts";

/** The types the later Panes will register, with the Tasks Pane that exists. */
const TYPES: readonly PaneType[] = [
  { id: "tasks", multiple: false, label: () => ({ name: "Tasks" }) },
  {
    id: "live-view",
    multiple: true,
    label: (argument) => ({ name: "Live View", agent: argument }),
  },
  { id: "terminal", multiple: true, label: (argument) => ({ name: `Terminal ${argument}` }) },
];

const area = (open: readonly string[], shown: string | undefined = open[0]): PaneArea => ({
  open,
  shown,
});

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

  it("knows the Tasks Pane by default", () => {
    expect(paneKeyOf("tasks")?.type.label(undefined, () => undefined)).toEqual({
      name: "Tasks",
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

describe("the area a query holds", () => {
  it("is closed for a query with no Pane", () => {
    expect(paneAreaOf("", TYPES)).toEqual(NO_PANES);
    expect(paneAreaOf("?x=1", TYPES)).toEqual(NO_PANES);
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

  it("is written back as it was read", () => {
    for (const search of [
      "?pane=tasks",
      "?pane=tasks&pane=terminal:1",
      "?pane=tasks&pane=live-view:r1&pane=live-view:r2&shown=live-view:r2",
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

describe("a Pane's toggle", () => {
  it("opens the Pane, shows it when another is shown, and closes it when it is the one shown", () => {
    const opened = after(NO_PANES, { type: "toggle", key: "tasks" });

    expect(opened).toEqual(area(["tasks"]));

    const other = after(opened, { type: "open", key: "terminal:1" });

    expect(after(other, { type: "toggle", key: "tasks" })).toEqual(
      area(["tasks", "terminal:1"], "tasks"),
    );
    expect(
      after(other, { type: "toggle", key: "tasks" }, { type: "toggle", key: "tasks" }),
    ).toEqual(area(["terminal:1"]));
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
