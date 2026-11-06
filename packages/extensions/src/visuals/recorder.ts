// docs/architecture/visuals.md → Tools (Where they live), The copy. Where `visual_show` hands each shown page: the Session's
// `VisualRecorder`, which keeps it in the Session's storage outside History (`apps/server/src/session/visuals-store.ts`). The
// extension writes nothing itself; the Session provides the recorder when it builds its extensions.
// @effect-diagnostics missingPipeableSignature:off -- a service and a tagged error class.
import type { VisualDraft } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** What keeping a Visual came to: the earlier Visual of the same file it supersedes, and how many Visuals its bounds evicted. */
export type VisualKept = {
  readonly supersedes: string | undefined;
  readonly evicted: number;
};

/** The Session could not keep a Visual: nothing was shown. Its message is what the model sees. */
export class VisualKeepError extends Schema.TaggedError<
  VisualKeepError,
  { readonly brand: unique symbol }
>()("VisualKeepError", { message: Schema.String }) {}

export type VisualRecorderService = {
  /**
   * Keep `draft` as call `draft.callId`'s Visual, the bounds holding (never the one just kept evicted), and tell the clients
   * watching its conversation. An earlier Visual of the same file in the same conversation is the one it supersedes.
   */
  readonly put: (draft: VisualDraft) => Effect.Effect<VisualKept, VisualKeepError>;
};

/** The Session's keeping of Visuals, which `visual_show` hands each page it prepared. */
export class VisualRecorder extends Context.Service<VisualRecorder, VisualRecorderService>()(
  "@cloudpid/extensions/visuals/recorder/VisualRecorder",
) {}
