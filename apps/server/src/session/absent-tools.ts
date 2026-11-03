// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over pi's message arrays.
// History that calls tools a request does not declare (`docs/architecture/mcp-endpoint.md` → Session import → Translation, D25).
// An imported transcript calls the laptop's tools (`bash` there, `search` there), which a Session may not have. The import
// keeps those calls, since providers accept history calls to tools the request does not declare when it declares at
// least one, and every cloudpid request does. For a provider that refuses such history, this seam flattens the calls to
// absent tools into text at the request, for that provider only (the stored history is untouched, so a Session that
// moves to another provider sends its calls as they were).
//
// Which providers refuse is what the live probe finds (`import-provider-probe.test.ts`, run with the model proxy's key);
// until it says one does, every provider keeps its calls: `FLATTEN_ABSENT_TOOL_CALLS` is that switch.
import type {
  Api,
  Context,
  Message,
  Model,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";

/**
 * The providers whose requests have calls to tools the request does not declare flattened into text, by provider id. A
 * provider that is not here, or is `false`, keeps them. Set from the probe's result: it has not run against any
 * provider yet, so none is flattened.
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

/**
 * `models` with the requests to the providers `flatten` names having their calls to absent tools flattened
 * (`flattenAbsentToolCalls`); the rest pass as they are.
 */
export const absentToolFlatteningModels = (
  models: Models,
  flatten: (provider: string) => boolean = (provider) =>
    Object.entries(FLATTEN_ABSENT_TOOL_CALLS).some(([name, on]) => name === provider && on),
): Models => {
  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model: Model<Api>, context, options) =>
      models.stream(model, flatten(model.provider) ? flattened(context) : context, options),
    complete: (model: Model<Api>, context, options) =>
      models.complete(model, flatten(model.provider) ? flattened(context) : context, options),
    streamSimple: (model: Model<Api>, context, options) =>
      models.streamSimple(model, flatten(model.provider) ? flattened(context) : context, options),
    completeSimple: (model: Model<Api>, context, options) =>
      models.completeSimple(model, flatten(model.provider) ? flattened(context) : context, options),
  };

  return new Proxy(models, {
    get: (target, key) => {
      if (Object.hasOwn(requests, key)) {
        // SAFETY: `key` is one of the request methods, checked just above.
        return requests[key as keyof typeof requests];
      }

      // SAFETY: every other property is read from the models object itself, as its own type describes it.
      const value: unknown = target[key as keyof Models];

      // Methods run on the models object itself, whose private state a proxy would not have.
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};
