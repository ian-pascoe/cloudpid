// @effect-diagnostics asyncFunction:off globalFetch:off processEnv:off preferEffectArray:off preferEffectRecord:off -- a live probe: plain Promise code over the model proxy, and arrays of fixtures.
// The live provider probe of a Session import (`docs/architecture/mcp-endpoint.md` → Session import → Translation, D25.3).
// An imported transcript calls tools the Session's requests do not declare. This sends each provider cloudpid serves
// (`SUPPORTED_MODELS`) a history with such calls, in a request that declares one tool, through the model proxy
// (Commissary), and checks what the provider does with it:
//
// - a provider that accepts it keeps the calls as they are (`FLATTEN_ABSENT_TOOL_CALLS[provider]` is false);
// - a provider that rejects it has them flattened into text (`absent-tools.ts`), for that provider only (the switch is
//   true), and the flattened history must be accepted.
//
// It costs a few small requests, so it is opt-in: it runs only with the proxy's URL and key in the environment, and is
// skipped without them, as in CI.
//
//   MODEL_PROXY_URL=https://api.ai.ianpascoe.dev MODEL_PROXY_API_KEY=<a Commissary key> \
//     bun --cwd apps/server vitest run src/session/import-provider-probe.test.ts
//
// A failure of the first test names the provider and what to change; the second fails only if flattening does not work
// for a provider.
import { parseModelId, SUPPORTED_MODELS } from "@cloudpid/config";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { flattenAbsentToolCalls, FLATTEN_ABSENT_TOOL_CALLS } from "./absent-tools.ts";
import { NOT_RUN_TEXT } from "./import-translate.ts";
import { proxyModels } from "./models.ts";

const url = process.env["MODEL_PROXY_URL"];
const apiKey = process.env["MODEL_PROXY_API_KEY"];

/** One model of each provider the proxy serves: the cheapest, by its name, else the first. */
const probed = (() => {
  const byProvider = new Map<string, string>();

  for (const id of SUPPORTED_MODELS) {
    const { provider, modelId } = parseModelId(id);
    const held = byProvider.get(provider);

    if (held === undefined || (modelId.includes("haiku") && !held.includes("haiku"))) {
      byProvider.set(provider, modelId);
    }
  }

  return [...byProvider];
})();

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-haiku-5-5",
  usage,
  stopReason,
  timestamp: 2,
});

const result = (id: string, name: string, text: string, isError: boolean): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: 3,
});

/** The history an import leaves: the laptop's calls (one answered, one closed as the import closes it), none declared by the request. */
const history = (): Message[] => [
  user("List the files, then tell me how many there are."),
  assistant(
    [
      { type: "text", text: "I'll run ls." },
      { type: "toolCall", id: "toolu_probe_1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "toolu_probe_2", name: "laptop_only_tool", arguments: {} },
    ],
    "toolUse",
  ),
  result("toolu_probe_1", "bash", "a.txt\nb.txt", false),
  result("toolu_probe_2", "laptop_only_tool", NOT_RUN_TEXT, true),
  assistant([{ type: "text", text: "There are two files." }], "stop"),
  user("[cloudpid import] This conversation was imported from a pi Session. Reply with just: OK"),
];

const context = (messages: ReadonlyArray<Message>): Context => ({
  systemPrompt: "You are a terse assistant.",
  messages: [...messages],
  tools: [
    {
      name: "lookup",
      description: "Look a word up.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  ],
});

describe.skipIf(url === undefined || apiKey === undefined)(
  "a provider's acceptance of history that calls tools the request does not declare",
  () => {
    const models = proxyModels({ url: url ?? "", apiKey: apiKey ?? "" });

    /** What the provider answers to `messages`: an error text, or none when it took them. */
    const refusal = async (provider: string, modelId: string, messages: ReadonlyArray<Message>) => {
      const model = models.getModel(provider, modelId);

      if (model === undefined) throw new Error(`${provider}/${modelId} is not in the catalog`);

      const reply = await models.completeSimple(model, context(messages), { maxTokens: 64 });

      return reply.stopReason === "error" || reply.stopReason === "aborted"
        ? (reply.errorMessage ?? "the request failed")
        : undefined;
    };

    /** A history with no call at all must be taken: otherwise the key, the URL or the network is what fails, not the history. */
    const control = async (provider: string, modelId: string) => {
      const failed = await refusal(provider, modelId, [user("Reply with just: OK")]);

      if (failed !== undefined) {
        throw new Error(
          `The control request to ${provider} failed (${failed}): check MODEL_PROXY_URL and MODEL_PROXY_API_KEY.`,
        );
      }
    };

    it.each(probed)(
      "%s: its switch matches what it does with the calls kept",
      async (provider, modelId) => {
        await control(provider, modelId);

        const refused = await refusal(provider, modelId, history());

        const flattens = Object.entries(FLATTEN_ABSENT_TOOL_CALLS).some(
          ([name, on]) => name === provider && on,
        );

        expect(
          flattens,
          refused === undefined
            ? `${provider} accepts the calls, so FLATTEN_ABSENT_TOOL_CALLS.${provider} must be false`
            : `${provider} refuses the calls (${refused}), so FLATTEN_ABSENT_TOOL_CALLS.${provider} must be true`,
        ).toBe(refused !== undefined);
      },
      60_000,
    );

    it.each(probed)(
      "%s: flattened into text, the history is accepted",
      async (provider, modelId) => {
        await control(provider, modelId);

        const flattened = flattenAbsentToolCalls(history(), new Set(["lookup"]));

        expect(JSON.stringify(flattened)).not.toContain('"type":"toolCall"');
        expect(await refusal(provider, modelId, flattened)).toBeUndefined();
      },
      60_000,
    );
  },
);
