// A Result Spill from an MCP tool's call (`docs/architecture/mcp-in-a-session.md` → Calls and results; GLOSSARY.md →
// Result Spill): the whole of what the model could not be shown, written to the Workspace's temporary directory of the
// calling conversation (`/workspace/.cloudpid/tmp`), as `bash` does, through the call's environment, which writes
// into the Workspace without waking the Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- pi-durable's environment is Promise-based.
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Where a spill went, or why it could not be written. */
export type Spilled = { readonly path: string } | { readonly reason: string };

/** Writes `data` to a new file ending in `suffix`. */
export type Spill = (data: string | Uint8Array, suffix: string) => Promise<Spilled>;

/** The spill into `env`, the call's environment: a call with none can save nothing. */
export const spillTo =
  (env: ExecutionEnv | undefined, context: Context): Spill =>
  async (data, suffix) => {
    if (env === undefined) return { reason: "this Session has no file system" };

    const path = await env.createTempFile({ prefix: "mcp-", suffix }, context);

    if (!path.ok) return { reason: path.error.message };

    const written = await env.writeFile(path.value, data, context);

    if (written.ok) return { path: path.value };

    // A half-written spill is no spill: it is removed, even when the call was aborted.
    await env.remove(path.value, { force: true }, BACKGROUND_CONTEXT);

    return { reason: written.error.message };
  };

/** The spill of a script's call, whose value holds the whole result: nothing is saved. */
export const refusingSpill: Spill = () =>
  Promise.resolve({ reason: "a script's call holds the whole result" });
