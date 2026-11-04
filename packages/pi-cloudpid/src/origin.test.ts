// @effect-diagnostics preferEffectArray:off -- native array methods over plain values (the bundle carries no Effect runtime).
import { describe, expect, it } from "vitest";
import { matchEnvironments, normalizeRepoUrl } from "./origin.ts";

describe("normalizeRepoUrl", () => {
  it.each([
    ["https://github.com/acme/app", "https://github.com/acme/app"],
    ["https://github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://github.com/acme/app/", "https://github.com/acme/app"],
    ["https://github.com/acme/app.git/", "https://github.com/acme/app"],
    ["HTTPS://GitHub.com/Acme/App.GIT", "https://github.com/acme/app"],
    ["https://user:token@github.com/acme/app.git", "https://github.com/acme/app"],
    ["https://x-access-token:abc@github.com/acme/app", "https://github.com/acme/app"],
    ["git@github.com:acme/app.git", "https://github.com/acme/app"],
    ["git@github.com:Acme/App", "https://github.com/acme/app"],
    ["github.com:acme/app.git", "https://github.com/acme/app"],
    ["ssh://git@github.com/acme/app.git", "https://github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "https://github.com/acme/app"],
    ["ssh://github.com/acme/app/", "https://github.com/acme/app"],
    ["git://github.com/acme/app.git", "https://github.com/acme/app"],
    ["http://github.com/acme/app.git", "https://github.com/acme/app"],
    [
      "https://git.example.test:8443/team/sub/app.git",
      "https://git.example.test:8443/team/sub/app",
    ],
    ["  https://github.com/acme/app.git\n", "https://github.com/acme/app"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeRepoUrl(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "/srv/git/app.git",
    "../app",
    "file:///srv/git/app.git",
    "C:\\repos\\app",
    "https://github.com",
    "https://github.com/",
  ])("has none for %j (no host and path)", (raw) => {
    expect(normalizeRepoUrl(raw)).toBeUndefined();
  });
});

describe("matchEnvironments", () => {
  const environments = [
    {
      id: "a",
      repos: [{ url: "https://github.com/acme/app" }, { url: "https://github.com/acme/lib" }],
    },
    { id: "b", repos: [{ url: "https://github.com/Acme/App.git" }] },
    { id: "c", repos: [{ url: "https://github.com/acme/other" }] },
    { id: "d", repos: [] },
  ];

  it("returns every Environment with a Repo at the origin, in order", () => {
    expect(
      matchEnvironments(environments, "git@github.com:acme/app.git").map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });

  it("returns one when one matches", () => {
    expect(
      matchEnvironments(environments, "ssh://git@github.com/acme/other").map(({ id }) => id),
    ).toEqual(["c"]);
  });

  it("returns none for an origin no Environment has, or one that is not a hosted URL", () => {
    expect(matchEnvironments(environments, "https://github.com/acme/nope")).toEqual([]);
    expect(matchEnvironments(environments, "/srv/git/app.git")).toEqual([]);
  });
});
