// @effect-diagnostics preferEffectArray:off -- tests of plain array functions.
import { describe, expect, it } from "vitest";
import { bestMatches, rank, rankCandidate } from "./ranking.ts";

describe("ranking candidates for a query", () => {
  const names = ["model", "name", "new", "archive", "stop", "stop-all", "settings", "skill:tdd"];

  const ranked = (query: string, candidates = names) => rank(query, candidates, (name) => name);

  it("keeps every candidate, in order, for an empty query", () => {
    expect(ranked("")).toEqual(names);
  });

  it("puts an exact match, then prefixes, then word starts, then substrings, then subsequences", () => {
    expect(ranked("stop")).toEqual(["stop", "stop-all"]);
    expect(ranked("all")).toEqual(["stop-all"]);
    expect(ranked("tdd")).toEqual(["skill:tdd"]);
    expect(ranked("n")).toEqual(["name", "new", "settings"]);
    expect(ranked("stg")).toEqual(["settings"]);
  });

  it("ignores case", () => {
    expect(ranked("MOD")).toEqual(["model"]);
  });

  it("drops what does not match", () => {
    expect(ranked("xyz")).toEqual([]);
  });

  it("ranks a match in the last path segment above one in a directory", () => {
    expect(ranked("app", ["apps/web/index.ts", "src/app.tsx"])).toEqual([
      "src/app.tsx",
      "apps/web/index.ts",
    ]);
  });

  it("ranks a folder by its own name, without its trailing slash getting in the way", () => {
    expect(ranked("chat", ["src/chat.ts", "src/chat/", "docs/chatting.md"])).toEqual([
      "src/chat.ts",
      "src/chat/",
      "docs/chatting.md",
    ]);
    expect(ranked("chat/", ["src/chat/", "src/chat/menu.ts"])).toEqual([
      "src/chat/",
      "src/chat/menu.ts",
    ]);
  });

  it("narrows into a folder as the query takes its path", () => {
    expect(
      ranked("src/chat/", ["src/", "src/chat/", "src/chat/menu.ts", "apps/web/src/chat/x.ts"]),
    ).toEqual(["src/chat/", "src/chat/menu.ts", "apps/web/src/chat/x.ts"]);
    expect(ranked("src/chat/me", ["src/chat/", "src/chat/menu.ts", "src/cache.ts"])).toEqual([
      "src/chat/menu.ts",
    ]);
  });

  it("keeps the candidates' order among equals", () => {
    expect(ranked("index.ts", ["a/index.ts", "index.ts", "b/index.ts"])).toEqual([
      "a/index.ts",
      "index.ts",
      "b/index.ts",
    ]);
  });
});

describe("the best matches among prepared candidates", () => {
  const paths = [
    "src/",
    "src/chat/",
    "src/app.tsx",
    "apps/web/index.ts",
    "src/chat/menu.ts",
    "docs/chatting.md",
    "README.md",
  ];

  const prepared = paths.map(rankCandidate);

  it("ranks as rank does", () => {
    for (const query of ["", "app", "chat", "src/chat/", "md", "zz", "SRC"]) {
      expect(bestMatches(query, prepared, 100)).toEqual(rank(query, paths, (path) => path));
    }
  });

  it("keeps only the best, the earlier among equals", () => {
    expect(bestMatches("chat", prepared, 2)).toEqual(["src/chat/", "docs/chatting.md"]);
    expect(bestMatches("", prepared, 2)).toEqual(["src/", "src/chat/"]);
    expect(bestMatches("s", prepared, 0)).toEqual([]);
  });
});
