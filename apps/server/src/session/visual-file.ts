// docs/architecture/visuals.md → The frame: The card (Open file). The file a Visual was shown from, as the Workspace holds it
// now: read by `SessionHost.workspaceFile` (through the lookup environment, never starting the Container) and answered to
// `visual_file` as its UTF-8 text, or why there is none.
// @effect-diagnostics missingPipeableSignature:off -- a plain answer.
import { bytesFromBase64, type VisualFileAnswer } from "@cloudpid/protocol";

/** What the Workspace holds at a Visual's file now, as `SessionHost.workspaceFile` reads it. */
export type WorkspaceFileRead =
  /** The file's bytes, as base64. */
  | { readonly kind: "base64"; readonly base64: string }
  /** No such regular file, a link, a path outside `/workspace`, or a Workspace that did not answer in time. */
  | { readonly kind: "missing" }
  /** Over `MAX_VISUAL_BYTES`, by its size: it was not read. */
  | { readonly kind: "too_large" };

/** What `visual_file` answers for the file at `path` as the Workspace read it: its text when it is UTF-8. */
export const visualFileAnswer = (path: string, read: WorkspaceFileRead): VisualFileAnswer => {
  if (read.kind === "too_large") return { status: "too_large", path };

  if (read.kind === "missing") return { status: "missing", path };

  const bytes = bytesFromBase64(read.base64);

  if (bytes === undefined) return { status: "missing", path };

  try {
    return {
      status: "text",
      path,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { status: "not_text", path };
  }
};
