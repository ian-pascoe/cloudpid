// docs/architecture/visuals.md → Tools (visual_show), Telemetry. `visual_show`: the page of a `path` or `html` call is
// prepared (`./prepare.ts`: inlined, redacted, checked, bounded) and handed to the Session's `VisualRecorder`, which keeps it
// outside History and tells the clients; the card of the call then shows it. A nested call (a `codemode` script's) keeps its
// script's call as its parent, so its Visual shows in the strip under the script's card. The call's `pi.tool.visual_show`
// span gains counts and fixed values only, never the page, its title, summary, path or hosts.
// @effect-diagnostics missingPipeableSignature:off -- a tool definition and plain builders.
import {
  annotateToolSpan,
  callDurable,
  ChordContext,
  defineEffectTool,
  type ToolSpanValue,
} from "@cloudpid/effect-durable";
import {
  MAX_VISUAL_SUMMARY,
  MAX_VISUAL_TITLE,
  VISUAL_DETAILS_KEY,
  VISUAL_WARNING_KINDS,
  type VisualDraft,
  VisualShown,
  sourcePathOf,
} from "@cloudpid/protocol";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ToolTaskInput } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { Secrets } from "../secrets/store.ts";
import { VISUAL_SHOW, VISUAL_SHOW_DESCRIPTION } from "./guidance.ts";
import {
  prepareVisual,
  type VisualCounts,
  type VisualFile,
  type VisualFiles,
  VisualShowError,
} from "./prepare.ts";
import { VisualRecorder } from "./recorder.ts";

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
  title: Schema.String.annotate({
    description: `The Visual's title, at most ${MAX_VISUAL_TITLE} characters`,
  }),
  summary: Schema.String.annotate({
    description: `What the page shows, at most ${MAX_VISUAL_SUMMARY} characters: its accessible description, and what stands for it wherever it is not rendered`,
  }),
});

/** The calling conversation's Workspace, as the preparation reads it, through the call's environment. */
const filesOf = (env: ExecutionEnv): VisualFiles => ({
  absolute: (path) =>
    Effect.gen(function* () {
      const context = yield* ChordContext;
      const result = yield* Effect.promise(() => env.absolutePath(path, context));

      return result.ok ? result.value : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined)),
  read: (path) =>
    Effect.gen(function* () {
      const context = yield* ChordContext;

      return yield* Effect.promise(() => env.readBinaryFile(path, context)).pipe(
        Effect.map((result): VisualFile => {
          if (result.ok) return { kind: "file", bytes: result.value };

          return result.error.code === "not_found" || result.error.code === "is_directory"
            ? { kind: "missing" }
            : { kind: "unreadable", message: result.error.message };
        }),
      );
    }),
});

/** A show's counts as span attributes, under `visual.`: fixed values and counts only. */
const spanOf = (
  sourceKind: string,
  bytes: number,
  counts: VisualCounts,
  evicted: number,
  warnings: ReadonlyArray<{ readonly kind: string }>,
) => {
  const attributes: Mutable<Record<string, ToolSpanValue>> = {
    "visual.source": sourceKind,
    "visual.bytes": bytes,
    "visual.inlined.images": counts.images,
    "visual.inlined.stylesheets": counts.stylesheets,
    "visual.inlined.scripts": counts.scripts,
    "visual.secrets_replaced": counts.secrets,
    "visual.hints_stripped": counts.hints,
    "visual.evicted": evicted,
    "visual.warnings": warnings.length,
  };

  for (const kind of VISUAL_WARNING_KINDS) {
    const count = Arr.filter(warnings, (warning) => warning.kind === kind).length;

    if (count > 0) attributes[`visual.warning.${kind}`] = count;
  }

  return attributes;
};

export const VisualShowTool = defineEffectTool({
  name: VISUAL_SHOW,
  description: VISUAL_SHOW_DESCRIPTION,
  parameters: Parameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(VisualShown).schema,
  execute: (args, api) =>
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const recorder = yield* VisualRecorder;

      // Whether this is a nested call, and of which call: a script's Visuals show under its card.
      const task = yield* callDurable("getTask", (context) => api.getTask(api.taskId, context));
      // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
      const caller = task?.input as ToolTaskInput | undefined;

      yield* secrets.refresh;

      const prepared = yield* prepareVisual(args, {
        files: api.env === undefined ? undefined : filesOf(api.env),
        redact: (text) => secrets.redact(text),
      });

      const draft: Mutable<VisualDraft> = {
        callId: api.callId,
        conversation: String(api.conversationId),
        title: prepared.title,
        summary: prepared.summary,
        source: prepared.source,
        html: prepared.html,
        bytes: prepared.bytes,
        warnings: prepared.warnings,
      };

      if (caller?.kind === "nested") draft.parentCall = caller.parentCallId;

      const kept = yield* recorder
        .put(draft)
        .pipe(
          Effect.mapError((error) =>
            VisualShowError.make({ kind: "not_kept", message: error.message }),
          ),
        );

      yield* annotateToolSpan(
        api.callId,
        spanOf(
          prepared.source.kind,
          prepared.bytes,
          prepared.counts,
          kept.evicted,
          prepared.warnings,
        ),
      );

      const shown = {
        id: api.callId,
        title: prepared.title,
        bytes: prepared.bytes,
        source_path: sourcePathOf(prepared.source) ?? null,
        supersedes: kept.supersedes ?? null,
        warnings: Arr.map(prepared.warnings, (warning) => warning.message),
      };

      const text = Arr.join(
        [
          `Shown "${prepared.title}". Don't restate it.`,
          ...Arr.map(prepared.warnings, (warning) => `Warning: ${warning.message}`),
        ],
        "\n",
      );

      return {
        output: [{ type: "text" as const, text }],
        structuredOutput: shown,
        details: { [VISUAL_DETAILS_KEY]: { ...shown, summary: prepared.summary } },
      };
    }).pipe(
      Effect.tapError((error) =>
        annotateToolSpan(api.callId, {
          "visual.failure": Predicate.isTagged(error, "VisualShowError") ? error.kind : "failed",
        }),
      ),
    ),
});
