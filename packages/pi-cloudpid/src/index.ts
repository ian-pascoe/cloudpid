// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- plain Promises, as pi's extension API and child processes give them; runs on node, on the owner's machine.
/**
 * `/cloudpid import|login|logout` (docs/architecture/mcp-endpoint.md → Session import → The `/cloudpid` command). Dev
 * loop: `pi -e packages/pi-cloudpid/src/index.ts`. It registers a command and nothing else: no tool, no MCP server (the
 * model-facing `cloudpid` entry is the owner's own `mcp.json`; see README.md). The endpoint is read from pi's settings
 * on every run, so nothing is cached between runs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fileAuthStore } from "./auth-store.ts";
import { completionsFor, parseCommand } from "./command.ts";
import { clientName, readConfig, type SettingsSource } from "./config.ts";
import { connectEndpoint } from "./endpoint.ts";
import { ApiFailure, Refusal } from "./errors.ts";
import type { Host } from "./flow.ts";
import { gitIn } from "./git.ts";
import { runCommand, type RunDeps } from "./run.ts";
import { snapshotOf } from "./session.ts";
import { openInBrowser, signIn } from "./signin.ts";

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

/**
 * pi's settings as of now. The command context has no settings manager, so this reads the two files with pi's own
 * (`SettingsManager.create`, which honours the trust of this project and `PI_CODING_AGENT_DIR`) on each run.
 */
const settingsOf = (ctx: ExtensionCommandContext): SettingsSource => {
  const agentDir = getAgentDir();

  return {
    settingsManager: SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    }),
    sessionManager: ctx.sessionManager,
    files: {
      global: join(agentDir, "settings.json"),
      project: join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"),
    },
  };
};

const depsOf = (ctx: ExtensionCommandContext): RunDeps => {
  const store = fileAuthStore(getAgentDir());

  return {
    config: () => readConfig(settingsOf(ctx)),
    git: gitIn,
    store,
    endpoint: (config) =>
      connectEndpoint(config, {
        store,
        onWarning: (message) => ctx.ui.notify(`cloudpid: ${message}`, "warning"),
      }),
    signIn: (config) =>
      signIn(config, ctx.ui, { store, openBrowser: openInBrowser, client: clientName() }),
    exists: existsSync,
  };
};

/** What the owner reads of a failure: a refusal as it is, the endpoint's sentence, else the error's. */
export const messageOf = (error: Error): string => {
  if (error instanceof Refusal) return error.message;

  if (error instanceof ApiFailure) {
    if (error.code === "import_expired") {
      return "cloudpid: the import expired (an hour passed with nothing sent): run /cloudpid import again.";
    }

    if (error.code === "too_many_running") {
      return `cloudpid: ${error.message} Finish or cancel the open import in cloudpid, then run /cloudpid import again.`;
    }

    return `cloudpid: ${error.message}`;
  }

  return `cloudpid: the import failed: ${error.message}`;
};

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("cloudpid", {
    description:
      "cloudpid: import [instruction] imports this pi session into cloudpid; login and logout manage the sign-in",
    getArgumentCompletions: (prefix) => completionsFor(prefix),
    handler: async (args, ctx) => {
      try {
        await runCommand(parseCommand(args), hostOf(pi, ctx), depsOf(ctx));
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? messageOf(error) : "cloudpid: the command failed.",
          "error",
        );
      }
    },
  });
}
