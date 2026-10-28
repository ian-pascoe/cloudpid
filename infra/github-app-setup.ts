/**
 * Registers cloudpid's GitHub App (ADR-0025) through GitHub's manifest flow and hands its secrets to the deploys. Run
 * from a workstation with `gh` signed in as the owner, and a browser:
 *
 *   pnpm --filter @cloudpid/infra run github-app:setup [--name cloudpid] [--repo owner/name]
 *
 * 1. It serves a page on 127.0.0.1 that posts the manifest (`githubAppManifest`) to GitHub; you confirm the app's name
 *    there, and GitHub sends you back with a code the app's ID and private key are fetched with. GitHub shows the key
 *    only then.
 * 2. It writes CLOUDPID_GITHUB_APP_ID and CLOUDPID_GITHUB_APP_PRIVATE_KEY into the GitHub environments `production` and
 *    `preview` of the repo (`gh secret set`) and into ~/.config/cloudpid/dev.env, at once, so the key is kept before
 *    anything else can fail. No other copy is kept: a lost key is replaced from the app's settings.
 * 3. It sends you to install the app (choose All repositories) on your account and on each organization whose repos
 *    the agent works on, then mints a token for each installation to check them.
 *
 * The app is registered under your own account and is public, so it can be installed on your organizations too (an
 * installation by anyone else gives cloudpid their repos, nothing of yours).
 */
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off asyncFunction:off globalTimers:off globalDate:off newPromise:off processEnv:off preferEffectArray:off preferEffectRecord:off -- a local script, not a Worker.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { GitHubApp, notInstalledOn } from "@cloudpid/server/github/app";
import { type GitHubAppManifest, githubAppManifest, withDevEnvValues } from "./src/github-app.ts";

/** The GitHub environments whose deploys bind the app's secrets. */
const ENVIRONMENTS = ["production", "preview"];

/** Where a workstation keeps its deploy secrets (docs/development/infra.md → Secrets and variables). */
const DEV_ENV = join(homedir(), ".config", "cloudpid", "dev.env");

/** The app's homepage: where `prod` is served. */
const HOMEPAGE = "https://pi.ianpascoe.dev";

/** GitHub allows an hour between the registration and the code's exchange. */
const REGISTRATION_TIMEOUT_MS = 60 * 60_000;

const { values: args } = parseArgs({
  options: {
    name: { type: "string", default: "cloudpid" },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "ian-pascoe/cloudpid" },
  },
});

/** Runs `command` with `input` on its stdin (a secret never goes on a command line); rejects unless it succeeds. */
const run = (command: string, argv: readonly string[], input = ""): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} ${argv[0] ?? ""} exited with ${code}`)),
    );
    child.stdin.end(input);
  });

/** Opens `url` in the browser where the platform has a way to, and always prints it. */
const openInBrowser = (url: string) => {
  console.log(`\n  ${url}\n`);

  const opener = process.platform === "darwin" ? "open" : "xdg-open";

  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
};

/** The page that posts the manifest to GitHub as soon as it loads. */
const manifestPage = (action: string, manifest: GitHubAppManifest) => `<!doctype html>
<meta charset="utf-8"><title>cloudpid's GitHub App</title>
<form id="register" action="${action}" method="post">
  <input type="hidden" name="manifest" value="${JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">
  <p>Taking you to GitHub to register the app&hellip; <button>Continue</button></p>
</form>
<script>document.getElementById("register").submit();</script>`;

/** Serves the manifest page until GitHub sends the browser back with the registration's code. */
const register = async (): Promise<string> => {
  const state = randomBytes(16).toString("hex");
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  // SAFETY: a server listening on a TCP port has an address with a port.
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const manifest = githubAppManifest({
    name: args.name,
    homepage: HOMEPAGE,
    redirect: `${origin}/registered`,
  });

  const action = `https://github.com/settings/apps/new?state=${state}`;

  const code = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("GitHub did not send the browser back within the hour")),
      REGISTRATION_TIMEOUT_MS,
    );

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", origin);

      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(manifestPage(action, manifest));

        return;
      }

      const given = url.searchParams.get("code");

      if (
        url.pathname !== "/registered" ||
        url.searchParams.get("state") !== state ||
        given === null
      ) {
        response.writeHead(404).end();

        return;
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("The GitHub App is registered. Go back to the terminal.");
      clearTimeout(timeout);
      resolve(given);
    });
  });

  console.log("Register the GitHub App in your browser (it opens by itself, or open this):");
  openInBrowser(`${origin}/`);

  try {
    return await code;
  } finally {
    server.close();
  }
};

/** The app GitHub made from the manifest, as its conversion endpoint answers. */
type Registered = {
  readonly id: number;
  readonly slug: string;
  readonly pem: string;
  readonly html_url: string;
  readonly owner: { readonly login: string } | null;
};

/** The app GitHub registered, its private key included, for the registration's `code`. */
const convertManifest = async (code: string): Promise<Registered> => {
  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });

  if (!response.ok) throw new Error(`GitHub did not hand the app over (${response.status})`);

  // SAFETY: GitHub's documented answer to a manifest's conversion.
  return (await response.json()) as Registered;
};

/** Writes the app's secrets where the deploys read them. */
const storeSecrets = async (app: Registered) => {
  const values = {
    CLOUDPID_GITHUB_APP_ID: String(app.id),
    CLOUDPID_GITHUB_APP_PRIVATE_KEY: app.pem,
  };

  await mkdir(dirname(DEV_ENV), { recursive: true });

  const before = await readFile(DEV_ENV, "utf8").catch(() => "");

  await writeFile(DEV_ENV, withDevEnvValues(before, values), { mode: 0o600 });
  await chmod(DEV_ENV, 0o600);
  console.log(`Wrote ${Object.keys(values).join(" and ")} into ${DEV_ENV}.`);

  for (const environment of ENVIRONMENTS) {
    for (const [name, value] of Object.entries(values)) {
      await run("gh", ["secret", "set", name, "--env", environment, "--repo", args.repo], value);
    }

    console.log(`Set them in ${args.repo}'s GitHub environment ${environment}.`);
  }
};

/**
 * Waits for the owner to install the app on their account and on each organization they name by pressing Enter, then
 * checks every installation by minting a token for it.
 */
const install = async (app: Registered) => {
  const owner = app.owner?.login ?? "your account";
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  console.log(
    `\nInstall it on ${owner} and on each organization whose repos the agent works on, choosing All repositories each time (it opens by itself, or open this):`,
  );
  openInBrowser(`https://github.com/apps/${app.slug}/installations/new`);

  let question = "Press Enter once it is installed. ";
  let ownerHasIt = false;

  try {
    for (;;) {
      const answer = await prompt.question(question);

      if (ownerHasIt && answer.trim() === "done") return;

      // A new one each time: one keeps the installations it listed, and a failure, for minutes.
      const installed = await new GitHubApp({
        appId: String(app.id),
        privateKey: app.pem,
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
      }).tokens();

      for (const problem of installed.problems) console.log(problem);

      const accounts = Object.keys(installed.byAccount).sort();

      ownerHasIt = installed.appAccount !== undefined && accounts.includes(installed.appAccount);

      if (!ownerHasIt) {
        console.log(notInstalledOn(owner));

        continue;
      }

      console.log(`Installed on ${accounts.join(", ")}: a GitHub token was minted for each.`);
      question = 'Install it on another organization and press Enter to check it, or type "done": ';
    }
  } finally {
    prompt.close();
  }
};

const app = await convertManifest(await register());

console.log(`Registered ${app.html_url} (app ID ${app.id}).`);

await storeSecrets(app);

await install(app);

console.log(
  "\nDone. Deploy as usual; once prod works with the app, delete CLOUDPID_GITHUB_TOKEN from production and preview (gh secret delete CLOUDPID_GITHUB_TOKEN --env <environment>) and revoke the PAT.",
);
