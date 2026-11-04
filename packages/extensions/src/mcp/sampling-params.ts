// @effect-diagnostics missingPipeableSignature:off missedPipeableOpportunity:off -- plain functions over values.
// What a server's `sampling/createMessage` asks (`docs/architecture/mcp-server-requests.md` → Sampling requests; ADR-0039),
// as the Session reads it: the parameters of the spec's 2025-11-25 revision, decoded from the JSON the core hands over
// (`McpInputRequest.params`), so nothing downstream reads an unchecked value. Keys cloudpid does not use (`_meta`,
// `task`, `metadata`) are dropped by the decode; a request with a shape the spec does not allow is refused as invalid.
import { JsonObject } from "@cloudpid/mcp/types";
import * as Schema from "effect/Schema";

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const Image = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

const Audio = Schema.Struct({
  type: Schema.Literal("audio"),
  data: Schema.String,
  mimeType: Schema.String,
});

const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: JsonObject,
});

const ResourceLink = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
});

const EmbeddedResource = Schema.Struct({
  type: Schema.Literal("resource"),
  resource: Schema.Union([
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optionalKey(Schema.String),
      text: Schema.String,
    }),
    Schema.Struct({
      uri: Schema.String,
      mimeType: Schema.optionalKey(Schema.String),
      blob: Schema.String,
    }),
  ]),
});

/** What a `tool_result` may hold: the spec's content blocks. */
const ResultContent = Schema.Union([Text, Image, Audio, ResourceLink, EmbeddedResource]);

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolUseId: Schema.String,
  content: Schema.Array(ResultContent),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
});

const Block = Schema.Union([Text, Image, Audio, ToolUse, ToolResult]);

export type SamplingBlock = typeof Block.Type;

export type SamplingResultContent = typeof ResultContent.Type;

export const SamplingMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Union([Block, Schema.Array(Block)]),
});

export type SamplingMessage = typeof SamplingMessage.Type;

const SamplingTool = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.Json,
});

export type SamplingTool = typeof SamplingTool.Type;

export const SamplingParams = Schema.Struct({
  messages: Schema.Array(SamplingMessage),
  systemPrompt: Schema.optionalKey(Schema.String),
  modelPreferences: Schema.optionalKey(
    Schema.Struct({
      hints: Schema.optionalKey(
        Schema.Array(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
      ),
      costPriority: Schema.optionalKey(Schema.Finite),
      speedPriority: Schema.optionalKey(Schema.Finite),
      intelligencePriority: Schema.optionalKey(Schema.Finite),
    }),
  ),
  includeContext: Schema.optionalKey(Schema.String),
  temperature: Schema.optionalKey(Schema.Finite),
  maxTokens: Schema.Finite,
  stopSequences: Schema.optionalKey(Schema.Array(Schema.String)),
  tools: Schema.optionalKey(Schema.Array(SamplingTool)),
  toolChoice: Schema.optionalKey(
    Schema.Struct({ mode: Schema.optionalKey(Schema.Literals(["auto", "required", "none"])) }),
  ),
});

export type SamplingParams = typeof SamplingParams.Type;

export const decodeSamplingParams = Schema.decodeUnknownOption(SamplingParams);

/** A message's content as a list of blocks. */
export const blocksOf = (message: SamplingMessage): ReadonlyArray<SamplingBlock> =>
  "type" in message.content ? [message.content] : message.content;
