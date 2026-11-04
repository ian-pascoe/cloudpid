// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values.
// What the owner reads of a Sampling request (`docs/architecture/mcp-server-requests.md` → Sampling requests, The card): the
// record's own text, flattened to plain lines. The card and a settled record's view are made of the same record, which the
// sampler redacted of the Session's Secrets before it was kept, so nothing here reads the server's request again.
import type { McpSamplingRecordView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { cutText, type McpSamplingRecord } from "./sampling-records.ts";

/** The most messages a card shows: the last ones, with the count left out beside them. */
export const CARD_MESSAGES = 20;

/** The longest text a card shows for one message or the system prompt, in characters. */
export const CARD_TEXT = 4000;

/** The longest a tool's input or a result is quoted in a message's line, in characters. */
const QUOTED = 500;

const isRecord = (
  value: Schema.Json | undefined,
): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value) && !Arr.isArray(value);

const isList = (value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> =>
  Arr.isArray(value);

const textOf = (value: Schema.Json | undefined): string => (Predicate.isString(value) ? value : "");

/** One content block of a kept message, as a line of text. */
const lineOf = (block: Schema.Json): string => {
  if (!isRecord(block)) return "";

  switch (block.type) {
    case "text":
      return textOf(block.text);
    case "image":
      return `[image: ${textOf(block.mimeType)}]`;
    case "audio":
      return `[audio: ${textOf(block.mimeType)}]`;
    case "tool_use":
      return `[tool use: ${textOf(block.name)} ${cutText(JSON.stringify(block.input ?? {}), QUOTED)}]`;
    case "tool_result":
      return `[tool result${block.isError === true ? " (error)" : ""}: ${cutText(textOf(block.text), QUOTED)}]`;
    default:
      return "";
  }
};

/** A message's content, a block or a list of them, as a list. */
const blocksOf = (content: Schema.Json | undefined): ReadonlyArray<Schema.Json> => {
  if (content === undefined) return [];

  return isList(content) ? content : [content];
};

/** The messages of a record as the card lists them: the last `CARD_MESSAGES`, each as plain text. */
export const cardMessages = (messages: ReadonlyArray<Schema.Json> | undefined) => {
  const kept = messages ?? [];
  const shown = kept.slice(-CARD_MESSAGES);

  return {
    omitted: kept.length - shown.length,
    messages: Arr.filterMap(shown, (message) => {
      if (!isRecord(message)) return Result.failVoid;

      const content = message.content;
      const blocks = blocksOf(content);

      return Result.succeed({
        role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: cutText(Arr.join(Arr.map(blocks, lineOf), "\n"), CARD_TEXT),
      });
    }),
  };
};

/** A settled (or waiting) record as `mcp_sampling_get` answers it. */
export const recordView = (record: McpSamplingRecord): McpSamplingRecordView => {
  const shown = cardMessages(record.messages);

  const view: Mutable<McpSamplingRecordView> = {
    id: record.id,
    callId: record.callId,
    server: record.server,
    tool: record.tool,
    status: record.status,
    by: record.by,
    messages: shown.messages,
    tools: Arr.map(record.tools ?? [], (name) => ({ name })),
    notes: record.notes,
    askedAt: record.askedAt,
  };

  if (shown.omitted > 0) view.omitted = shown.omitted;

  if (record.reason !== undefined) view.reason = record.reason;

  if (record.role !== undefined) view.role = record.role;

  if (record.model !== undefined) view.model = record.model;

  if (record.systemPrompt !== undefined)
    view.systemPrompt = cutText(record.systemPrompt, CARD_TEXT);

  if (record.reply !== undefined) view.reply = replyText(record.reply);

  if (record.stopReason !== undefined) view.stopReason = record.stopReason;

  if (record.tokens !== undefined) view.tokens = record.tokens;

  if (record.cost !== undefined) view.cost = record.cost;

  if (record.settledAt !== undefined) view.settledAt = record.settledAt;

  if (record.stub === true) view.stub = true;

  return view;
};

/** A kept reply (`McpSamplingResult.content`: a block or a list of them) as the text a card shows. */
const replyText = (reply: Schema.Json): string =>
  cutText(Arr.join(Arr.map(blocksOf(reply), lineOf), "\n"), CARD_TEXT);
