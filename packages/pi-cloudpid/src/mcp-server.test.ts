// @effect-diagnostics preferEffectArray:off asyncFunction:off nodeBuiltinImport:off processEnv:off -- native array methods over plain values; plain Promises, as pi's extension API gives them; runs on node, on the owner's machine; the test points pi's agent directory at a temporary one.
/**
 * The `cloudpid` MCP server the extension registers from `cloudpid.baseUrl` (docs/architecture/mcp-endpoint.md → The
 * `/cloudpid` command → The MCP server), through a fake `pi` that records its calls and fires `session_start` with a
 * context of a cwd and a project trust, over the real settings files of a temporary agent directory and project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import register from "./index.ts";
import { MCP_SERVER_DESCRIPTION, MCP_SERVER_NAME } from "./mcp-server.ts";
import { scriptedUi } from "./stub.fixture.ts";

type StartHandler = (
  event: { type: "session_start" },
  ctx: ExtensionContext,
) => void | Promise<void>;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

let root: string;
let agentDir: string;
let project: string;
let before: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-cloudpid-mcp-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  before = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
});

afterEach(() => {
  if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = before;

  rmSync(root, { recursive: true, force: true });
});

const globalSettings = (value: Json): void =>
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));

const projectSettings = (value: Json): void =>
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify(value));

type Call =
  | { readonly kind: "register"; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: "unregister"; readonly name: string };

/** A fake `pi` that records its MCP calls (and what `registerMcpServer` throws, when told to), and the extension loaded into it. */
const loaded = (options: { readonly refuse?: () => string | undefined } = {}) => {
  const calls: Call[] = [];
  const handlers: StartHandler[] = [];

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the extension calls only `on`, `registerCommand`, `registerMcpServer` and `unregisterMcpServer`.
  const pi = {
    on: (event: string, handler: StartHandler) => {
      if (event === "session_start") handlers.push(handler);

      return () => {};
    },
    registerCommand: () => {},
    registerMcpServer: (name: string, config: McpServerConfig) => {
      const refusal = options.refuse?.();

      if (refusal !== undefined) throw new Error(refusal);

      calls.push({ kind: "register", name, config });
    },
    unregisterMcpServer: (name: string) => {
      calls.push({ kind: "unregister", name });
    },
  } as unknown as ExtensionAPI;

  register(pi);

  const ui = scriptedUi({});

  /** pi's `session_start` in a session at `cwd`, in a project that is `trusted` or not. */
  const start = async (cwd: string = project, trusted = true): Promise<void> => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the handler reads only these members of pi's context.
    const ctx = {
      cwd,
      hasUI: true,
      ui,
      isProjectTrusted: () => trusted,
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;

    for (const handler of handlers) await handler({ type: "session_start" }, ctx);
  };

  return { calls, ui, start };
};

const registerOf = (url: string) => ({
  kind: "register",
  name: MCP_SERVER_NAME,
  config: {
    url,
    toolExposure: { "session_import_*": "hidden" },
    description: MCP_SERVER_DESCRIPTION,
  },
});

describe("the cloudpid MCP server", () => {
  it("is registered at session start with the endpoint's URL, the import tools hidden and the default exposure", async () => {
    globalSettings({ cloudpid: { baseUrl: "https://pi.example.test" } });

    const { calls, ui, start } = loaded();

    expect(calls).toEqual([]);

    await start();

    expect(calls).toEqual([registerOf("https://pi.example.test/mcp")]);
    expect(calls[0]).not.toHaveProperty("config.exposure");
    expect(ui.notices).toEqual([]);
  });
  it("is not registered when the setting is unset, and says nothing", async () => {
    const { calls, ui, start } = loaded();

    await start();

    globalSettings({ cloudpid: {} });
    await start();

    expect(calls).toEqual([]);
    expect(ui.notices).toEqual([]);
  });

  it.each([["a value that is not a URL", { cloudpid: { baseUrl: "not a url" } }]])(
    "is not registered, with no notice and no throw, for %s",
    async (_name, settings) => {
      globalSettings(settings);

      const { calls, ui, start } = loaded();

      await expect(start()).resolves.toBeUndefined();

      expect(calls).toEqual([]);
      expect(ui.notices).toEqual([]);
    },
  );

  it("is not registered when a settings file is not JSON", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{ nope");

    const { calls, ui, start } = loaded();

    await expect(start()).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(ui.notices).toEqual([]);
  });
  it("registers nothing from an untrusted project's setting alone", async () => {
    projectSettings({ cloudpid: { baseUrl: "https://project.example.test" } });

    const { calls, start } = loaded();

    await start(project, false);

    expect(calls).toEqual([]);
  });

  it("is registered again when a later session start resolves another URL, and once when it resolves the same", async () => {
    globalSettings({ cloudpid: { baseUrl: "https://one.example.test" } });

    const { calls, start } = loaded();

    await start();
    await start();

    globalSettings({ cloudpid: { baseUrl: "https://two.example.test" } });
    await start();

    expect(calls).toEqual([
      registerOf("https://one.example.test/mcp"),
      registerOf("https://two.example.test/mcp"),
    ]);
  });

  it("is unregistered by a later session start that resolves none, and once", async () => {
    globalSettings({ cloudpid: { baseUrl: "https://one.example.test" } });
    projectSettings({ cloudpid: { baseUrl: "https://two.example.test" } });

    const { calls, start } = loaded();

    await start(project, true);

    // Another project, or a project that is no longer trusted: only the global setting is left.
    globalSettings({});
    await start(project, false);
    await start(project, false);

    expect(calls).toEqual([
      registerOf("https://two.example.test/mcp"),
      { kind: "unregister", name: MCP_SERVER_NAME },
    ]);

    projectSettings({ cloudpid: { baseUrl: "https://three.example.test" } });
    await start(project, true);

    expect(calls.at(-1)).toEqual(registerOf("https://three.example.test/mcp"));
  });

  it("is unregistered when the setting becomes invalid", async () => {
    globalSettings({ cloudpid: { baseUrl: "https://one.example.test" } });

    const { calls, start } = loaded();

    await start();

    globalSettings({ cloudpid: { baseUrl: "ftp://one.example.test" } });
    await start();

    expect(calls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  });

  it("shows a refusal of pi once as a warning, and does not throw", async () => {
    globalSettings({ cloudpid: { baseUrl: "https://one.example.test" } });

    let refusal: string | undefined =
      'MCP server "cloudpid" is already registered by extension "x"';

    const { calls, ui, start } = loaded({ refuse: () => refusal });

    await expect(start()).resolves.toBeUndefined();
    await expect(start()).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(ui.notices).toEqual([
      {
        type: "warning",
        message: expect.stringContaining('is already registered by extension "x"'),
      },
    ]);

    // The owner fixes it, and the next session start registers.
    refusal = undefined;
    await start();

    expect(calls).toEqual([registerOf("https://one.example.test/mcp")]);
    expect(ui.notices).toHaveLength(1);
  });
});
