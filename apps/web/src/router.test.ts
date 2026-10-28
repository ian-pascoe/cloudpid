import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubWindow } from "./router.testing.ts";
import {
  navigate,
  pageAtom,
  paneParamsOf,
  pathAtom,
  replaceSearch,
  searchAtom,
  sessionIdAtom,
  isDraftPath,
  legacyRedirect,
  SETTINGS_PATH,
  sessionIdOf,
  sessionPath,
  DRAFT_PATH,
  withPaneParams,
  agentIdOf,
  pageOf,
  settingsPath,
  subagentPath,
  skillOwnerPath,
  skillPagePath,
  skillRepoParamsAtom,
  skillRepoParamsOf,
  skillRepoPath,
  skillsParamsAtom,
  skillsParamsOf,
  skillsPath,
} from "./router.ts";

/** Global's Scope, as the Registry names it. */
const GLOBAL = "*";

describe("Session paths", () => {
  it("round-trip a Session ID", () => {
    expect(sessionIdOf(sessionPath("0198f0a2-7b1c-7000-8000-000000000001"))).toBe(
      "0198f0a2-7b1c-7000-8000-000000000001",
    );
  });

  it("are the only paths that show a Session", () => {
    expect(sessionIdOf("/")).toBeUndefined();
    expect(sessionIdOf("/sessions")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/socket")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/")).toBe("abc");
  });
});

describe("Subagent page paths", () => {
  it("round-trip a Session ID and an agent's canonical ID, encoded", () => {
    const path = subagentPath("s 1", "agent-1.reviewer");

    expect(path).toBe("/sessions/s%201/agents/agent-1.reviewer");
    expect(agentIdOf(path)).toBe("agent-1.reviewer");
    expect(agentIdOf(subagentPath("a", "agent-2/odd name"))).toBe("agent-2/odd name");
  });

  it("show their Session, as the page is of one of its subagents", () => {
    expect(sessionIdOf(subagentPath("abc", "agent-1"))).toBe("abc");
    expect(sessionIdOf("/sessions/abc/agents/agent-1/")).toBe("abc");
    expect(agentIdOf("/sessions/abc/agents/agent-1/")).toBe("agent-1");
  });

  it("name no subagent on any other path", () => {
    expect(agentIdOf(sessionPath("abc"))).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents")).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents/")).toBeUndefined();
    expect(agentIdOf("/sessions/abc/agents/a/b")).toBeUndefined();
    expect(sessionIdOf("/sessions/abc/agents/a/b")).toBeUndefined();
    expect(agentIdOf(SETTINGS_PATH)).toBeUndefined();
  });

  it("are a page of their own kind", () => {
    expect(pageOf(subagentPath("abc", "agent-1"))).toEqual({
      kind: "subagent",
      sessionId: "abc",
      agentId: "agent-1",
    });
    expect(pageOf(sessionPath("abc"))).toEqual({ kind: "session", sessionId: "abc" });
  });

  it("keep a path that cannot be decoded from showing anything", () => {
    expect(pageOf("/sessions/abc/agents/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/sessions/%E0%A4%A")).toEqual({ kind: "empty" });
  });
});

describe("the Settings page's paths", () => {
  it("show the list of Global's sections at /settings, and no Session", () => {
    const index = { kind: "settings", scope: GLOBAL, view: { kind: "index" } };

    expect(pageOf(SETTINGS_PATH)).toEqual(index);
    expect(pageOf("/settings/")).toEqual(index);
    expect(pageOf("/settings/all")).toEqual(index);
    expect(sessionIdOf(SETTINGS_PATH)).toBeUndefined();
    expect(pageOf("/sessions/settings")).toEqual({ kind: "session", sessionId: "settings" });
  });

  it("name the Scope, `all` for Global or an Environment's id, then the section", () => {
    expect(pageOf("/settings/all/models")).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "section", section: "models" },
    });
    expect(pageOf("/settings/1a2b3c4d/container/")).toEqual({
      kind: "settings",
      scope: "1a2b3c4d",
      view: { kind: "section", section: "container" },
    });
    expect(pageOf("/settings/default")).toEqual({
      kind: "settings",
      scope: "default",
      view: { kind: "index" },
    });
  });

  it("are written with `all` for Global, and round-trip", () => {
    expect(settingsPath(GLOBAL)).toBe("/settings/all");
    expect(settingsPath(GLOBAL, "general")).toBe("/settings/all/general");
    expect(settingsPath("1a2b3c4d", "environments")).toBe("/settings/1a2b3c4d/environments");
    expect(pageOf(settingsPath("a b", "limits"))).toEqual({
      kind: "settings",
      scope: "a b",
      view: { kind: "section", section: "limits" },
    });
  });

  it("show the Skill directory below a Scope's Skills: an owner, a repo, then one Skill", () => {
    expect(pageOf("/settings/all/skills/mattpocock")).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "skillOwner", owner: "mattpocock" },
    });
    expect(pageOf("/settings/work/skills/mattpocock/skills")).toEqual({
      kind: "settings",
      scope: "work",
      view: { kind: "skillRepo", owner: "mattpocock", repo: "skills" },
    });
    expect(pageOf("/settings/all/skills/mattpocock/skills/grill-me/")).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "skill", owner: "mattpocock", repo: "skills", skill: "grill-me" },
    });
    expect(pageOf("/settings/all/skills/a/b/c/d")).toEqual({ kind: "empty" });
    // Only the Skills section has pages below it.
    expect(pageOf("/settings/all/models/x")).toEqual({ kind: "empty" });
  });

  it("take an owner named like a tab as an owner", () => {
    for (const owner of ["installed", "all-time", "trending", "hot"]) {
      expect(skillOwnerPath(GLOBAL, owner)).toBe(`/settings/all/skills/${owner}`);
      expect(pageOf(skillOwnerPath(GLOBAL, owner))).toEqual({
        kind: "settings",
        scope: GLOBAL,
        view: { kind: "skillOwner", owner },
      });
    }
  });

  it("round-trip an owner, a repo and a Skill, encoded, at the Scope named", () => {
    expect(skillOwnerPath("work", "o w")).toBe("/settings/work/skills/o%20w");
    expect(skillRepoPath(GLOBAL, "o", "r.js")).toBe("/settings/all/skills/o/r.js");
    expect(pageOf(skillRepoPath(GLOBAL, "o", "a/b"))).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "skillRepo", owner: "o", repo: "a/b" },
    });
    expect(pageOf(skillPagePath("work", "o", "r", "a b"))).toEqual({
      kind: "settings",
      scope: "work",
      view: { kind: "skill", owner: "o", repo: "r", skill: "a b" },
    });
  });

  it("keep a path that cannot be decoded from showing anything", () => {
    expect(pageOf("/settings/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/settings/all/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/settings/all/skills/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/settings/all/skills/o/r/%E0%A4%A")).toEqual({ kind: "empty" });
  });
});

describe("the draft path", () => {
  it("shows the draft, and no Session or settings", () => {
    expect(isDraftPath(DRAFT_PATH)).toBe(true);
    expect(isDraftPath("/new/")).toBe(true);
    expect(isDraftPath("/new/x")).toBe(false);
    expect(isDraftPath("/sessions/new")).toBe(false);
    expect(sessionIdOf(DRAFT_PATH)).toBeUndefined();
    expect(pageOf(DRAFT_PATH)).toEqual({ kind: "draft" });
  });
});

describe("a repo's and a Skill's query", () => {
  it("names the ref to show, and none for the default branch", () => {
    expect(skillRepoParamsOf("")).toEqual({ ref: undefined, path: undefined });
    expect(skillRepoParamsOf("?ref=v1.2")).toEqual({ ref: "v1.2", path: undefined });
    expect(skillRepoParamsOf("?ref=feature%2Fx")).toEqual({ ref: "feature/x", path: undefined });
    expect(skillRepoParamsOf("?ref=")).toEqual({ ref: undefined, path: undefined });
  });

  it("is written on the repo's and the Skill's path with the ref encoded, and nothing for none", () => {
    expect(skillRepoPath(GLOBAL, "o", "r")).toBe("/settings/all/skills/o/r");
    expect(skillRepoPath(GLOBAL, "o", "r", "")).toBe("/settings/all/skills/o/r");
    expect(skillRepoPath(GLOBAL, "o", "r", "feature/x y")).toBe(
      "/settings/all/skills/o/r?ref=feature%2Fx%20y",
    );
    expect(skillPagePath(GLOBAL, "o", "r", "s", { ref: "v1" })).toBe(
      "/settings/all/skills/o/r/s?ref=v1",
    );

    const written = new URL(skillRepoPath(GLOBAL, "o", "r", "feature/x&y"), "https://x.test");

    expect(skillRepoParamsOf(written.search)).toEqual({ ref: "feature/x&y", path: undefined });
  });

  it("names the folder of a Skill's page in ?path=, which the root's empty folder is one of", () => {
    expect(skillPagePath(GLOBAL, "o", "r", "tdd")).toBe("/settings/all/skills/o/r/tdd");
    expect(skillPagePath(GLOBAL, "o", "r", "tdd", { path: "skills/codex/tdd" })).toBe(
      "/settings/all/skills/o/r/tdd?path=skills%2Fcodex%2Ftdd",
    );
    expect(skillPagePath(GLOBAL, "o", "r", "only-one", { ref: "v1", path: "" })).toBe(
      "/settings/all/skills/o/r/only-one?ref=v1&path=",
    );
    expect(skillRepoParamsOf("?ref=v1&path=skills%2Fcodex%2Ftdd")).toEqual({
      ref: "v1",
      path: "skills/codex/tdd",
    });
    // An empty path is the repo's root; no path is none named.
    expect(skillRepoParamsOf("?path=")).toEqual({ ref: undefined, path: "" });
    expect(skillRepoParamsOf("?ref=v1").path).toBeUndefined();

    const written = new URL(
      skillPagePath(GLOBAL, "o", "r", "x", { ref: "a/b", path: "c d/e" }),
      "https://x.test",
    );

    expect(skillRepoParamsOf(written.search)).toEqual({ ref: "a/b", path: "c d/e" });
  });

  it("follows the location", () => {
    stubWindow("/settings/all/skills/o/r");

    const registry = AtomRegistry.make();

    registry.mount(skillRepoParamsAtom);
    expect(registry.get(skillRepoParamsAtom)).toEqual({ ref: undefined, path: undefined });

    navigate(skillRepoPath(GLOBAL, "o", "r", "v2"));
    expect(registry.get(skillRepoParamsAtom)).toEqual({ ref: "v2", path: undefined });
  });
});

describe("the Skills section's query", () => {
  it("names the tab and the search", () => {
    expect(skillsParamsOf("")).toEqual({ tab: undefined, query: "" });
    expect(skillsParamsOf("?tab=installed")).toEqual({ tab: "installed", query: "" });
    expect(skillsParamsOf("?tab=hot&q=grill%20me")).toEqual({ tab: "hot", query: "grill me" });
    expect(skillsParamsOf("?tab=all-time").tab).toBe("all-time");
    expect(skillsParamsOf("?tab=trending").tab).toBe("trending");
  });

  it("names no tab it cannot be", () => {
    expect(skillsParamsOf("?tab=popular").tab).toBeUndefined();
    expect(skillsParamsOf("?tab=Installed").tab).toBeUndefined();
  });

  it("is written on the Scope's Skills section in the order tab, q, leaving out what is not named", () => {
    expect(skillsPath(GLOBAL)).toBe("/settings/all/skills");
    expect(skillsPath("work", { tab: "installed" })).toBe("/settings/work/skills?tab=installed");
    expect(skillsPath(GLOBAL, { query: "grill me", tab: "hot" })).toBe(
      "/settings/all/skills?tab=hot&q=grill+me",
    );
    expect(skillsPath(GLOBAL, { query: "" })).toBe("/settings/all/skills");
  });

  it("round-trips what it writes", () => {
    const params = { tab: "trending", query: "a&b=c" } as const;

    expect(skillsParamsOf(new URL(skillsPath(GLOBAL, params), "https://x.test").search)).toEqual(
      params,
    );
  });
});

describe("the old pages' addresses", () => {
  it("lead to the Environments section", () => {
    expect(legacyRedirect("/environments", "")).toBe("/settings/all/environments");
    expect(legacyRedirect("/environments/", "")).toBe("/settings/all/environments");
  });

  it("lead to the Skills section of the Scope `?environment=` named, keeping the tab and the search", () => {
    expect(legacyRedirect("/skills", "")).toBe("/settings/all/skills");
    expect(legacyRedirect("/skills/", "?tab=hot&q=grill+me")).toBe(
      "/settings/all/skills?tab=hot&q=grill+me",
    );
    expect(legacyRedirect("/skills", "?tab=installed&environment=1a2b3c4d")).toBe(
      "/settings/1a2b3c4d/skills?tab=installed",
    );
    expect(legacyRedirect("/skills", "?tab=installed&environment=*")).toBe(
      "/settings/all/skills?tab=installed",
    );
    expect(legacyRedirect("/skills", "?environment=%2A")).toBe("/settings/all/skills");
  });

  it("lead the Skill directory's pages to Global's, with their query", () => {
    expect(legacyRedirect("/skills/mattpocock", "")).toBe("/settings/all/skills/mattpocock");
    expect(legacyRedirect("/skills/o/r", "?ref=v1")).toBe("/settings/all/skills/o/r?ref=v1");
    expect(legacyRedirect("/skills/o/r/tdd", "?ref=v1&path=skills%2Ftdd")).toBe(
      "/settings/all/skills/o/r/tdd?ref=v1&path=skills%2Ftdd",
    );
    expect(legacyRedirect("/skills/o%20w/r", "")).toBe("/settings/all/skills/o%20w/r");
  });

  it("leave every other address alone", () => {
    expect(legacyRedirect("/", "")).toBeUndefined();
    expect(legacyRedirect("/settings", "")).toBeUndefined();
    expect(legacyRedirect("/settings/all/skills", "?tab=hot")).toBeUndefined();
    expect(legacyRedirect("/sessions/skills", "")).toBeUndefined();
    expect(legacyRedirect("/skills/a/b/c/d", "")).toBeUndefined();
    expect(legacyRedirect("/environments/x", "")).toBeUndefined();
  });

  it("are replaced in the history as the page opens, and when one is navigated to", () => {
    const browser = stubWindow("/skills?tab=installed&environment=work");
    const registry = AtomRegistry.make();

    registry.mount(pageAtom);
    registry.mount(skillsParamsAtom);

    expect(registry.get(pageAtom)).toEqual({
      kind: "settings",
      scope: "work",
      view: { kind: "section", section: "skills" },
    });
    expect(registry.get(skillsParamsAtom)).toEqual({ tab: "installed", query: "" });

    navigate("/environments");
    expect(registry.get(pageAtom)).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "section", section: "environments" },
    });
    expect(browser.history()).toEqual({
      entries: ["/settings/work/skills?tab=installed", "/settings/all/environments"],
      at: 1,
    });

    browser.back();
    expect(registry.get(skillsParamsAtom).tab).toBe("installed");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the page's path", () => {
  it("follows navigate and the browser's back and forward buttons", () => {
    const browser = stubWindow("/");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);
    expect(registry.get(pathAtom)).toBe("/");

    navigate(sessionPath("a"));
    expect(registry.get(sessionIdAtom)).toBe("a");

    registry.set(pathAtom, settingsPath(GLOBAL, "models"));
    expect(registry.get(pageAtom)).toEqual({
      kind: "settings",
      scope: GLOBAL,
      view: { kind: "section", section: "models" },
    });

    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "session", sessionId: "a" });

    browser.forward();
    expect(registry.get(pageAtom)).toMatchObject({ kind: "settings" });

    registry.set(pathAtom, DRAFT_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "draft" });

    browser.back();
    browser.back();
    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "empty" });
  });

  it("ignores the query", () => {
    stubWindow("/sessions/a?pane=tasks");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);

    expect(registry.get(pathAtom)).toBe("/sessions/a");
    expect(registry.get(sessionIdAtom)).toBe("a");
  });

  it("drops the query when the page moves, as the Panes belong to one Session", () => {
    const browser = stubWindow("/sessions/a?pane=tasks");

    navigate(sessionPath("b"));

    expect(browser.history()).toEqual({
      entries: ["/sessions/a?pane=tasks", "/sessions/b"],
      at: 1,
    });
  });
});

describe("the page's query", () => {
  it("follows replaceSearch and the browser's back and forward buttons", () => {
    const browser = stubWindow("/sessions/a");
    const registry = AtomRegistry.make();

    registry.mount(searchAtom);
    expect(registry.get(searchAtom)).toBe("");

    navigate("/sessions/a?x=1");
    expect(registry.get(searchAtom)).toBe("?x=1");

    replaceSearch("?pane=tasks");
    expect(registry.get(searchAtom)).toBe("?pane=tasks");

    registry.set(searchAtom, "?pane=tasks&x=1");
    expect(registry.get(searchAtom)).toBe("?pane=tasks&x=1");

    browser.back();
    expect(registry.get(searchAtom)).toBe("");
    browser.forward();
    expect(registry.get(searchAtom)).toBe("?pane=tasks&x=1");
  });

  it("replaces the history entry instead of adding one, and keeps the path", () => {
    const browser = stubWindow("/sessions/a");

    replaceSearch("?pane=tasks");
    replaceSearch("?pane=tasks&pane=terminal:1");

    expect(browser.history()).toEqual({
      entries: ["/sessions/a?pane=tasks&pane=terminal:1"],
      at: 0,
    });
  });

  it("holds what is written without a window", () => {
    const registry = AtomRegistry.make();

    registry.set(searchAtom, "?pane=tasks");

    expect(registry.get(searchAtom)).toBe("?pane=tasks");
  });
});

describe("the Pane parameters of a query", () => {
  it("are the repeated `pane` values in order, and the `shown` one", () => {
    expect(paneParamsOf("")).toEqual({ keys: [], shown: undefined, hidden: false });
    expect(paneParamsOf("?pane=tasks")).toEqual({
      keys: ["tasks"],
      shown: undefined,
      hidden: false,
    });
    expect(paneParamsOf("?pane=tasks&pane=terminal:1&shown=terminal:1")).toEqual({
      keys: ["tasks", "terminal:1"],
      shown: "terminal:1",
      hidden: false,
    });
  });

  it("say the area is hidden with `panes=hidden`", () => {
    expect(paneParamsOf("?pane=tasks&panes=hidden").hidden).toBe(true);
    expect(paneParamsOf("?pane=tasks&panes=shown").hidden).toBe(false);
    expect(withPaneParams("", { keys: ["tasks"], shown: "tasks", hidden: true })).toBe(
      "?pane=tasks&panes=hidden",
    );
    // Nothing to hide without a Pane.
    expect(withPaneParams("?panes=hidden", { keys: [], shown: undefined, hidden: true })).toBe("");
  });

  it("read a key whether its colon is escaped or not", () => {
    expect(paneParamsOf("?pane=live-view%3Aabc&pane=terminal:1").keys).toEqual([
      "live-view:abc",
      "terminal:1",
    ]);
  });

  it("are written with the colon as it is, and `shown` only when it is not the first", () => {
    expect(withPaneParams("", { keys: ["tasks"], shown: "tasks", hidden: false })).toBe(
      "?pane=tasks",
    );
    expect(
      withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "tasks", hidden: false }),
    ).toBe("?pane=tasks&pane=terminal:1");
    expect(
      withPaneParams("", { keys: ["tasks", "terminal:1"], shown: "terminal:1", hidden: false }),
    ).toBe("?pane=tasks&pane=terminal:1&shown=terminal:1");
  });

  it("are written encoded when a key holds more than letters", () => {
    expect(withPaneParams("", { keys: ["live-view:a b&c"], shown: undefined, hidden: false })).toBe(
      "?pane=live-view:a%20b%26c",
    );
    expect(paneParamsOf("?pane=live-view:a%20b%26c").keys).toEqual(["live-view:a b&c"]);
  });

  it("are replaced in a query that has other parameters, which stay", () => {
    expect(
      withPaneParams("?x=1&pane=old&shown=old&panes=hidden&y=two", {
        keys: ["tasks"],
        shown: "tasks",
        hidden: false,
      }),
    ).toBe("?x=1&y=two&pane=tasks");
  });

  it("leave no query when none is left", () => {
    const none = { keys: [], shown: undefined, hidden: false };

    expect(withPaneParams("?pane=tasks&shown=tasks", none)).toBe("");
    expect(withPaneParams("?pane=tasks&x=1", none)).toBe("?x=1");
  });
});
