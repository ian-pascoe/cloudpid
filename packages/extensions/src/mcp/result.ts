// What the model gets for an MCP tool's call (`docs/architecture/mcp-in-a-session.md` → Calls and results): a
// completed `tools/call` result as text and images, and an error for a request that ended without one. The rest of the
// section (spills, the script value, replay) comes with #458.
// @effect-diagnostics missingPipeableSignature:off -- conversions of plain values, not combinators.
import type { McpHostCompleted, McpHostRequestResult, McpProgress } from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";

/** What an MCP tool's call keeps in `details`; `cut` says the Session's end of the call was lost. */
export type McpDetails = {
  readonly server: string;
  readonly tool: string;
  readonly title?: string;
  readonly progress?: McpProgress;
  readonly cut?: "host_lost";
};

/** A content block of a `tools/call` result, as far as the Session reads it. */
const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Struct({ text: Schema.String }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

type ContentBlock = typeof ContentBlock.Type;

/** A `tools/call` result; a block of a type this build does not know keeps only its type. */
const CallToolValue = Schema.Struct({
  content: Schema.Array(ContentBlock).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  structuredContent: Schema.optionalKey(Schema.Json),
  isError: Schema.optionalKey(Schema.Boolean),
});

const decodeCallTool = Schema.decodeUnknownOption(CallToolValue);

/** A content block as the model gets it. */
const blockFor = (block: ContentBlock): TextContent | ImageContent => {
  if ("text" in block) return { type: "text", text: block.text };

  if ("data" in block) return { type: "image", data: block.data, mimeType: block.mimeType };

  if ("resource" in block) return { type: "text", text: block.resource.text };

  return { type: "text", text: `[${block.type} content omitted]` };
};

/** A call that ended without a result: its message, as an error the model reads. */
export const failedWith = (
  message: string,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => ({
  output: [{ type: "text", text: message }],
  isError: true,
  details,
});

/** A `tools/call` result as the model gets it: its content, or its `structuredContent` as JSON when it has none. */
export const resultFor = (
  value: Schema.Json,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => {
  const decoded = decodeCallTool(value);

  if (Option.isNone(decoded)) {
    return failedWith("The server answered with a result this build cannot read", details);
  }

  const { content, structuredContent, isError = false } = decoded.value;

  const fallback =
    structuredContent === undefined
      ? isError
        ? "The tool failed with no message"
        : ""
      : JSON.stringify(structuredContent);

  const output: ReadonlyArray<TextContent | ImageContent> =
    content.length > 0 ? Arr.map(content, blockFor) : [{ type: "text", text: fallback }];

  const result: Mutable<ToolExecutionResult<JsonValue>> = { output: [...output], details };

  if (isError) result.isError = true;

  return result;
};

/** What the model reads when the Session's end of a call was lost: it may have run (`details.cut: "host_lost"`). */
export const hostLostResult = (details: McpDetails): ToolExecutionResult<JsonValue> =>
  failedWith(
    "The MCP host was lost before the call's answer arrived; it may or may not have run.",
    { ...details, cut: "host_lost" },
  );

/** What the model reads for a request that ended without a result. */
export const failureMessage = (result: Exclude<McpHostRequestResult, McpHostCompleted>): string =>
  Match.value(result).pipe(
    Match.tag("CallFailed", ({ error }) =>
      Match.value(error).pipe(
        Match.tag("Cut", (cut) =>
          cut.mayHaveRun
            ? `The call was cut before its answer arrived; it may or may not have run. ${cut.message}`
            : cut.message,
        ),
        Match.orElse((other) => other.message),
      ),
    ),
    Match.orElse((other) => other.message),
  );
