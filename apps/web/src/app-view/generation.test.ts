// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live).
// @effect-diagnostics preferEffectArray:off -- messages and entries in native lists.
import type { McpAppEntry, TranscriptMessage } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { callsOfScript, isAppLive, liveGeneration, STRIP_ROWS, stripRows } from "./generation.ts";

const assistant = (...calls: string[]): TranscriptMessage => ({
  id: calls.join(),
  role: "assistant",
  timestamp: 0,
  parts: calls.map((id) => ({ type: "tool-call", id, name: "x", arguments: {} })),
});

const user: TranscriptMessage = {
  id: "u",
  role: "user",
  timestamp: 0,
  parts: [{ type: "text", text: "go" }],
};

let clock = 0;

const entry = (callId: string, server = "docs", more: Partial<McpAppEntry> = {}): McpAppEntry => ({
  callId,
  server,
  tool: "page",
  state: "kept",
  at: (clock += 1),
  ...more,
});

const live = (messages: TranscriptMessage[], apps: McpAppEntry[]) => [
  ...liveGeneration(messages, apps),
];

describe("the generation rule", () => {
  it("makes live the App calls of the latest assistant message that made any, so an older one collapses", () => {
    const messages = [user, assistant("a"), user, assistant("b", "c")];

    expect(live(messages, [entry("a"), entry("b"), entry("c")])).toEqual(["b", "c"]);
  });

  it("counts a model answer, not a turn: a turn that calls an App again has two generations", () => {
    // One turn, `a` answered, then the model called again.
    const messages = [user, assistant("a"), assistant("b")];

    expect(live(messages, [entry("a"), entry("b")])).toEqual(["b"]);
  });

  it("keeps a message that made no App call out of it: the newest generation is the latest that made any", () => {
    const messages = [user, assistant("a"), assistant("plain"), user, assistant("other")];

    expect(live(messages, [entry("a")])).toEqual(["a"]);
  });

  it("is per server: a newer generation of one server leaves another's alone", () => {
    const messages = [assistant("a"), assistant("b")];

    expect(live(messages, [entry("a", "docs"), entry("b", "maps")]).sort()).toEqual(["a", "b"]);
  });

  it("counts an evicted record in a newer generation, which collapses the older", () => {
    const messages = [assistant("a"), assistant("b")];

    expect(live(messages, [entry("a"), entry("b", "docs", { state: "evicted" })])).toEqual(["b"]);
  });

  it("is, within a codemode script, the last call per server", () => {
    const messages = [assistant("script")];
    const nested = { parentCall: "script" };

    expect(
      live(messages, [
        entry("n1", "docs", nested),
        entry("n2", "maps", nested),
        entry("n3", "docs", nested),
      ]).sort(),
    ).toEqual(["n2", "n3"]);
  });

  it("takes a script's calls as its message's: a later message's direct call retires the script's", () => {
    const messages = [assistant("script"), assistant("direct")];

    expect(
      live(messages, [entry("n1", "docs", { parentCall: "script" }), entry("direct")]),
    ).toEqual(["direct"]);
  });

  it("takes a direct call and a script's last call of one message together", () => {
    const messages = [assistant("direct", "script")];

    expect(
      live(messages, [
        entry("direct"),
        entry("n1", "docs", { parentCall: "script" }),
        entry("n2", "docs", { parentCall: "script" }),
      ]).sort(),
    ).toEqual(["direct", "n2"]);
  });

  it("ignores a call whose message is not loaded, which must not collapse the ones that are", () => {
    const messages = [assistant("a")];

    expect(live(messages, [entry("a"), entry("gone")])).toEqual(["a"]);
  });

  it("is empty with no App call", () => {
    expect(live([assistant("a")], [])).toEqual([]);
  });
});

describe("whether a View is live", () => {
  const base = { newest: true, choice: undefined, archived: false, focused: false } as const;

  it("is live when it is in the newest generation and collapsed when it is not", () => {
    expect(isAppLive(base)).toBe(true);
    expect(isAppLive({ ...base, newest: false })).toBe(false);
  });

  it("lets Reopen keep an older View live and Collapse end a newest one, whatever the generation says", () => {
    expect(isAppLive({ ...base, newest: false, choice: "open" })).toBe(true);
    expect(isAppLive({ ...base, choice: "collapsed" })).toBe(false);
  });

  it("never collapses a View the owner is using for a newer generation", () => {
    expect(isAppLive({ ...base, newest: false, focused: true })).toBe(true);
    // ...but the owner's own Collapse still does.
    expect(isAppLive({ ...base, newest: false, focused: true, choice: "collapsed" })).toBe(false);
  });

  it("is collapsed in an archived Session until it is reopened", () => {
    expect(isAppLive({ ...base, archived: true })).toBe(false);
    expect(isAppLive({ ...base, archived: true, focused: true })).toBe(false);
    expect(isAppLive({ ...base, archived: true, choice: "open" })).toBe(true);
  });
});

describe("a codemode script's strip", () => {
  it("lists the App calls the script made, in order, and nothing of other calls", () => {
    const apps = [
      entry("a", "docs", { parentCall: "script" }),
      entry("direct"),
      entry("b", "maps", { parentCall: "script" }),
      entry("c", "docs", { parentCall: "other" }),
    ];

    expect(callsOfScript(apps, "script").map((each) => each.callId)).toEqual(["a", "b"]);
    expect(callsOfScript(apps, "none")).toEqual([]);
  });

  it("lists every call of a script that made very many, none cut off", () => {
    const apps = Array.from({ length: STRIP_ROWS + 5 }, (_, n) =>
      entry(`n${n}`, "docs", { parentCall: "script" }),
    );

    expect(callsOfScript(apps, "script")).toHaveLength(STRIP_ROWS + 5);
  });
});

describe("the rows a strip shows", () => {
  const many = Array.from({ length: STRIP_ROWS + 5 }, (_, n) =>
    entry(`n${n}`, "docs", { parentCall: "script" }),
  );

  it("shows the last rows, and counts the earlier ones behind an expander", () => {
    const { shown, earlier } = stripRows(many, new Set(), new Set(), false);

    expect(shown).toHaveLength(STRIP_ROWS);
    expect(shown[0]?.callId).toBe("n5");
    expect(earlier).toBe(5);
  });

  it("shows a live call whatever its place, liveness having been decided over all the calls", () => {
    const messages = [assistant("script")];
    const apps = [...many, entry("first", "maps", { parentCall: "script", at: 0 })];
    const liveOnes = liveGeneration(messages, apps);

    // `n24` is the last of its server and `first` the only one of its: both live, `first` far from the end.
    expect([...liveOnes].sort()).toEqual(["first", "n24"]);

    const { shown, earlier } = stripRows(callsOfScript(apps, "script"), liveOnes, new Set(), false);

    expect(shown.map((each) => each.callId)).toContain("first");
    expect(earlier).toBe(apps.length - shown.length);
  });

  it("shows a row the owner reopened on this device, so a reload does not hide a reopened early View", () => {
    const { shown, earlier } = stripRows(many, new Set(), new Set(["n0"]), false);

    expect(shown.map((each) => each.callId)).toContain("n0");
    expect(shown).toHaveLength(STRIP_ROWS + 1);
    expect(earlier).toBe(4);
  });

  it("shows everything once expanded, and every row of a short strip", () => {
    expect(stripRows(many, new Set(), new Set(), true)).toEqual({ shown: many, earlier: 0 });
    expect(stripRows(many.slice(0, 3), new Set(), new Set(), false).earlier).toBe(0);
  });
});
