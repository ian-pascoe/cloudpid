# pi-cloudpid

A [pi](https://github.com/earendil-works/pi) extension that hands the session you are in to cloudpid: `/cloudpid import [instruction]` imports the active pi Session, the whole branch of it you are on, into a new cloudpid Session and Workspace, and cloudpid goes on from there, on your instruction if you gave one. It runs on your machine and talks to cloudpid's MCP endpoint, signed in as you with OAuth.

The design is [`docs/architecture/mcp-endpoint.md`](https://github.com/ian-pascoe/cloudpid/blob/main/docs/architecture/mcp-endpoint.md) → _Session import_ and [ADR-0043](https://github.com/ian-pascoe/cloudpid/blob/main/docs/adr/0043-a-session-import-sends-the-local-agents-raw-transcript-for-cloudpid-to-translate-and-moves-the-working-tree-only-through-the-repos-remote.md).

## Set up

1. **Install it** (once; `pi update` follows the branch after each deploy):

   ```sh
   pi install git:github.com/ian-pascoe/cloudpid@pi-cloudpid
   ```

2. **Tell it where cloudpid is.** Put the `cloudpid.baseUrl` setting in `~/.pi/agent/settings.json`, or, for one project, in its `.pi/settings.json` (pi reads a project's settings only once you trust the project; the project's value wins):

   ```json
   { "cloudpid": { "baseUrl": "https://<host>" } }
   ```

   `baseUrl` is your cloudpid's origin: `/mcp` is added (a URL that already ends in `/mcp` is taken as it is). It must be https, or http on localhost for `alchemy dev`. There is no default: with it unset, `/cloudpid` refuses and says what to add, and an invalid block refuses naming the file and the field. It is read on every run, so there is nothing to `/reload`. `CLOUDPID_URL` and the `CLOUDPID_ACCESS_CLIENT_*` variables are no longer read, and there is no service token to fetch.

3. **Sign in.** `/cloudpid login` opens your browser to cloudpid's sign-in (Cloudflare Access, as the owner) and catches the redirect on a loopback port. Over SSH, or anywhere the browser cannot reach that port, paste the URL it ends up at into the prompt pi shows. The sign-in is kept in `~/.pi/agent/cloudpid-auth.json` (mode 0600, one entry per endpoint, so a project pointed at a preview stage has its own), refreshed before it expires and whenever the endpoint refuses it. `/cloudpid logout` deletes the sign-in of the configured endpoint. `/cloudpid import` offers to sign in when there is none, or when it has ended (a grant lasts 14 days). Both `import` and `login` need pi's interactive mode (`import` refuses without it, even with a stored sign-in; `login` opens a browser or asks you to paste), so sign in from interactive pi.

4. **Optional: let the model use cloudpid too.** `/cloudpid` registers no MCP server. The model-facing entry is your own, in `~/.pi/agent/mcp.json` (sign in with `/mcp`; Access's managed OAuth, separate from `/cloudpid login`), and it should hide the import tools, which are for `/cloudpid` and never for a model:

   ```json
   {
     "mcpServers": {
       "cloudpid": {
         "url": "https://<host>/mcp",
         "toolExposure": { "session_import_*": "hidden" }
       }
     }
   }
   ```

5. **Add the Repo to an Environment** in cloudpid, if it is not in one: `/cloudpid` matches your checkout's `origin` to the Repos of your Environments and never creates one.

## Use it

`/cloudpid` takes a subcommand; with none, or an unknown one, it prints the usage and the endpoint it is set to and does nothing else. The subcommands complete as you type.

| Command                          | Does                                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| `/cloudpid import [instruction]` | imports this pi session (below)                                     |
| `/cloudpid login`                | signs in to the configured endpoint now, replacing a stored sign-in |
| `/cloudpid logout`               | deletes the stored sign-in of the configured endpoint               |

To import, in a checkout of the Repo, in a saved pi session (one with at least one message), when pi is idle:

```
/cloudpid import fix the failing test and open a PR
```

Everything after `import` is the instruction, sent to the new Session when the import ends; an instruction that starts with `login` or `logout` is still an instruction. Left out, the Session waits for you. `/cloudpid import` shows what it will do and asks first: the Environment, the branch, the commits it will push, the uncommitted files it will carry (count and names), the size, and the model.

- **The working tree moves only through the Repo's remote.** The branch is pushed fast-forward only: a remote with commits you lack refuses with "pull first". Your uncommitted changes, tracked and untracked but never ignored (so no `.env`), are read through a private index and pushed as one commit on HEAD to a ref of the import's own; your index and work tree are not touched. A hook never runs on these pushes.
- **The branch** is the local branch, or the name of its upstream on `origin`. On the default branch or a detached HEAD, it asks for a name (a slug of the title is offered) and runs `git switch -c`. If another Workspace holds the branch, you can remove that Workspace in cloudpid (this deletes its Sessions) and retry, pick a new name, or cancel.
- **Afterwards** it offers to `git stash push -u -m "cloudpid: imported as <url>"` your changes, since the work goes on in cloudpid, and prints how to come back: `git switch <branch> && git pull --ff-only`, then `git stash drop`. It leaves a `cloudpid-import` entry in the pi session, so running `/cloudpid import` again asks "already imported as <url>; import again as a new Session?". It never follows the Run the instruction starts: open the URL.
- **A failed push** cancels the import and takes its ref off the remote. An import that is not finished expires after an hour.
- **An older endpoint** (one without the import tools) is refused with "the endpoint is older than this extension".

## Develop

```sh
pi -e packages/pi-cloudpid/src/index.ts      # the dev loop, from the repo root
bun run --cwd packages/pi-cloudpid test      # includes an import against a stub endpoint behind a stub authorization server
bun run --cwd packages/pi-cloudpid build     # dist/index.js and dist/package.json
```

It is the one package with a build: `bun build --target=node --format=esm` makes a single `dist/index.js` with the pi host packages (`@earendil-works/pi-*`, `typebox`) external as peer dependencies, and `dist/package.json` carries `pi.extensions` and nothing to install. `build.ts` fails the build if the bundle reaches Workers code (`cloudflare:*`, workerd, alchemy, pi-durable, `@cloudpid/extensions`). `PI_CLOUDPID_SHA` (CI sets it to the `main` commit, else `git rev-parse HEAD`) is built in and sent as `X-Cloudpid-Client: pi-cloudpid/<sha>`. After `Deploy prod` succeeds, CI appends a commit with `dist/` to the orphan branch `pi-cloudpid` ([`docs/development/infra.md`](https://github.com/ian-pascoe/cloudpid/blob/main/docs/development/infra.md) → _CI_).
