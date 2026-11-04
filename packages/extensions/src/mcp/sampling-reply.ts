// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values.
// What a sample's reply becomes for the server (`docs/architecture/mcp-server-requests.md` → Sampling requests, The reply;
// #387 D11.4): the model's text and tool uses as written, its thinking dropped, its stop reason in the spec's words, and
// the id of the model that answered. A reply that is a failure (an `error` or `aborted` stop, or a tool call whose
// arguments did not parse) is a model failure, never a result.
import type { JsonObject, McpSamplingResult } from "@cloudpid/mcp/types";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";

/** What a reply comes to: the result the server gets, or why the model failed. */
export type Replied =
  | { readonly kind: "reply"; readonly result: McpSamplingResult; readonly stopReason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** The spec's stop reason for each of the model's that ends a reply. */
const stopReasonOf = (reason: AssistantMessage["stopReason"]): string | undefined => {
  switch (reason) {
    case "stop":
      return "endTurn";
    case "length":
      return "maxTokens";
    case "toolUse":
      return "toolUse";
    default:
      return undefined;
  }
};

type ReplyBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
    };

/**
 * `message` as the server's `CreateMessageResult`. With tools offered, `content` is the list of text and `tool_use`
 * blocks; without, one text block (the model's text, joined).
 */
export const replyOf = (message: AssistantMessage, withTools: boolean): Replied => {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      kind: "failed",
      reason:
        message.errorMessage ??
        `the model ${message.stopReason === "aborted" ? "was stopped" : "failed"}`,
    };
  }

  const stopReason = stopReasonOf(message.stopReason);

  if (stopReason === undefined) {
    return {
      kind: "failed",
      reason: `the model ended with an unexpected stop (${message.stopReason})`,
    };
  }

  const blocks: Array<ReplyBlock> = [];
  const texts: Array<string> = [];

  for (const part of message.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      texts.push(part.text);
    } else if (part.type === "toolCall") {
      if (part.argumentsError !== undefined) {
        return { kind: "failed", reason: "the model's tool call could not be read" };
      }

      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments });
    }
  }

  return {
    kind: "reply",
    stopReason,
    result: {
      role: "assistant",
      content: withTools ? blocks : { type: "text", text: Arr.join(texts, "") },
      model: message.responseModel ?? message.model,
      stopReason,
    },
  };
};
