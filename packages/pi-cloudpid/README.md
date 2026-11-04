# pi-cloudpid

A [pi](https://github.com/earendil-works/pi) extension that hands the session you are in to cloudpid: `/cloudpid [instruction]` imports the active pi Session, the whole branch of it you are on, into a new cloudpid Session and Workspace, and cloudpid goes on from there, on your instruction if you gave one. It runs on your machine and talks to cloudpid's MCP endpoint.

The design is [`docs/architecture/mcp-endpoint.md`](https://github.com/ian-pascoe/cloudpid/blob/main/docs/architecture/mcp-endpoint.md) → _Session import_ and [ADR-0043](https://github.com/ian-pascoe/cloudpid/blob/main/docs/adr/0043-a-session-import-sends-the-local-agents-raw-transcript-for-cloudpid-to-translate-and-moves-the-working-tree-only-through-the-repos-remote.md).

## Set up

1. **Install it** (once; `pi update` follows the branch after each deploy):

   ```sh
   pi install git:github.com/ian-pascoe/cloudpid@pi-cloudpid
   ```

2. **Give it the Local agent's service token.** From a cloudpid checkout, `bun run --cwd infra local-agent-token --stage prod` prints the client ID and secret. Keep them in Keychain or 1Password and put them in the environment pi runs in:

   ```sh
   export CLOUDPID_URL=https://pi.ianpascoe.dev/mcp
   export CLOUDPID_ACCESS_CLIENT_ID=$(security find-generic-password -s cloudpid-local-agent -a client-id -w)
   export CLOUDPID_ACCESS_CLIENT_SECRET=$(security find-generic-password -s cloudpid-local-agent -a client-secret -w)
   ```

   `CLOUDPID_URL` is the MCP endpoint (`https://<host>/mcp`; a bare host gets `/mcp`). It is never read from `mcp.json`. The token is sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`. When it has expired (a year), the endpoint answers 401 or 403 and `/cloudpid` says "service token rejected or expired: run `local-agent-token`".

3. **Optional: let the model use cloudpid too.** `/cloudpid` registers no MCP server. The model-facing entry is your own, in `~/.pi/agent/mcp.json` (sign in with `/mcp`; Access's managed OAuth), and it should hide the import tools, which are for `/cloudpid` and never for a model:

   ```json
   {
     "mcpServers": {
       "cloudpid": {
         "url": "https://pi.ianpascoe.dev/mcp",
         "toolExposure": { "session_import_*": "hidden" }
       }
     }
   }
   ```

4. **Add the Repo to an Environment** in cloudpid, if it is not in one: `/cloudpid` matches your checkout's `origin` to the Repos of your Environments and never creates one.

## Use it

In a checkout of the Repo, in a saved pi session (one with at least one message), when pi is idle:

```
/cloudpid fix the failing test and open a PR
```

Everything after `/cloudpid` is the instruction, sent to the new Session when the import ends. Left out, the Session waits for you. `/cloudpid` shows what it will do and asks first: the Environment, the branch, the commits it will push, the uncommitted files it will carry (count and names), the size, and the model.

- **The working tree moves only through the Repo's remote.** The branch is pushed fast-forward only: a remote with commits you lack refuses with "pull first". Your uncommitted changes, tracked and untracked but never ignored (so no `.env`), are read through a private index and pushed as one commit on HEAD to a ref of the import's own; your index and work tree are not touched. A hook never runs on these pushes.
- **The branch** is the local branch, or the name of its upstream on `origin`. On the default branch or a detached HEAD, it asks for a name (a slug of the title is offered) and runs `git switch -c`. If another Workspace holds the branch, you can remove that Workspace in cloudpid (this deletes its Sessions) and retry, pick a new name, or cancel.
- **Afterwards** it offers to `git stash push -u -m "cloudpid: imported as <url>"` your changes, since the work goes on in cloudpid, and prints how to come back: `git switch <branch> && git pull --ff-only`, then `git stash drop`. It leaves a `cloudpid-import` entry in the pi session, so running it again asks "already imported as <url>; import again as a new Session?". It never follows the Run the instruction starts: open the URL.
- **A failed push** cancels the import and takes its ref off the remote. An import that is not finished expires after an hour.
- **An older endpoint** (one without the import tools) is refused with "the endpoint is older than this extension".

## Develop

```sh
pi -e packages/pi-cloudpid/src/index.ts      # the dev loop, from the repo root
bun run --cwd packages/pi-cloudpid test      # includes an import against a stub endpoint
bun run --cwd packages/pi-cloudpid build     # dist/index.js and dist/package.json
```

It is the one package with a build: `bun build --target=node --format=esm` makes a single `dist/index.js` with the pi host packages (`@earendil-works/pi-*`, `typebox`) external as peer dependencies, and `dist/package.json` carries `pi.extensions` and nothing to install. `build.ts` fails the build if the bundle reaches Workers code (`cloudflare:*`, workerd, alchemy, pi-durable, `@cloudpid/extensions`). `PI_CLOUDPID_SHA` (CI sets it to the `main` commit, else `git rev-parse HEAD`) is built in and sent as `X-Cloudpid-Client: pi-cloudpid/<sha>`. After `Deploy prod` succeeds, CI appends a commit with `dist/` to the orphan branch `pi-cloudpid` ([`docs/development/infra.md`](https://github.com/ian-pascoe/cloudpid/blob/main/docs/development/infra.md) → _CI_).
