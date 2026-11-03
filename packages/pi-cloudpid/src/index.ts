// @effect-diagnostics *:off -- a program on the owner's machine, not Effect code (the bundle carries only `effect/Predicate`).
/**
 * `/cloudpid [instruction]`: imports the active pi Session into cloudpid (docs/architecture/mcp-endpoint.md → Session
 * import → The `/cloudpid` command). Dev loop: `pi -e packages/pi-cloudpid/src/index.ts`. It registers a command and
 * nothing else: no tool, no MCP server (the model-facing `cloudpid` entry is the owner's own `mcp.json`; see README.md).
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { connectEndpoint } from "./endpoint.ts";
import { ApiFailure, Refusal } from "./errors.ts";
import { type Deps, type Host, importSession } from "./flow.ts";
import { gitIn } from "./git.ts";
import { snapshotOf } from "./session.ts";

const hostOf = (pi: ExtensionAPI, ctx: ExtensionCommandContext): Host => ({
  cwd: ctx.cwd,
  hasUI: ctx.hasUI,
  isIdle: () => ctx.isIdle(),
  session: () => snapshotOf(ctx.sessionManager),
  model: ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
  thinking: ctx.thinkingLevel,
  ui: ctx.ui,
  appendEntry: (customType, data) => pi.appendEntry(customType, data),
});

const deps: Deps = {
  env: process.env,
  git: gitIn,
  endpoint: (config) => connectEndpoint(config),
  exists: existsSync,
};

/** What the owner reads of a failure: a refusal as it is, the endpoint's sentence, else the error's. */
export const messageOf = (error: Error): string => {
  if (error instanceof Refusal) return error.message;

  if (error instanceof ApiFailure) {
    if (error.code === "import_expired") {
      return "cloudpid: the import expired (an hour passed with nothing sent): run /cloudpid again.";
    }

    if (error.code === "too_many_running") {
      return `cloudpid: ${error.message} Finish or cancel the open import in cloudpid, then run /cloudpid again.`;
    }

    return `cloudpid: ${error.message}`;
  }

  return `cloudpid: the import failed: ${error.message}`;
};

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cloudpid", {
    description:
      "Import this pi session into cloudpid (everything after /cloudpid is the instruction it starts with)",
    handler: async (args, ctx) => {
      try {
        await importSession(hostOf(pi, ctx), args.trim(), deps);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? messageOf(error) : "cloudpid: the import failed.",
          "error",
        );
      }
    },
  });
}
