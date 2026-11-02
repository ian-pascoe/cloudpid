/**
 * Prints a stage's Local agent service token (`cloudpid-local-agent`, apps/server/src/mcp-access.ts) for `/cloudpid`
 * (docs/architecture/mcp-endpoint.md → The Local agent's service token): the client ID and secret as the variables the
 * extension reads, and when the token expires. From a workstation with the alchemy profile the deploys use:
 *
 *   bun --cwd infra run local-agent-token --stage <stage> [--profile <profile>]
 *
 * It reads the token's record from alchemy's state (`alchemy state read`), where the provider keeps the secret, since
 * Cloudflare shows a secret only on create and rotate. It prints the secret to stdout and nowhere else; CI never runs it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off asyncFunction:off processEnv:off newPromise:off preferEffectArray:off -- a local script, not a Worker.
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  formatLocalAgentToken,
  localAgentTokenFromState,
  localAgentTokenStatePath,
} from "./src/local-agent-token.ts";

const { values: args } = parseArgs({
  options: {
    stage: { type: "string" },
    profile: { type: "string" },
  },
});

if (args.stage === undefined || args.stage === "") {
  console.error(
    "usage: bun --cwd infra run local-agent-token --stage <stage> [--profile <profile>]",
  );
  process.exit(2);
}

// `github.ts` is the config that needs no deploy secrets to load; the state store is the account's, whichever stack.
const argv = [
  "alchemy",
  "state",
  "read",
  localAgentTokenStatePath(args.stage),
  "--config",
  "github.ts",
  "--no-input",
  ...(args.profile === undefined ? [] : ["--profile", args.profile]),
];

const read = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", argv, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              `no state record for ${args.stage}'s Local agent token (alchemy exited ${code})`,
            ),
          ),
    );
  });

try {
  console.log(formatLocalAgentToken(localAgentTokenFromState(await read())));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
