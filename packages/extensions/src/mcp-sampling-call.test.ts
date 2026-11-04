// A call of an MCP tool whose Legacy server asks for a model reply (`docs/architecture/mcp-server-requests.md` → Sampling
// requests): declared only for a server whose definition says `allow`, on a host that lists `sampling`; answered on the
// Session's models; and told to the model and `details` without what was asked or answered. A scripted model on a Harness,
// and an in-memory host that asks through the call's hooks.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import { type JsonObject, McpHostCompleted, type McpInputAnswer } from "@cloudpid/mcp/types";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Usage,
} from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { describe, expect, it } from "vitest";
import { MCP_HOST_FEATURES } from "@cloudpid/mcp/types";
import {
  makeMcpTools,
  MCP_SAMPLING_FEATURE,
  memoryMcpToolsStore,
  type McpToolOptions,
} from "./mcp.ts";
import { DOCS, detailsOf, open } from "./mcp.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { createMcpSampling } from "./mcp/sampling.ts";
import { answer, call } from "./subagents/harness.fixture.ts";
import { context } from "./subagents/harness.fixture.ts";

type Answer = typeof McpInputAnswer.Encoded;

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the sampler reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
  };
};

const SAMPLE = {
  key: "9",
  kind: "sampling" as const,
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    maxTokens: 200,
  },
  mode: "live" as const,
};

const DONE = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
});

const READ = McpHostCompleted.make({
  result: { kind: "inline", value: { contents: [{ uri: "file:///a.txt", text: "read" }] } },
});

const ALLOWING = { ...DOCS, entry: { sampling: "allow" } };

/**
 * A Session's tools over a host that asks one Sampling request through the call's hooks. `over` is the Spend limit's
 * words when it is reached.
 */
const setup = async (
  options: {
    readonly server?: typeof DOCS;
    readonly features?: ReadonlyArray<string>;
    readonly sampler?: boolean;
    readonly over?: string;
    /** The tool the model calls: a server's tool by default. */
    readonly tool?: readonly [string, JsonObject];
  } = {},
) => {
  const host = fakeMcpHost([options.server ?? ALLOWING]);

  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "claude-haiku-5-5" }],
  });

  const models = createModels();
  const usages: Usage[] = [];

  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("a summary")]);

  const sampling = createMcpSampling({ storage: memoryStorage(), redact: Effect.succeed });

  sampling.bind({
    models,
    roles: () => ({ small: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    overLimit: () => Promise.resolve(options.over),
    usage: (_who, usage) => {
      usages.push(usage);
    },
  });

  host.features(options.features ?? MCP_HOST_FEATURES);

  const seen: Answer[] = [];

  host.answer(async (_input, hooks) => {
    const reply = await hooks.onInput?.(SAMPLE);

    if (reply !== undefined) seen.push(reply);

    return options.tool?.[0] === "read_mcp_resource" ? READ : DONE;
  });

  const toolOptions: Mutable<McpToolOptions> = { slackMs: 0 };

  if (options.sampler !== false) toolOptions.sampling = sampling;

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), toolOptions);

  const session = await open((request) =>
    request.text === "go" ? call(options.tool ?? ["mcp__docs_site__search", {}]) : answer("ok"),
  );

  await session.start(tools);

  const submitted = await session.root.submit({ type: "input", content: "go" }, context);

  await submitted.wait(context);

  const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

  return { host, session, sent, seen, usages, sampling };
};

describe("a Legacy server's Sampling request", () => {
  it("is answered on the Session's models when the definition says allow, and is counted and told", async () => {
    const { session, sent, seen, usages, sampling } = await setup();

    expect(sent[0]?.ctx.answers).toMatchObject({ sampling: true });
    expect(seen).toEqual([
      {
        kind: "sampled",
        result: expect.objectContaining({
          role: "assistant",
          content: { type: "text", text: "a summary" },
          stopReason: "endTurn",
        }),
      },
    ]);
    expect(usages).toHaveLength(1);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        sampling: [
          expect.objectContaining({
            server: "Docs-Site",
            status: "answered",
            by: "definition",
            role: "small",
          }),
        ],
      }),
    ]);
    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect(await Effect.runPromise(sampling.records)).toHaveLength(1);
  });

  it("is refused at the Spend limit, and the model is told the server asked and was refused", async () => {
    const { session, seen, usages } = await setup({ over: "Spend limit of $1 reached" });

    expect(seen).toEqual([
      { kind: "refused", message: "out of budget: Spend limit of $1 reached", code: -1 },
    ]);
    expect(usages).toEqual([]);

    const [text] = await session.texts("toolResult");

    expect(text).toContain("Docs-Site asked for a model reply; refused: out of budget");
    expect(JSON.stringify(await detailsOf(session))).toContain('"status":"refused"');
  });

  it("is answered in a read of a resource too, and told in the read's details", async () => {
    const files = {
      name: "files",
      exposure: "direct",
      resources: true,
      tools: [],
      entry: { sampling: "allow" },
    };

    const { session, sent, seen, usages } = await setup({
      server: files,
      tool: ["read_mcp_resource", { server: "files", uri: "file:///a.txt" }],
    });

    expect(sent[0]).toMatchObject({ op: "resources/read" });
    expect(sent[0]?.ctx.answers).toMatchObject({ sampling: true });
    expect(seen).toEqual([expect.objectContaining({ kind: "sampled" })]);
    expect(usages).toHaveLength(1);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        tool: "read_mcp_resource",
        sampling: [expect.objectContaining({ status: "answered", by: "definition" })],
      }),
    ]);
  });

  it("is not declared on a read when the server does not allow it", async () => {
    const files = { name: "files", exposure: "direct", resources: true, tools: [] };

    const { sent } = await setup({
      server: files,
      tool: ["read_mcp_resource", { server: "files", uri: "file:///a.txt" }],
    });

    expect(sent[0]?.ctx.answers?.sampling).toBeUndefined();
  });

  it.each([
    ["a definition that says ask", { server: { ...DOCS, entry: { sampling: "ask" } } }],
    ["a definition that says off", { server: { ...DOCS, entry: { sampling: "off" } } }],
    ["a definition without sampling", { server: DOCS }],
    [
      "a host that does not list sampling",
      { features: MCP_HOST_FEATURES.filter((each) => each !== MCP_SAMPLING_FEATURE) },
    ],
    ["a Session without a sampler", { sampler: false }],
    ["a stdio server", { server: { ...ALLOWING, entry: { sampling: "allow", type: "stdio" } } }],
  ])("is not declared by %s", async (_name, options) => {
    const { sent } = await setup(options);

    expect(sent[0]?.ctx.answers?.sampling).toBeUndefined();
  });
});
