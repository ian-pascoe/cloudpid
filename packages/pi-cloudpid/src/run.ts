// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off asyncFunction:off -- native array methods over plain values (the bundle carries no Effect runtime); plain functions over values, called directly; plain Promises, as pi's extension API gives them.
/**
 * What each `/cloudpid` subcommand does (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Command): `import`
 * is `flow.ts`; `login` signs in to the configured endpoint now, replacing a stored sign-in; `logout` deletes the stored
 * sign-in of that endpoint alone; a bare command or an unknown verb prints the usage and the configured endpoint, and
 * does nothing else. Failures the owner can act on are {@link Refusal}s, which the caller prints.
 */
import type { AuthStore } from "./auth-store.ts";
import { type Command, USAGE } from "./command.ts";
import { type Config, endpointKey } from "./config.ts";
import { Refusal } from "./errors.ts";
import { type Deps, type Host, importSession } from "./flow.ts";

/** What `login` and `logout` reach beyond what `import` does. */
export interface RunDeps extends Deps {
  readonly store: AuthStore;
}

/** Runs `command`; `config` is not read for `usage` more than to show it. */
export const runCommand = async (command: Command, host: Host, deps: RunDeps): Promise<void> => {
  const { ui } = host;

  switch (command.kind) {
    case "import":
      await importSession(host, command.instruction, deps);

      return;

    case "login": {
      if (!host.hasUI) {
        throw new Refusal(
          "/cloudpid login needs pi's interactive mode: it opens your browser, or asks you to paste the redirect URL.",
        );
      }

      const config = deps.config();

      ui.notify(
        (await deps.signIn(config))
          ? `cloudpid: signed in to ${config.url.href}.`
          : `cloudpid: ${config.url.href} does not ask for a sign-in (nothing in front of it wants one).`,
        "info",
      );

      return;
    }

    case "logout": {
      const config = deps.config();
      const removed = await deps.store.remove(endpointKey(config));

      ui.notify(
        removed
          ? `cloudpid: signed out of ${config.url.href}: its stored sign-in is deleted.`
          : `cloudpid: no stored sign-in for ${config.url.href}.`,
        "info",
      );

      return;
    }

    case "usage": {
      ui.notify(
        [command.problem, USAGE, `Endpoint: ${endpointText(deps)}`]
          .filter((part) => part !== undefined)
          .join("\n"),
        command.problem === undefined ? "info" : "warning",
      );
    }
  }
};

/** The configured endpoint's URL, or why there is none (the refusal with the setup steps). */
const endpointText = (deps: Deps): string => {
  let config: Config;

  try {
    config = deps.config();
  } catch (error) {
    if (error instanceof Refusal) return `not set up.\n${error.message}`;

    throw error;
  }

  return config.url.href;
};
