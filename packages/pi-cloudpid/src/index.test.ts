// @effect-diagnostics preferEffectArray:off asyncFunction:off nodeBuiltinImport:off processEnv:off -- native array methods over plain values (the extension carries no Effect runtime); plain Promises, as pi's extension API gives them; runs on node, on the owner's machine; the test points pi's agent directory at a temporary one.
/**
 * The extension as pi loads it (docs/architecture/mcp-endpoint.md → The `/cloudpid` command): one command with its
 * subcommands completing, reading the endpoint from pi's settings on each run, and printing what fails.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileAuthStore } from "./auth-store.ts";
import register from "./index.ts";
import { scriptedUi } from "./stub.fixture.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

let root: string;
let agentDir: string;
let before: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-cloudpid-index-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  before = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
});

afterEach(() => {
  if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = before;

  rmSync(root, { recursive: true, force: true });
});

/** What the extension registers, with pi's `registerCommand` recorded. */
const registered = () => {
  const commands = new Map<string, Command>();

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the extension calls `registerCommand` and `on` and nothing else of pi's API at load.
  const pi = {
    on: () => () => {},
    registerCommand: (name: string, options: Command) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;

  register(pi);

  return commands;
};

/** A command context with what `/cloudpid`'s bare, `login`-less subcommands read. */
const contextOf = (ui: ReturnType<typeof scriptedUi>) =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: only these members are read by `usage` and `logout`; pi supplies the rest, and the scripted UI has what they call.
  ({
    cwd: root,
    hasUI: true,
    ui,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => [] },
  }) as unknown as ExtensionCommandContext;

describe("the registered command", () => {
  it("is one command, `cloudpid`, whose subcommands complete", () => {
    const commands = registered();

    expect([...commands.keys()]).toEqual(["cloudpid"]);

    const complete = commands.get("cloudpid")?.getArgumentCompletions;

    expect(complete?.("")).toEqual([
      expect.objectContaining({ value: "import" }),
      expect.objectContaining({ value: "login" }),
      expect.objectContaining({ value: "logout" }),
    ]);
    expect(complete?.("lo")).toHaveLength(2);
    expect(complete?.("import fix")).toBeNull();
  });

  it("reads the endpoint from pi's settings on every run", async () => {
    const handler = registered().get("cloudpid")?.handler;
    const ui = scriptedUi({});
    const ctx = contextOf(ui);

    await handler?.("", ctx);

    expect(ui.notices[0]?.message).toContain("Usage:");
    expect(ui.notices[0]?.message).toContain("`cloudpid.baseUrl` is not set");

    // No /reload: the next run sees the file as it is now.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ cloudpid: { baseUrl: "https://pi.example.test" } }),
    );

    await handler?.("", ctx);

    expect(ui.notices[1]?.message).toContain("Endpoint: https://pi.example.test/mcp");
  });

  it("logs out of the configured endpoint in pi's agent directory, and prints a refusal as an error", async () => {
    const handler = registered().get("cloudpid")?.handler;
    const ui = scriptedUi({});
    const ctx = contextOf(ui);

    await handler?.("logout", ctx);

    expect(ui.notices[0]).toMatchObject({ type: "error" });
    expect(ui.notices[0]?.message).toContain("`cloudpid.baseUrl` is not set");

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ cloudpid: { baseUrl: "https://pi.example.test" } }),
    );
    await fileAuthStore(agentDir).write("https://pi.example.test/mcp", {
      tokens: { access_token: "t", token_type: "Bearer" },
    });

    await handler?.("logout", ctx);

    expect(ui.notices[1]?.message).toContain("signed out of https://pi.example.test/mcp");
    expect(await fileAuthStore(agentDir).read("https://pi.example.test/mcp")).toBeUndefined();
  });
});
