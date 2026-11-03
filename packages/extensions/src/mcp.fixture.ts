// What the `mcp` extension's tests share: servers, a request start, and a Harness with `tool_search` and `codemode` whose
// MCP tools the test installs as the Session's reinstall does (`docs/architecture/mcp-in-a-session.md`).
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { Extension } from "@earendil-works/pi-durable";
import {
  type CodemodeNamespace,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { McpRequestStartInput, McpToolsService } from "./mcp.ts";
import type { FakeMcpServer } from "./mcp.testing.ts";
import { openSubagentHarness } from "./subagents/harness.fixture.ts";
import { fixedToolSearchSettings, reloadToolSearch, ToolSearch } from "./tool-search.ts";

/** A server whose four tools each have one Exposure, and one only an MCP App sees. */
export const DOCS: FakeMcpServer = {
  name: "Docs-Site",
  description: "The product docs",
  instructions: "Search before fetching.",
  exposure: "codemode",
  toolExposure: { search: "direct", fetchPage: "deferred", secret: "hidden" },
  tools: [
    { name: "search", description: "Search the docs" },
    { name: "fetchPage", description: "Fetch one page of the docs" },
    { name: "secret", description: "Never offered" },
    { name: "summarize", description: "Summarize a page of the docs" },
    { name: "widget", description: "An App's own tool", _meta: { ui: { visibility: ["app"] } } },
  ],
};

/** Another server, all `direct`. */
export const ISSUES: FakeMcpServer = {
  name: "issues",
  exposure: "direct",
  tools: [{ name: "list", description: "List the issues" }],
};

/** A request start for the root conversation in its first Context Window, with `servers` servers. */
export const startOf = (
  servers: number,
  more: Partial<McpRequestStartInput> = {},
): McpRequestStartInput => ({
  caller: { session: "s1", conversation: "0", workspace: "ws:w1" },
  window: "start",
  servers,
  offered: [],
  ready: Effect.succeed(true),
  ...more,
});

/** A request start, then what a reinstall installs for `offered`. */
export const build = async (
  tools: McpToolsService,
  input: McpRequestStartInput = startOf(1),
): Promise<Option.Option<Extension>> => {
  await Effect.runPromise(tools.requestStart(input));

  return Option.map(tools.reinstall(input.offered), (built) => built.mcp);
};

/** The deferred tools the latest request's prompt names. */
export const deferredIn = (system: string | undefined) =>
  system?.split("<deferred_tools>").at(-1)?.split("</deferred_tools>")[0] ?? "";

export const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });

/** `codemode` with `namespaces`, as the Session installs it again with the servers. */
export const codemodeWith = (namespaces: ReadonlyArray<CodemodeNamespace>) =>
  createCodemodeExtension({ sandbox, models: false, namespaces });

/** A Harness with `tool_search` and `codemode`, whose MCP tools the test installs as the Session's reinstall does. */
export const open = async (
  script: Parameters<typeof openSubagentHarness>[0],
  env?: NonNullable<Parameters<typeof openSubagentHarness>[3]>["env"],
) => {
  const session = await openSubagentHarness(
    script,
    {},
    [
      await Effect.runPromise(
        ToolSearch(["read"]).pipe(Effect.provide(fixedToolSearchSettings([]))),
      ),
      codemodeWith([]),
    ],
    env === undefined ? {} : { env },
  );

  /** What a reinstall of `tools` gives, installed with `codemode` and `tool-search` together, as the Session does. */
  const reinstall = (tools: McpToolsService, offered: ReadonlyArray<string> = []) =>
    Option.map(tools.reinstall(offered), ({ mcp, namespaces }) => {
      session.registry.install(mcp);
      session.registry.install(codemodeWith(namespaces));
      session.registry.install(
        reloadToolSearch(session.registry.snapshot().installed(), { offered }),
      );
    });

  /** A request start, then its reinstall. */
  const start = async (tools: McpToolsService, input: McpRequestStartInput = startOf(1)) => {
    await Effect.runPromise(tools.requestStart(input));

    return reinstall(tools, input.offered);
  };

  return { ...session, reinstall, start };
};

/** The `details` of the root conversation's tool results, oldest first. */
export const detailsOf = async (session: Awaited<ReturnType<typeof open>>) =>
  (await session.entries()).flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" ? [message.details] : [],
    ),
  );

/** The tool results of the root conversation, oldest first: whether each is an error, and its content. */
export const results = async (session: Awaited<ReturnType<typeof open>>) =>
  (await session.entries()).flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" ? [[message.isError, message.content] as const] : [],
    ),
  );
