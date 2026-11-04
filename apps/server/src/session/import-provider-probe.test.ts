// @effect-diagnostics asyncFunction:off globalFetch:off processEnv:off preferEffectArray:off preferEffectRecord:off -- a live probe: plain Promise code over the model proxy, and arrays of fixtures.
// The live provider probe of a Session import (`docs/architecture/mcp-endpoint.md` → Session import → Translation → Tool calls).
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
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { flattensFor, flattenAbsentToolCalls } from "./absent-tools.ts";
import { NOT_RUN_TEXT } from "./import-translate.ts";
import { proxyModels } from "./models.ts";

const url = process.env["MODEL_PROXY_URL"];
const apiKey = process.env["MODEL_PROXY_API_KEY"];

/** The models of each provider the proxy serves, as `provider` and the ids of its models, in `SUPPORTED_MODELS` order. */
const providers = (() => {
  const byProvider = new Map<string, string[]>();

  for (const id of SUPPORTED_MODELS) {
    const { provider, modelId } = parseModelId(id);

    byProvider.set(provider, [...(byProvider.get(provider) ?? []), modelId]);
  }

  return byProvider;
})();

/** The model each provider is probed with: the cheapest, by its name, else the first. */
const probed = [...providers].map(([provider, ids]): [string, string] => [
  provider,
  ids.find((id) => id.includes("haiku")) ?? ids[0] ?? "",
]);

/** The probed model's provider, with a model of it that is not the probed one, whose history it is sent: none for a provider with one model. */
const crossModel = probed.flatMap(([provider, modelId]): Array<[string, string, string]> => {
  const other = providers.get(provider)?.find((id) => id !== modelId);

  return other === undefined ? [] : [[provider, modelId, other]];
});

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

/** The model whose answers a history holds: what an assistant message records of its author. */
type Author = Pick<Model<Api>, "api" | "provider" | "id">;

const assistant = (
  author: Author,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: author.api,
  provider: author.provider,
  model: author.id,
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

/** The history an import leaves, answered by `author`: the laptop's calls (one answered, one closed as the import closes it), none declared by the request. */
const history = (author: Author): Message[] => [
  user("List the files, then tell me how many there are."),
  assistant(
    author,
    [
      { type: "text", text: "I'll run ls." },
      { type: "toolCall", id: "toolu_probe_1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "toolu_probe_2", name: "laptop_only_tool", arguments: {} },
    ],
    "toolUse",
  ),
  result("toolu_probe_1", "bash", "a.txt\nb.txt", false),
  result("toolu_probe_2", "laptop_only_tool", NOT_RUN_TEXT, true),
  assistant(author, [{ type: "text", text: "There are two files." }], "stop"),
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

    /** The catalog's model `provider/modelId`. */
    const modelOf = (provider: string, modelId: string): Model<Api> => {
      const model = models.getModel(provider, modelId);

      if (model === undefined) throw new Error(`${provider}/${modelId} is not in the catalog`);

      return model;
    };

    /** What the provider answers to `messages`: an error text, or none when it took them. */
    const refusal = async (model: Model<Api>, messages: ReadonlyArray<Message>) => {
      const reply = await models.completeSimple(model, context(messages), { maxTokens: 64 });

      return reply.stopReason === "error" || reply.stopReason === "aborted"
        ? (reply.errorMessage ?? "the request failed")
        : undefined;
    };

    /** A history with no call at all must be taken: otherwise the key, the URL or the network is what fails, not the history. */
    const control = async (model: Model<Api>) => {
      const failed = await refusal(model, [user("Reply with just: OK")]);

      if (failed !== undefined) {
        throw new Error(
          `The control request to ${model.provider} failed (${failed}): check MODEL_PROXY_URL and MODEL_PROXY_API_KEY.`,
        );
      }
    };

    it.each(probed)(
      "%s: its switch matches what it does with the calls kept",
      async (provider, modelId) => {
        const model = modelOf(provider, modelId);

        await control(model);

        const refused = await refusal(model, history(model));

        expect(
          flattensFor(provider),
          refused === undefined
            ? `${provider} accepts the calls, so FLATTEN_ABSENT_TOOL_CALLS.${provider} must be false`
            : `${provider} refuses the calls (${refused}), so FLATTEN_ABSENT_TOOL_CALLS.${provider} must be true`,
        ).toBe(refused !== undefined);
      },
      60_000,
    );

    // A Session that moves to another model of the provider sends a history another model of it wrote.
    it.each(crossModel)(
      "%s/%s: the calls another model of the provider made match its switch",
      async (provider, modelId, otherId) => {
        const model = modelOf(provider, modelId);

        await control(model);

        const refused = await refusal(model, history(modelOf(provider, otherId)));

        expect(
          flattensFor(provider),
          refused === undefined
            ? `${provider}/${modelId} accepts the calls of ${otherId}`
            : `${provider}/${modelId} refuses the calls of ${otherId} (${refused}), so FLATTEN_ABSENT_TOOL_CALLS.${provider} must be true`,
        ).toBe(refused !== undefined);
      },
      60_000,
    );

    it.each(probed)(
      "%s: flattened into text, the history is accepted",
      async (provider, modelId) => {
        const model = modelOf(provider, modelId);

        await control(model);

        const flattened = flattenAbsentToolCalls(history(model), new Set(["lookup"]));

        expect(JSON.stringify(flattened)).not.toContain('"type":"toolCall"');
        expect(await refusal(model, flattened)).toBeUndefined();
      },
      60_000,
    );
  },
);
