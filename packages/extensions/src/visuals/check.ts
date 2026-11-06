// docs/architecture/visuals.md → Tools (visual_check), The check, Telemetry. `visual_check`: the page of a `path` or `html` call is
// prepared as `visual_show` prepares it (`./prepare.ts`: inlined, redacted, checked, bounded) and handed to the Session's
// browser host, which renders it in a throwaway context of the Session's browser (`BrowserHost.checkVisual`, `apps/browser`)
// and says what it measured and saw. The result is a JPEG screenshot and a text of the findings; nothing is shown or kept. The
// browser is noted as used for the idle close, as a `browser` run is. The call's `pi.tool.visual_check` span gains counts and
// fixed values only, never the page, its path, console text or hosts.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a tool definition and plain builders.
import {
  annotateToolSpan,
  defineEffectTool,
  type ToolSpanAttributes,
} from "@cloudpid/effect-durable";
import { base64Bytes, VISUAL_CHECK, VISUAL_THREAD_WIDTH, VisualChecked } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import {
  BrowserHost,
  type BrowserOutputPart,
  type VisualCheckInput,
  type VisualCheckResult,
  VISUAL_CHECK_UNAVAILABLE,
} from "../browser/host.ts";
import { BrowserSession } from "../browser/session.ts";
import { Secrets } from "../secrets/store.ts";
import { asOutput, outputSchema } from "../outputs.ts";
import { VISUAL_CHECK_DESCRIPTION } from "./guidance.ts";
import { prepareVisual, type PreparedVisual, VisualShowError } from "./prepare.ts";
import { visualFilesOf } from "./tool.ts";

/** The narrowest and widest page a check renders: a phone's, and a wide desktop's. */
const MIN_WIDTH = 200;
const MAX_WIDTH = 2_000;

const Parameters = Schema.Struct({
  path: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "An HTML file of this Workspace (absolute, or relative to the working directory); give this or html",
    }),
  ),
  html: Schema.optionalKey(
    Schema.String.annotate({
      description: "The page itself, one HTML document; give this or path",
    }),
  ),
  width: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_WIDTH, maximum: MAX_WIDTH })).annotate({
      description: `The page's width in px, from ${MIN_WIDTH} to ${MAX_WIDTH}; default ${VISUAL_THREAD_WIDTH}, the thread's column on a desktop (about 360 on a phone)`,
    }),
  ),
  theme: Schema.optionalKey(
    Schema.Literals(["light", "dark"]).annotate({
      description: 'The color scheme the page is rendered in: "light" (default) or "dark"',
    }),
  ),
  top: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description:
        "Where the screenshot starts, in px from the top of the page; default 0. It shows at most 3,000 px",
    }),
  ),
});

/** A check that could not run: the browser is unavailable, or the Browsers Worker has no check yet. */
export class VisualCheckError extends Schema.TaggedError<
  VisualCheckError,
  { readonly brand: unique symbol }
>()("VisualCheckError", {
  kind: Schema.Literals(["not_checked", "unavailable"]),
  message: Schema.String,
}) {}

/** How a failed host call reads to the model. */
const unchecked = (message: string): VisualCheckError =>
  message.includes(VISUAL_CHECK_UNAVAILABLE)
    ? VisualCheckError.make({
        kind: "unavailable",
        message:
          "visual_check is unavailable: the browser host does not support it yet, so nothing was checked. Show the page without a check, or try again later.",
      })
    : VisualCheckError.make({
        kind: "not_checked",
        message: `Not checked: the browser could not render the page (${message}). Try again, or show the page without a check.`,
      });

/** The findings as the text the model reads: what to look at first, then what the page did. */
export const describeCheck = (
  input: VisualCheckInput,
  result: VisualCheckResult,
  prepared: ReadonlyArray<string>,
): string => {
  const { screenshot } = result;

  const shown =
    screenshot === undefined
      ? "There is no screenshot (see the warnings)."
      : `The screenshot shows ${screenshot.top} to ${screenshot.top + screenshot.height} px${
          result.clipped
            ? `, not the whole page: check again with top ${screenshot.top + screenshot.height} to see on`
            : ""
        }.`;

  const lines = [
    `Checked at ${input.width} px wide in the ${input.theme} theme. The page is ${result.contentHeight} px tall. ${shown}`,
  ];

  if (result.growth.grows) {
    lines.push(
      `The page grows after each time its frame is resized (heights ${Arr.join(Arr.map(result.growth.heights, String), ", ")}): its height follows its frame's, so the frame will freeze it where it is. Look for sizes taken from the window or the frame, such as a script that sets a height from innerHeight.`,
    );
  }

  const section = (title: string, items: ReadonlyArray<string>) => {
    if (items.length > 0)
      lines.push(`${title} (${items.length}):`, ...Arr.map(items, (item) => `- ${item}`));
  };

  section(
    "Console",
    Arr.map(result.console, (message) => `[${message.type}] ${message.text}`),
  );
  section("CSP violations", result.violations);
  section(
    "Failed loads",
    Arr.map(
      result.failedLoads,
      (load) => `${load.url === "" ? "(unknown)" : load.url} (${load.reason})`,
    ),
  );

  if (
    result.console.length === 0 &&
    result.violations.length === 0 &&
    result.failedLoads.length === 0
  ) {
    lines.push("No console messages, CSP violations or failed loads.");
  }

  for (const warning of [...prepared, ...result.warnings]) lines.push(`Warning: ${warning}`);

  return Arr.join(lines, "\n");
};

/** A check's counts as span attributes, under `visual.`: fixed values and counts only. */
const spanOf = (
  input: VisualCheckInput,
  result: VisualCheckResult,
  prepared: PreparedVisual,
): ToolSpanAttributes => ({
  "visual.width": input.width,
  "visual.theme": input.theme,
  "visual.cold_start": result.coldStart,
  "visual.outcome": result.warnings.length > 0 ? "partial" : "checked",
  "visual.bytes": prepared.bytes,
  "visual.console": result.console.length,
  "visual.violations": result.violations.length,
  "visual.failed_loads": result.failedLoads.length,
  "visual.warnings": result.warnings.length + prepared.warnings.length,
  "visual.content_height": result.contentHeight,
  "visual.grows": result.growth.grows,
  "visual.screenshot_bytes":
    result.screenshot === undefined ? 0 : base64Bytes(result.screenshot.data),
  "visual.clipped": result.clipped,
});

export const VisualCheckTool = defineEffectTool({
  name: VISUAL_CHECK,
  description: VISUAL_CHECK_DESCRIPTION,
  parameters: Parameters,
  structuredOutputSchema: outputSchema(VisualChecked),
  // It reads and renders a page and changes nothing, so a rerun after an eviction is the same call.
  replay: "safe",
  execute: (args, api) =>
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const host = yield* BrowserHost;
      const session = yield* BrowserSession;

      // A page that cannot be told clean of the Session's Secrets is not rendered, as `visual_show` does not keep one.
      if (!(yield* secrets.readable)) {
        return yield* VisualShowError.make({
          kind: "secrets_unavailable",
          message:
            "The Session's Secrets could not be read, so the page could not be checked for them and nothing was rendered: try again shortly",
        });
      }

      const held = yield* secrets.environment;

      // The title and summary are `visual_show`'s; a check has neither.
      const prepared = yield* prepareVisual(
        { path: args.path, html: args.html, title: "check", summary: "check" },
        {
          files: api.env === undefined ? undefined : visualFilesOf(api.env),
          redact: (text) => secrets.redact(text),
          secretValues: Record.values(held),
        },
      );

      const input: VisualCheckInput = {
        html: prepared.html,
        width: args.width ?? VISUAL_THREAD_WIDTH,
        theme: args.theme ?? "light",
        top: args.top ?? 0,
      };

      // Used from the start, and again whatever came of it: the browser may have been started before the check failed.
      yield* session.touch;

      const result = yield* host.checkVisual(input).pipe(
        Effect.ensuring(session.touch),
        Effect.mapError((error) => unchecked(error.message)),
      );

      yield* annotateToolSpan(api.callId, spanOf(input, result, prepared));

      const warnings = Arr.map(prepared.warnings, (warning) => warning.message);

      const output: BrowserOutputPart[] = [
        ...(result.screenshot === undefined
          ? []
          : [
              {
                type: "image" as const,
                data: result.screenshot.data,
                mimeType: result.screenshot.mimeType,
              },
            ]),
        { type: "text", text: describeCheck(input, result, warnings) },
      ];

      return {
        output,
        structuredOutput: asOutput(VisualChecked, {
          width: input.width,
          theme: input.theme,
          content_height: result.contentHeight,
          clipped: result.clipped,
          screenshot:
            result.screenshot === undefined
              ? null
              : { top: result.screenshot.top, height: result.screenshot.height },
          grows: result.growth.grows,
          console: result.console,
          violations: result.violations,
          failed_loads: result.failedLoads,
          warnings: [...warnings, ...result.warnings],
        }),
      };
    }).pipe(
      Effect.tapError((error) => {
        const attributes: Mutable<ToolSpanAttributes> = {
          "visual.outcome": Predicate.isTagged(error, "VisualCheckError") ? error.kind : "failed",
        };

        if (Predicate.isTagged(error, "VisualShowError")) attributes["visual.failure"] = error.kind;

        return annotateToolSpan(api.callId, attributes);
      }),
    ),
});
