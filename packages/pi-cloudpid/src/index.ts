// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off -- plain Promises, as pi's extension API and child processes give them; runs on node, on the owner's machine.
/**
 * `/cloudpid import|login|logout` and the `cloudpid` MCP server (docs/architecture/mcp-endpoint.md → Session import →
 * The `/cloudpid` command). Dev loop: `pi -e packages/pi-cloudpid/src/index.ts`. It registers a command, and on every
 * `session_start` the MCP server for the model's connection (`mcp-server.ts`); no tool. The endpoint is read from pi's
 * settings on every run and every session start, so nothing is cached between them. The settings can only be read with
 * a session's `cwd` and project trust, which the load does not have and `session_start` does (it fires after pi bound
 * the extension, so a registration made there connects at once: `mcp_servers_change`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fileAuthStore } from "./auth-store.ts";
import { completionsFor, parseCommand } from "./command.ts";
import { clientName, type Config, readConfig, type SettingsSource } from "./config.ts";
import { connectEndpoint } from "./endpoint.ts";
import { ApiFailure, Refusal } from "./errors.ts";
import type { Host } from "./flow.ts";
import { gitIn } from "./git.ts";
import { mcpRegistration } from "./mcp-server.ts";
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
 * pi's settings as of now. Neither the command context nor the `session_start` one has a settings manager, so this
 * reads the two files with pi's own (`SettingsManager.create`, which honours the trust of this project and
 * `PI_CODING_AGENT_DIR`) on each run.
 */
const settingsOf = (
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): SettingsSource => {
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

/** The endpoint from pi's settings, or none when they do not give one: unset and invalid both mean no server. */
const configOrNone = (ctx: ExtensionContext): Config | undefined => {
  try {
    return readConfig(settingsOf(ctx));
  } catch (error) {
    if (error instanceof Refusal) return undefined;

    throw error;
  }
};

export default function (pi: ExtensionAPI): void {
  const syncMcpServer = mcpRegistration(pi);

  // pi keeps no registration: every session start (a switch or `/reload` too) registers again, from the settings of its cwd.
  pi.on("session_start", (_event, ctx) => {
    syncMcpServer(configOrNone(ctx), (message) => ctx.ui.notify(message, "warning"));
  });

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
