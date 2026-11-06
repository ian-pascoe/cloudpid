// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- pi-durable tools are Promise code.
// Tool spans (`docs/architecture/operations.md` → Telemetry): every tool's call is a `pi.tool` span of the Session's telemetry,
// whether the tool is Effect, native, or run by a codemode script as a nested call. Arguments and results are never
// recorded; a tool may add fixed values and counts of its own (`annotateToolSpan`).
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import * as Arr from "effect/Array";
import { listToolSpan } from "@cloudpid/effect-durable";

export const extensionName = "telemetry";

/** `tool` with its call a `pi.tool` span of `telemetry`. */
const traced = (telemetry: TelemetryContext, tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: (args, api, context) =>
    telemetry.startSpan(
      {
        name: `pi.tool.${tool.name}`,
        attributes: {
          "tool.name": tool.name,
          "tool.call_id": api.callId,
          "conversation.id": api.conversationId,
          "task.id": api.taskId,
        },
      },
      async (span) => {
        // The tool's own counts reach its span by the call's ID (`annotateToolSpan`), for as long as the call runs.
        const unlist = listToolSpan(api.callId, (attributes) => {
          span.setAttributes(attributes);
        });

        const result = await tool.execute(args, api, context).finally(unlist);

        span.setAttributes({ "tool.is_error": result.isError === true });

        if (result.isError === true) {
          span.setStatus({ status: "error", error: { name: "tool_error", message: "" } });
        }

        return result;
      },
    ),
});

/**
 * An extension that wraps each of `tools` so its calls are traced. Install it after the extensions that bring the
 * tools: it wraps what the others' wraps made, so the span covers them.
 */
export const tracingTools = (
  telemetry: TelemetryContext,
  tools: ReadonlyArray<ToolRegistration>,
): Extension =>
  defineExtension({
    name: extensionName,
    wraps: Arr.map(tools, (tool) => wrapTool(tool, (wrapped) => traced(telemetry, wrapped))),
  });
