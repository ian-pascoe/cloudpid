// What an agent's MCP entry is checked and made of (`./settings-mcp-entry.ts`): the credential literals it is refused for,
// the entry an `update`'s `set` makes, and the entry a Repo's copy makes.
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import { copiedEntry, credentialLiterals, entryWithSet } from "./settings-mcp-entry.ts";

describe("credentialLiterals", () => {
  it("names the key of a literal in a credential header or a credential-named key, never the value", () => {
    expect(
      credentialLiterals({
        url: "https://x.example/mcp",
        headers: { Authorization: "Bearer abc", "X-Api-Key": "abc", "X-Plain": "abc" },
        env: { GITHUB_TOKEN: "abc", MODE: "fast", client_secret: "abc" },
      }),
    ).toEqual([
      "env.GITHUB_TOKEN",
      "env.client_secret",
      "headers.Authorization",
      "headers.X-Api-Key",
    ]);
  });

  it("accepts a header or key that is only ${NAME}, with or without a scheme word", () => {
    expect(
      credentialLiterals({
        url: "https://x.example/mcp",
        headers: { Authorization: "Bearer ${TOKEN}", Cookie: "${SESSION}", "X-API-Key": "${KEY}" },
        env: { API_KEY: "${KEY}" },
      }),
    ).toEqual([]);
  });

  it("with a base only names the keys the change adds or gives another value", () => {
    const base = { url: "https://x.example/mcp", headers: { Authorization: "Bearer kept" } };

    expect(credentialLiterals(base, base)).toEqual([]);

    expect(
      credentialLiterals({ ...base, headers: { Authorization: "Bearer other" } }, base),
    ).toEqual(["headers.Authorization"]);
  });
});

describe("entryWithSet", () => {
  const entry = { command: "node", args: ["a"], env: { A: "1", B: "2" } };

  it("replaces a key, merges env key by key with null removing one, and removes a key given null", () => {
    expect(entryWithSet(entry, { args: ["b"], env: { B: null, C: "3" }, command: null })).toEqual({
      entry: { args: ["b"], env: { A: "1", C: "3" } },
    });
  });

  it("removes an object a merge leaves empty, and refuses a merge key that is no object", () => {
    expect(entryWithSet(entry, { env: { A: null, B: null } })).toEqual({
      entry: { command: "node", args: ["a"] },
    });

    expect(entryWithSet(entry, { env: "x" })).toEqual({
      problem: "env merges key by key: give an object",
    });
  });

  it("keeps the entry's key order and puts a new key after them", () => {
    const made = entryWithSet(entry, { command: "deno", cwd: "/w" });

    expect("entry" in made && Arr.map(Record.toEntries(made.entry), ([key]) => key)).toEqual([
      "command",
      "args",
      "env",
      "cwd",
    ]);
  });
});

describe("copiedEntry", () => {
  it("makes a stdio cwd absolute in the Repo's directory, even when the entry left it out", () => {
    expect(copiedEntry({ command: "node", cwd: "tools" }, "app")).toEqual({
      entry: { command: "node", cwd: "/workspace/app/tools" },
      cwd: "/workspace/app/tools",
    });

    expect(copiedEntry({ command: "node" }, "app")).toMatchObject({ cwd: "/workspace/app" });
  });

  it("leaves an http entry as it is, and refuses a cwd that leaves the Repo", () => {
    expect(copiedEntry({ url: "https://x.example/mcp" }, "app")).toEqual({
      entry: { url: "https://x.example/mcp" },
      cwd: null,
    });

    expect(copiedEntry({ command: "node", cwd: "../other" }, "app")).toHaveProperty("problem");
  });
});
