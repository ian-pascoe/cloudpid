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
  isSettingsPath,
  isEnvironmentsPath,
  isDraftPath,
  SETTINGS_PATH,
  sessionIdOf,
  sessionPath,
  ENVIRONMENTS_PATH,
  DRAFT_PATH,
  withPaneParams,
  agentIdOf,
  pageOf,
  subagentPath,
  SKILLS_PATH,
  skillOwnerPath,
  skillPagePath,
  skillRepoParamsAtom,
  skillRepoParamsOf,
  skillRepoPath,
  skillsParamsAtom,
  skillsParamsOf,
  skillsPath,
} from "./router.ts";

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

describe("the settings path", () => {
  it("shows the settings, and no Session", () => {
    expect(isSettingsPath(SETTINGS_PATH)).toBe(true);
    expect(isSettingsPath("/settings/")).toBe(true);
    expect(isSettingsPath("/settings/x")).toBe(false);
    expect(isSettingsPath("/sessions/settings")).toBe(false);
    expect(sessionIdOf(SETTINGS_PATH)).toBeUndefined();
  });
});

describe("the Environments path", () => {
  it("shows the Environments, and no Session or settings", () => {
    expect(isEnvironmentsPath(ENVIRONMENTS_PATH)).toBe(true);
    expect(isEnvironmentsPath("/environments/")).toBe(true);
    expect(isEnvironmentsPath("/environments/x")).toBe(false);
    expect(isEnvironmentsPath("/sessions/environments")).toBe(false);
    expect(sessionIdOf(ENVIRONMENTS_PATH)).toBeUndefined();
    expect(isSettingsPath(ENVIRONMENTS_PATH)).toBe(false);
  });
});

describe("the draft path", () => {
  it("shows the draft, and no Session, settings or Environments", () => {
    expect(isDraftPath(DRAFT_PATH)).toBe(true);
    expect(isDraftPath("/new/")).toBe(true);
    expect(isDraftPath("/new/x")).toBe(false);
    expect(isDraftPath("/sessions/new")).toBe(false);
    expect(sessionIdOf(DRAFT_PATH)).toBeUndefined();
    expect(isSettingsPath(DRAFT_PATH)).toBe(false);
    expect(isEnvironmentsPath(DRAFT_PATH)).toBe(false);
  });
});

describe("the Skills paths", () => {
  it("show the Skills page at /skills, and no Session, settings or Environments", () => {
    expect(pageOf(SKILLS_PATH)).toEqual({ kind: "skills" });
    expect(pageOf("/skills/")).toEqual({ kind: "skills" });
    expect(sessionIdOf(SKILLS_PATH)).toBeUndefined();
    expect(isSettingsPath(SKILLS_PATH)).toBe(false);
    expect(isEnvironmentsPath(SKILLS_PATH)).toBe(false);
    expect(pageOf("/sessions/skills")).toEqual({ kind: "session", sessionId: "skills" });
  });

  it("take the first segment after /skills as an owner, even one named like a tab", () => {
    expect(pageOf("/skills/mattpocock")).toEqual({ kind: "skillOwner", owner: "mattpocock" });
    expect(pageOf("/skills/installed")).toEqual({ kind: "skillOwner", owner: "installed" });
    expect(pageOf("/skills/all-time/")).toEqual({ kind: "skillOwner", owner: "all-time" });
    expect(pageOf("/skills/hot/trending")).toEqual({
      kind: "skillRepo",
      owner: "hot",
      repo: "trending",
    });
  });

  it("show an owner's repo, then one Skill of it", () => {
    expect(pageOf("/skills/mattpocock/skills")).toEqual({
      kind: "skillRepo",
      owner: "mattpocock",
      repo: "skills",
    });
    expect(pageOf("/skills/mattpocock/skills/grill-me")).toEqual({
      kind: "skill",
      owner: "mattpocock",
      repo: "skills",
      skill: "grill-me",
    });
    expect(pageOf("/skills/a/b/c/d")).toEqual({ kind: "empty" });
  });

  it("round-trip an owner, a repo and a Skill, encoded", () => {
    expect(skillOwnerPath("o w")).toBe("/skills/o%20w");
    expect(pageOf(skillOwnerPath("o w"))).toEqual({ kind: "skillOwner", owner: "o w" });
    expect(skillRepoPath("o", "r.js")).toBe("/skills/o/r.js");
    expect(pageOf(skillRepoPath("o", "a/b"))).toEqual({
      kind: "skillRepo",
      owner: "o",
      repo: "a/b",
    });
    expect(skillPagePath("o", "r", "s")).toBe("/skills/o/r/s");
    expect(pageOf(skillPagePath("o", "r", "a b"))).toEqual({
      kind: "skill",
      owner: "o",
      repo: "r",
      skill: "a b",
    });
  });

  it("show an owner named like a tab as an owner's page, from the path an owner's link writes", () => {
    for (const owner of ["installed", "all-time", "trending", "hot"]) {
      expect(skillOwnerPath(owner)).toBe(`/skills/${owner}`);
      expect(pageOf(skillOwnerPath(owner))).toEqual({ kind: "skillOwner", owner });
    }

    expect(pageOf("/skills/mattpocock/")).toEqual({ kind: "skillOwner", owner: "mattpocock" });
  });

  it("keep a path that cannot be decoded from showing anything", () => {
    expect(pageOf("/skills/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/skills/o/%E0%A4%A")).toEqual({ kind: "empty" });
    expect(pageOf("/skills/o/r/%E0%A4%A")).toEqual({ kind: "empty" });
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
    expect(skillRepoPath("o", "r")).toBe("/skills/o/r");
    expect(skillRepoPath("o", "r", "")).toBe("/skills/o/r");
    expect(skillRepoPath("o", "r", "feature/x y")).toBe("/skills/o/r?ref=feature%2Fx%20y");
    expect(skillPagePath("o", "r", "s", { ref: "v1" })).toBe("/skills/o/r/s?ref=v1");

    // The query is not part of the path, so the page is the same page.
    expect(pageOf("/skills/o/r")).toEqual({ kind: "skillRepo", owner: "o", repo: "r" });

    const written = new URL(skillRepoPath("o", "r", "feature/x&y"), "https://x.test");

    expect(skillRepoParamsOf(written.search)).toEqual({ ref: "feature/x&y", path: undefined });
  });

  it("names the folder of a Skill's page in ?path=, which the root's empty folder is one of", () => {
    expect(skillPagePath("o", "r", "tdd")).toBe("/skills/o/r/tdd");
    expect(skillPagePath("o", "r", "tdd", { path: "skills/codex/tdd" })).toBe(
      "/skills/o/r/tdd?path=skills%2Fcodex%2Ftdd",
    );
    expect(skillPagePath("o", "r", "only-one", { ref: "v1", path: "" })).toBe(
      "/skills/o/r/only-one?ref=v1&path=",
    );
    expect(skillRepoParamsOf("?ref=v1&path=skills%2Fcodex%2Ftdd")).toEqual({
      ref: "v1",
      path: "skills/codex/tdd",
    });
    // An empty path is the repo's root; no path is none named.
    expect(skillRepoParamsOf("?path=")).toEqual({ ref: undefined, path: "" });
    expect(skillRepoParamsOf("?ref=v1").path).toBeUndefined();

    const written = new URL(
      skillPagePath("o", "r", "x", { ref: "a/b", path: "c d/e" }),
      "https://x.test",
    );

    expect(skillRepoParamsOf(written.search)).toEqual({ ref: "a/b", path: "c d/e" });
  });

  it("follows the location", () => {
    stubWindow("/skills/o/r");

    const registry = AtomRegistry.make();

    registry.mount(skillRepoParamsAtom);
    expect(registry.get(skillRepoParamsAtom)).toEqual({ ref: undefined, path: undefined });

    navigate(skillRepoPath("o", "r", "v2"));
    expect(registry.get(skillRepoParamsAtom)).toEqual({ ref: "v2", path: undefined });
  });
});

describe("the Skills page's query", () => {
  it("names the tab, the search and the Environment the Installed tab shows", () => {
    expect(skillsParamsOf("")).toEqual({ tab: undefined, query: "", environment: undefined });
    expect(skillsParamsOf("?tab=installed&environment=work")).toEqual({
      tab: "installed",
      query: "",
      environment: "work",
    });
    expect(skillsParamsOf("?tab=hot&q=grill%20me")).toEqual({
      tab: "hot",
      query: "grill me",
      environment: undefined,
    });
    expect(skillsParamsOf("?tab=all-time").tab).toBe("all-time");
    expect(skillsParamsOf("?tab=trending").tab).toBe("trending");
  });

  it("takes * as every Environment, and names no tab or Environment it cannot be", () => {
    expect(skillsParamsOf("?environment=*").environment).toBe("*");
    expect(skillsParamsOf("?environment=%2A").environment).toBe("*");
    expect(skillsParamsOf("?environment=").environment).toBeUndefined();
    expect(skillsParamsOf("?tab=popular").tab).toBeUndefined();
    expect(skillsParamsOf("?tab=Installed").tab).toBeUndefined();
  });

  it("is written in the order tab, q, environment, leaving out what is not named", () => {
    expect(skillsPath()).toBe(SKILLS_PATH);
    expect(skillsPath({ tab: "installed", environment: "work" })).toBe(
      "/skills?tab=installed&environment=work",
    );
    expect(skillsPath({ tab: "installed", environment: "*" })).toBe(
      "/skills?tab=installed&environment=*",
    );
    expect(skillsPath({ environment: "*", query: "grill me", tab: "hot" })).toBe(
      "/skills?tab=hot&q=grill+me&environment=*",
    );
    expect(skillsPath({ query: "" })).toBe(SKILLS_PATH);
  });

  it("round-trips what it writes", () => {
    const params = { tab: "trending", query: "a&b=c", environment: "*" } as const;

    expect(skillsParamsOf(new URL(skillsPath(params), "https://x.test").search)).toEqual(params);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Skills page's location", () => {
  it("follows a link to a tab filtered to an Environment, and back", () => {
    const browser = stubWindow("/environments");
    const registry = AtomRegistry.make();

    registry.mount(pageAtom);
    registry.mount(skillsParamsAtom);

    navigate(skillsPath({ tab: "installed", environment: "work" }));
    expect(registry.get(pageAtom)).toEqual({ kind: "skills" });
    expect(registry.get(skillsParamsAtom)).toEqual({
      tab: "installed",
      query: "",
      environment: "work",
    });

    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "environments" });
    expect(registry.get(skillsParamsAtom).environment).toBeUndefined();
  });
});

describe("the page's path", () => {
  it("follows navigate and the browser's back and forward buttons", () => {
    const browser = stubWindow("/");
    const registry = AtomRegistry.make();

    registry.mount(pathAtom);
    expect(registry.get(pathAtom)).toBe("/");

    navigate(sessionPath("a"));
    expect(registry.get(sessionIdAtom)).toBe("a");

    registry.set(pathAtom, SETTINGS_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "settings" });

    browser.back();
    expect(registry.get(pageAtom)).toEqual({ kind: "session", sessionId: "a" });

    browser.forward();
    expect(registry.get(pageAtom)).toEqual({ kind: "settings" });

    registry.set(pathAtom, ENVIRONMENTS_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "environments" });

    registry.set(pathAtom, DRAFT_PATH);
    expect(registry.get(pageAtom)).toEqual({ kind: "draft" });

    browser.back();
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
