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
import {
  base64Bytes,
  VISUAL_CHECK,
  VISUAL_THEMES,
  VISUAL_THREAD_WIDTH,
  VisualChecked,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import {
  BrowserHost,
  type BrowserError,
  type BrowserOutputPart,
  type VisualCheckInput,
  type VisualCheckResult,
} from "../browser/host.ts";
import { BrowserSession } from "../browser/session.ts";
import { asOutput, outputSchema } from "../outputs.ts";
import { VISUAL_CHECK_DESCRIPTION } from "./guidance.ts";
import { type PreparedVisual, prepareForCall } from "./prepare.ts";
import { quoted } from "./quote.ts";
import { visualFilesOfCall } from "./tool.ts";

/** The narrowest and widest page a check renders: a phone's, and a wide desktop's. */
const MIN_WIDTH = 200;
const MAX_WIDTH = 2_000;

/** The furthest down a screenshot may start: far past any page, so a call cannot ask for a clip at an absurd offset. */
const MAX_TOP = 100_000;

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
    Schema.Literals(VISUAL_THEMES).annotate({
      description: 'The color scheme the page is rendered in: "light" (default) or "dark"',
    }),
  ),
  top: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TOP })).annotate({
      description: `Where the screenshot starts, in px from the top of the page, up to ${MAX_TOP.toLocaleString("en-US")}; default 0. It shows at most 3,000 px`,
    }),
  ),
});

/** A check that could not run: the browser is unavailable, the Browsers Worker has no check yet, or it is busy with others. */
export class VisualCheckError extends Schema.TaggedError<
  VisualCheckError,
  { readonly brand: unique symbol }
>()("VisualCheckError", {
  kind: Schema.Literals(["not_checked", "unavailable", "busy"]),
  message: Schema.String,
}) {}

/** How a failed host call reads to the model. */
const unchecked = (error: BrowserError): VisualCheckError => {
  if (error.unavailable === true) {
    return VisualCheckError.make({
      kind: "unavailable",
      message:
        "visual_check is unavailable: the browser host does not support it yet, so nothing was checked. Show the page without a check, or try again later.",
    });
  }

  if (error.busy === true) {
    return VisualCheckError.make({
      kind: "busy",
      message:
        "visual_check is busy: this Session's browser is already running other checks, so nothing was checked. Wait for them to end, then check again.",
    });
  }

  return VisualCheckError.make({
    kind: "not_checked",
    message: `Not checked: the browser could not render the page (${error.message}). Try again, or show the page without a check.`,
  });
};

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

  const tall =
    result.contentHeight === undefined
      ? "The page's height was not measured."
      : `The page is ${result.contentHeight} px tall.`;

  const lines = [`Checked at ${input.width} px wide in the ${input.theme} theme. ${tall} ${shown}`];

  if (result.growth.grows) {
    lines.push(
      `The page grows after each time its frame is resized (heights ${Arr.join(Arr.map(result.growth.heights, String), ", ")}): its height follows its frame's, so the frame will freeze it where it is. Look for sizes taken from the window or the frame, such as a script that sets a height from innerHeight.`,
    );
  }

  // What the page wrote is quoted, and said to be: it is the page's own text and can say anything, so a line of the check's
  // own never starts inside it.
  const section = (title: string, items: ReadonlyArray<string>) => {
    if (items.length > 0) {
      lines.push(
        `${title} (${items.length}; the page's own text, quoted):`,
        ...Arr.map(items, (item) => `- ${item}`),
      );
    }
  };

  section(
    "Console",
    Arr.map(result.console, (message) => `[${message.type}] ${quoted(message.text)}`),
  );
  section(
    "CSP violations",
    Arr.map(result.violations, (line) => quoted(line)),
  );
  section(
    "Failed loads",
    Arr.map(
      result.failedLoads,
      (load) => `${load.url === "" ? "(unknown)" : quoted(load.url)} (${load.reason})`,
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
): ToolSpanAttributes => {
  const attributes: Mutable<ToolSpanAttributes> = {
    "visual.width": input.width,
    "visual.theme": input.theme,
    "visual.cold_start": result.coldStart,
    "visual.outcome": result.warnings.length > 0 ? "partial" : "checked",
    "visual.bytes": prepared.bytes,
    "visual.console": result.console.length,
    "visual.violations": result.violations.length,
    "visual.failed_loads": result.failedLoads.length,
    "visual.warnings": result.warnings.length + prepared.warnings.length,
    "visual.grows": result.growth.grows,
    "visual.screenshot_bytes":
      result.screenshot === undefined ? 0 : base64Bytes(result.screenshot.data),
    "visual.clipped": result.clipped,
  };

  // A check cut off before it measured the page has no height to count.
  if (result.contentHeight !== undefined)
    attributes["visual.content_height"] = result.contentHeight;

  return attributes;
};

export const VisualCheckTool = defineEffectTool({
  name: VISUAL_CHECK,
  description: VISUAL_CHECK_DESCRIPTION,
  parameters: Parameters,
  structuredOutputSchema: outputSchema(VisualChecked),
  // It reads and renders a page and changes nothing, so a rerun after an eviction is the same call.
  replay: "safe",
  execute: (args, api) =>
    Effect.gen(function* () {
      const host = yield* BrowserHost;
      const session = yield* BrowserSession;

      // A page that cannot be told clean of the Session's Secrets is not rendered, as `visual_show` does not keep one. A check
      // has no title or summary: those are `visual_show`'s.
      const prepared = yield* prepareForCall(
        { path: args.path, html: args.html },
        visualFilesOfCall(api.env),
        "rendered",
      );

      const input: VisualCheckInput = {
        html: prepared.html,
        width: args.width ?? VISUAL_THREAD_WIDTH,
        theme: args.theme ?? "light",
        top: args.top ?? 0,
      };

      // Used from the start, and again whatever came of it: the browser may have been started before the check failed.
      yield* session.touch;

      const result = yield* host
        .checkVisual(input)
        .pipe(Effect.ensuring(session.touch), Effect.mapError(unchecked));

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
          content_height: result.contentHeight ?? null,
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
