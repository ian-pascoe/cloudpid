// @effect-diagnostics preferEffectArray:off -- native array methods over plain values (the bundle carries no Effect runtime).
/**
 * The `/cloudpid` command line (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Command): the verbs, the
 * instruction kept verbatim, and the completions.
 */
import { describe, expect, it } from "vitest";
import { completionsFor, parseCommand } from "./command.ts";

describe("parseCommand", () => {
  it("takes everything after `import` verbatim as the instruction", () => {
    expect(parseCommand("import fix the failing test  and open a PR")).toEqual({
      kind: "import",
      instruction: "fix the failing test  and open a PR",
    });
    expect(parseCommand("  import   line one\nline two  ")).toEqual({
      kind: "import",
      instruction: "line one\nline two",
    });
  });

  it("imports with no instruction when none follows", () => {
    expect(parseCommand("import")).toEqual({ kind: "import", instruction: "" });
  });

  it("never reads an instruction that starts with a verb as that verb", () => {
    expect(parseCommand("import login and logout flows")).toEqual({
      kind: "import",
      instruction: "login and logout flows",
    });
    expect(parseCommand("import logout")).toEqual({ kind: "import", instruction: "logout" });
  });

  it("reads login and logout", () => {
    expect(parseCommand("login")).toEqual({ kind: "login" });
    expect(parseCommand(" logout ")).toEqual({ kind: "logout" });
  });

  it("prints the usage for a bare command", () => {
    expect(parseCommand("")).toEqual({ kind: "usage", problem: undefined });
    expect(parseCommand("   ")).toEqual({ kind: "usage", problem: undefined });
  });

  it("prints the usage for an unknown subcommand, and for what a bare verb does not take", () => {
    expect(parseCommand("fix the test")).toEqual({
      kind: "usage",
      problem: "Unknown subcommand: fix.",
    });
    expect(parseCommand("login now")).toEqual({
      kind: "usage",
      problem: "`login` takes no arguments (got: now).",
    });
  });
});

describe("completionsFor", () => {
  it("offers every subcommand for an empty prefix", () => {
    expect(completionsFor("")?.map((item) => item.value)).toEqual(["import", "login", "logout"]);
  });

  it("narrows by prefix", () => {
    expect(completionsFor("lo")?.map((item) => item.value)).toEqual(["login", "logout"]);
  });

  it("offers nothing for no match, or once past the verb", () => {
    expect(completionsFor("x")).toBeNull();
    expect(completionsFor("import fix")).toBeNull();
    expect(completionsFor("import ")).toBeNull();
  });
});
