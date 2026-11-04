// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over pi's message arrays.
// History that calls tools a request does not declare (`docs/architecture/mcp-endpoint.md` → Session import → Translation → Tool calls).
// An imported transcript calls the laptop's tools (`bash` there, `search` there), which a Session may not have. The import
// keeps those calls, since providers accept history calls to tools the request does not declare when it declares at
// least one, and every cloudpid request does. For a provider that refuses such history, this seam flattens the calls to
// absent tools into text at the request, for that provider only (the stored history is untouched, so a Session that
// moves to another provider sends its calls as they were).
//
// Which providers refuse is what the live probe finds (`import-provider-probe.test.ts`, run with the model proxy's key,
// an owner check on the pull request); until it says one does, every provider keeps its calls: `FLATTEN_ABSENT_TOOL_CALLS`
// is that switch.
import { contextMappedModels } from "@cloudpid/extensions/models";
import type {
  Api,
  Context,
  Message,
  Model,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";

/**
 * The providers whose requests have calls to tools the request does not declare flattened into text, by provider id. A
 * provider that is not here, or is `false`, keeps them. Set from the probe's result: it has not run against any
 * provider yet, so none is flattened.
 *
 * Turning one on has a cost: the flattening reaches every Session's requests to that provider, not only an imported
 * one's (the seam sees messages, not where they came from), so a Session that is no import and whose history calls a
 * tool that is not declared now (a deferred one, one a subagent had) has that call sent as text. The text is the same on
 * every request, so the prompt cache holds from the second request on, but the first one after the switch is turned on
 * misses it. A switch is turned on for a provider that refuses the calls, where the alternative is a request that fails.
 */
export const FLATTEN_ABSENT_TOOL_CALLS = {
  anthropic: false,
} satisfies Readonly<Record<string, boolean>>;

/** The text of a tool result: its text parts, and a word for each image. */
const resultText = (result: ToolResultMessage): string =>
  Arr.join(
    Arr.map(result.content, (part) => (part.type === "text" ? part.text : "[image]")),
    "\n",
  );

/**
 * `messages` with every call to a tool not in `declared` flattened into text of its assistant message, with its result
 * after it, and that result's own message left out: a result is no result without its call. Messages with nothing to
 * flatten are returned as they are, and so is the whole list when there is nothing.
 */
export const flattenAbsentToolCalls = (
  messages: ReadonlyArray<Message>,
  declared: ReadonlySet<string>,
): ReadonlyArray<Message> => {
  const absent = (name: string) => !declared.has(name);

  const flattens = Arr.some(
    messages,
    (message) =>
      message.role === "assistant" &&
      Arr.some(message.content, (part) => part.type === "toolCall" && absent(part.name)),
  );

  if (!flattens) return messages;

  const results = new Map<string, ToolResultMessage>();

  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }

  const flattened = new Set<string>();

  return Arr.flatMap(messages, (message): ReadonlyArray<Message> => {
    if (message.role === "toolResult") return flattened.has(message.toolCallId) ? [] : [message];

    if (message.role !== "assistant") return [message];

    return [
      {
        ...message,
        content: Arr.map(message.content, (part) => {
          if (part.type !== "toolCall" || !absent(part.name)) return part;

          flattened.add(part.id);

          const result = results.get(part.id);

          return {
            type: "text" as const,
            text: `[Called ${part.name} ${JSON.stringify(part.arguments)}${result === undefined ? "" : `, ${result.isError ? "which failed" : "which returned"}: ${resultText(result)}`}]`,
          };
        }),
      },
    ];
  });
};

/** `context` with the calls to its absent tools flattened, if there are any. */
const flattened = (context: Context): Context => {
  const declared = new Set(Arr.map(context.tools ?? [], (tool) => tool.name));
  const messages = flattenAbsentToolCalls(context.messages, declared);

  return messages === context.messages ? context : { ...context, messages: [...messages] };
};

/** Whether requests to `provider` have their calls to absent tools flattened (`FLATTEN_ABSENT_TOOL_CALLS`). */
export const flattensFor = (provider: string): boolean =>
  Object.entries(FLATTEN_ABSENT_TOOL_CALLS).some(([name, on]) => name === provider && on);

/**
 * `context` as a request to `model` carries it: its calls to absent tools flattened when the model's provider is one
 * `flatten` says refuses them, as it is otherwise.
 */
export const mapFor = (
  model: Model<Api>,
  context: Context,
  flatten: (provider: string) => boolean = flattensFor,
): Context => (flatten(model.provider) ? flattened(context) : context);

/**
 * `models` with the requests to the providers `flatten` names having their calls to absent tools flattened
 * (`flattenAbsentToolCalls`); the rest pass as they are.
 */
export const absentToolFlatteningModels = (
  models: Models,
  flatten: (provider: string) => boolean = flattensFor,
): Models => contextMappedModels(models, (model, context) => mapFor(model, context, flatten));
