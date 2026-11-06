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
  type ToolSpanAttributes,
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
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { Secrets } from "../secrets/store.ts";
import { VISUAL_SHOW, VISUAL_SHOW_DESCRIPTION } from "./guidance.ts";
import {
  isSpecialPath,
  type PreparedVisual,
  prepareVisual,
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

/** What a Workspace's failed answer for a file means to the preparation. */
const failedRead = (error: { readonly code: string; readonly message: string }): VisualFile => {
  switch (error.code) {
    case "not_found":
      return { kind: "missing" };
    case "is_directory":
      return { kind: "not_file" };
    default:
      return { kind: "unreadable", message: error.message };
  }
};

/**
 * The calling conversation's Workspace, as the preparation reads it, through the call's environment. A file is measured
 * before it is read, as `call-diff.ts` does: a link by its target, which is read in its place; anything but a regular file,
 * a file under `/dev`, `/proc` or `/sys`, and a file over the bound are never read.
 */
const filesOf = (env: ExecutionEnv): VisualFiles => ({
  absolute: (path) =>
    Effect.gen(function* () {
      const context = yield* ChordContext;
      const result = yield* Effect.promise(() => env.absolutePath(path, context));

      return result.ok ? result.value : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined)),
  read: (path, max) =>
    Effect.gen(function* () {
      const context = yield* ChordContext;

      if (isSpecialPath(path)) return { kind: "not_file" } satisfies VisualFile;

      let target = path;
      let info = yield* Effect.promise(() => env.fileInfo(target, context));

      if (info.ok && info.value.kind === "symlink") {
        const canonical = yield* Effect.promise(() => env.canonicalPath(path, context));

        if (!canonical.ok) return failedRead(canonical.error);

        if (isSpecialPath(canonical.value)) return { kind: "not_file" } satisfies VisualFile;

        target = canonical.value;
        info = yield* Effect.promise(() => env.fileInfo(target, context));
      }

      if (!info.ok) return failedRead(info.error);

      if (info.value.kind !== "file") return { kind: "not_file" } satisfies VisualFile;

      if (info.value.size > max) {
        return { kind: "too_large", size: info.value.size } satisfies VisualFile;
      }

      const read = yield* Effect.promise(() => env.readBinaryFile(target, context));

      if (!read.ok) return failedRead(read.error);

      // It may have grown since it was measured.
      if (read.value.byteLength > max) {
        return { kind: "too_large", size: read.value.byteLength } satisfies VisualFile;
      }

      return { kind: "file", bytes: read.value } satisfies VisualFile;
    }),
});

/** A show's counts as span attributes, under `visual.`: fixed values and counts only. */
const spanOf = (prepared: PreparedVisual, evicted: number): ToolSpanAttributes => {
  const { counts, warnings } = prepared;

  return {
    "visual.source": prepared.source.kind,
    "visual.bytes": prepared.bytes,
    "visual.inlined.images": counts.images,
    "visual.inlined.stylesheets": counts.stylesheets,
    "visual.inlined.scripts": counts.scripts,
    "visual.secrets_replaced": counts.secrets,
    "visual.hints_stripped": counts.hints,
    "visual.evicted": evicted,
    "visual.warnings": warnings.length,
    ...Record.fromEntries(
      Arr.filterMap(VISUAL_WARNING_KINDS, (kind) => {
        const count = Arr.filter(warnings, (warning) => warning.kind === kind).length;

        return count > 0
          ? Result.succeed([`visual.warning.${kind}`, count] as const)
          : Result.failVoid;
      }),
    ),
  };
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

      // A copy that cannot be told clean of the Session's Secrets is not kept: their values never enter durable state.
      if (!(yield* secrets.readable)) {
        return yield* VisualShowError.make({
          kind: "secrets_unavailable",
          message:
            "The Session's Secrets could not be read, so the page could not be checked for them and nothing was shown: try again shortly",
        });
      }

      const held = yield* secrets.environment;

      const prepared = yield* prepareVisual(args, {
        files: api.env === undefined ? undefined : filesOf(api.env),
        redact: (text) => secrets.redact(text),
        secretValues: Record.values(held),
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

      yield* annotateToolSpan(api.callId, spanOf(prepared, kept.evicted));

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
