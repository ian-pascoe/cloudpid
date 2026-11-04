// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values, with loops that end early.
// A Sampling request's messages: the spec's pairing rules, checked before the owner is asked and before the sample (pi-ai
// repairs a mismatch silently, so the check is cloudpid's), and their mapping onto pi-ai's messages
// (`docs/architecture/mcp-server-requests.md` → Sampling requests, Content; #387 D11, D15).
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  Api,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import {
  blocksOf,
  type SamplingBlock,
  type SamplingMessage,
  type SamplingResultContent,
} from "./sampling-params.ts";

/** The longest a text block may be, in characters: the spec's text bound of 1 MiB. */
export const SAMPLING_TEXT_MAX = 1024 * 1024;

type ToolUseBlock = Extract<SamplingBlock, { readonly type: "tool_use" }>;

type ToolResultBlock = Extract<SamplingBlock, { readonly type: "tool_result" }>;

const isToolUse = (block: SamplingBlock): block is ToolUseBlock => block.type === "tool_use";

const isToolResult = (block: SamplingBlock): block is ToolResultBlock =>
  block.type === "tool_result";

/**
 * The first pairing rule the messages break, in words, or undefined when none: a user message with a `tool_result` holds
 * only tool results; `tool_use` is the assistant's and `tool_result` the user's; every assistant `tool_use` is answered
 * exactly once, in the next message; and no `tool_result` is left without its `tool_use`.
 */
export const pairingProblem = (messages: ReadonlyArray<SamplingMessage>): string | undefined => {
  for (const [index, message] of messages.entries()) {
    const blocks = blocksOf(message);
    const uses = Arr.filter(blocks, isToolUse);
    const results = Arr.filter(blocks, isToolResult);

    if (message.role === "user" && uses.length > 0)
      return "tool_use belongs in an assistant message";

    if (message.role === "assistant" && results.length > 0) {
      return "tool_result belongs in a user message";
    }

    if (results.length > 0 && results.length !== blocks.length) {
      return "a user message with a tool_result holds only tool results";
    }

    const next = messages[index + 1];

    if (uses.length > 0) {
      const answered = next === undefined ? [] : Arr.filter(blocksOf(next), isToolResult);
      const ids = Arr.map(answered, (result) => result.toolUseId);

      for (const use of uses) {
        const count = Arr.filter(ids, (id) => id === use.id).length;

        if (count !== 1) {
          return `tool_use "${use.id}" must be answered exactly once in the next message`;
        }
      }
    }

    if (results.length > 0) {
      const before = index === 0 ? undefined : messages[index - 1];

      const called =
        before === undefined
          ? []
          : Arr.map(Arr.filter(blocksOf(before), isToolUse), (use) => use.id);

      for (const result of results) {
        if (!called.includes(result.toolUseId)) {
          return `tool_result "${result.toolUseId}" has no tool_use before it`;
        }
      }

      if (results.length !== called.length) {
        return "a message's tool results must answer every tool_use before it";
      }
    }
  }

  return undefined;
};

/** The size of the data `base64` stands for, in bytes. */
const base64Bytes = (base64: string): number =>
  Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

/** A tool result's content block as pi-ai text or image (`#387` D15.2); `undefined` for an image the model cannot take. */
const resultBlock = (
  block: SamplingResultContent,
  takesImages: boolean,
): TextContent | ImageContent | undefined => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return takesImages
        ? { type: "image", data: block.data, mimeType: block.mimeType }
        : undefined;
    case "audio":
      return { type: "text", text: "[audio omitted]" };
    case "resource_link":
      return { type: "text", text: `[resource: ${block.uri}]` };
    case "resource": {
      const { resource } = block;

      return "text" in resource
        ? { type: "text", text: resource.text }
        : {
            type: "text",
            text: `[binary resource: ${resource.uri}, ${resource.mimeType ?? "unknown type"}, ${base64Bytes(resource.blob)} bytes]`,
          };
    }
  }
};

/** What a request's messages come to for a model: pi-ai's messages, or the reason the model cannot be asked them. */
export type Converted =
  | { readonly kind: "messages"; readonly messages: Array<Message> }
  | { readonly kind: "refused"; readonly reason: string };

const NO_IMAGES = "the model takes no images";

const NO_AUDIO = "audio is not supported";

const TOO_LONG = "a text block is over 1 MiB";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * `messages` as pi-ai's, for `model`: a `tool_use` is a `toolCall`, a `tool_result` one `toolResult` of its own (the
 * server's tool name, from the call it answers), the content inside a result flattened. Audio, and an image for a model
 * that takes none, refuse the request. The messages must have passed `pairingProblem`.
 */
export const toPiMessages = (
  messages: ReadonlyArray<SamplingMessage>,
  model: Pick<Model<Api>, "api" | "provider" | "id" | "input">,
  now: number,
): Converted => {
  const takesImages = model.input.includes("image");
  const names = new Map<string, string>();
  const out: Array<Message> = [];

  for (const message of messages) {
    const blocks = blocksOf(message);

    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];

      for (const block of blocks) {
        if (block.type === "text") {
          if (block.text.length > SAMPLING_TEXT_MAX) return { kind: "refused", reason: TOO_LONG };

          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          names.set(block.id, block.name);

          const call: ToolCall = {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.input,
          };

          content.push(call);
        } else {
          return { kind: "refused", reason: "an assistant message holds only text and tool uses" };
        }
      }

      out.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: now,
      });

      continue;
    }

    const user: UserMessage["content"] & Array<TextContent | ImageContent> = [];

    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text.length > SAMPLING_TEXT_MAX) return { kind: "refused", reason: TOO_LONG };

        user.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        if (!takesImages) return { kind: "refused", reason: NO_IMAGES };

        user.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else if (block.type === "audio") {
        return { kind: "refused", reason: NO_AUDIO };
      } else if (block.type === "tool_result") {
        const inside = Arr.filterMap(block.content, (part) => {
          if (part.type === "text" && part.text.length > SAMPLING_TEXT_MAX) return Result.failVoid;

          const mapped = resultBlock(part, takesImages);

          return mapped === undefined ? Result.failVoid : Result.succeed(mapped);
        });

        if (inside.length < block.content.length) {
          const long = Arr.some(
            block.content,
            (part) => part.type === "text" && part.text.length > SAMPLING_TEXT_MAX,
          );

          return { kind: "refused", reason: long ? TOO_LONG : NO_IMAGES };
        }

        const hasText = Arr.some(block.content, (part) => part.type === "text");

        if (!hasText && block.structuredContent !== undefined) {
          inside.push({ type: "text", text: JSON.stringify(block.structuredContent) });
        }

        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: block.toolUseId,
          toolName: names.get(block.toolUseId) ?? "",
          content: inside,
          isError: block.isError === true,
          timestamp: now,
        };

        out.push(result);
      }
    }

    if (user.length > 0) out.push({ role: "user", content: user, timestamp: now });
  }

  return { kind: "messages", messages: out };
};
