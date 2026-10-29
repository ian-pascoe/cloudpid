# Workers, bindings and workerd tests

The rules the platform imposes on the stack's Workers, which the code cannot show. The Workers and Durable Objects themselves are described in [`../architecture/overview.md`](../architecture/overview.md).

## Effect Workers and plain Workers

A Worker is declared in its own app with `main: import.meta.url`; the stack (`infra/alchemy.run.ts`) imports and `yield*`s it. That makes it an Effect Worker, whose generated entry exports only `default` and its Effect DO classes.

A Worker that must export anything else (a plain DO class, a `WorkerEntrypoint` such as `@cloudflare/computer`'s `WorkspaceServiceProxy`) is a plain async Worker instead: its entry module (`main: new URL("./worker.ts", import.meta.url).href`) holds no alchemy code, and a separate resource file declares it, as `apps/server/src/workspace/` does for `Workspaces`. The plain Workers are:

- **`Workspaces`** (`apps/server/src/workspace/`): the Workspace DO and `WorkspaceServiceProxy`.
- **`Browsers`** (`apps/browser`): the `BrowserHost` DO, `@cloudflare/codemode`'s `CodemodeRuntime` (the facet `agents/browser`'s tool keeps its runs in) and `ContainerPreviews`, the entrypoint Browser Run's outbound Workers send the Container previews' hosts to (ADR-0023; the host makes it with `ctx.exports`). Its bindings are `BROWSER` (Browser Run, `Cloudflare.Browser()`), a Worker Loader `LOADER`, and `CONTAINER_PREVIEWS`, a service binding to the Workspaces Worker's `WorkspaceContainerPreviews` entrypoint (`Cloudflare.WorkerEntrypoint(workspaces, "WorkspaceContainerPreviews")`; `Browsers({ workspaces })` takes that Worker's resource, so it deploys first). `apps/browser` cannot import `@cloudpid/server`, which imports it.
- **`CodemodeSandboxes`** (`apps/codemode-sandbox`): pi-codemode's `CodemodeSandboxDurableObject`, exported as `CodemodeSandbox`. It bundles QuickJS's `.wasm` as a compiled module through alchemy's own rolldown rule.

The browser and codemode sandbox Workers have `workersDev: false` and no routes: nothing reaches them but the Session DOs' `BROWSER_HOST` and `CODEMODE_SANDBOX` bindings, declared in `apps/server/src/worker.ts` with each Worker's `scriptName` Output (not a literal), so they deploy first.

## Bindings

- **Call an RPC binding's methods directly** (`binding.acquire(options)`). Reading anything else off one, such as `binding.acquire.bind`, is itself an RPC call to the binding, which fails.
- **Workers that deploy apart only ever gain.** Each pair of Workers deploys separately, so an RPC surface between them only gains operations or trailing optional arguments, never changes existing ones.
- **`IMAGES`** (`Cloudflare.Images.Images`, declared in `apps/server/src/worker.ts`) has no backing resource and rides on the script upload. `alchemy dev` emulates it locally with sharp (size and format, not quality).
- **Custom spans**: the Session DO imports `tracing` from `cloudflare:workers` when an object is built, not at module load, since the stack imports `Session.ts` under Node. It needs compatibility date 2026-07-28 or later (the stack uses 2026-08-31). The spend limit and usage are in `apps/server/src/session/spend.ts`.

## The Workspace DO

- **Peers of `@cloudflare/computer`.** The Worker Shell's `jq` is an optional computer module (`@cloudflare/computer/shell/jq`), its `git` needs `createGitClient()`, which loads `@platformatic/vfs`, and the Worker Shell itself needs `just-bash`; the Workspace DO passes them (`Workspace.ts`). Every package that depends on `@cloudflare/computer` (`apps/server`, `packages/computer-env`) lists `@platformatic/vfs` and `just-bash` too, so pnpm resolves one instance of computer (two give mismatched types).
- **`mkdir -p` above a read-only mount.** computer refuses `mkdir -p` of any path above a read-only mount (the Skill set's, at `/workspace/.agents/skills`), `/workspace` included, though the directory exists. `ensureDirectory` (`packages/computer-env`) makes that a no-op for the file operations and, through `GuardedFilesystem` (`apps/server/src/workspace/tracked.ts`), for the Worker Shell. A Workspace stub that does not extend `TrackedWorkspaceStub` must return a `GuardedFilesystem` as its `fs`.
- **`bash` routing lists.** When computer or its shell changes what the Worker Shell runs, update `WORKER_SHELL_COMMANDS`, `WORKER_SHELL_BUILTINS`, `CONTAINER_PROGRAMS` and the git subcommands in `packages/extensions/src/bash-routing.ts`. `apps/server/src/workspace/bash.workerd.test.ts` runs the lists through the real shell and checks each git form against real git's output. Only read-only `git` forms run on the Worker Shell, because its git (isomorphic-git) is not always git's.
- **Container-only paths' scripts** (`container-files.ts`) are tested in plain bash in `container-files.test.ts`; deployed, they run through computerd's FUSE mount, which the tests do not have.

## workerd tests

Tests that need workerd (Durable Object storage, alarms, eviction) are `src/**/*.workerd.test.ts`, run by the package's `workerd` Vitest project through `@cloudflare/vitest-plugin` (see `apps/server/vitest.config.ts`): `bun --cwd <package dir> vitest run --project workerd <file>`. Give miniflare what the code under test binds:

- **Browser host:** the facet class as a Durable Object too (`CODEMODE_RUNTIME`, else `ctx.exports.CodemodeRuntime` is not a class), `workerLoaders: { LOADER: {} }`, and a stand-in Workspaces Worker for `CONTAINER_PREVIEWS` (an auxiliary `workers` entry; see `apps/browser/vitest.config.ts`).
- **Codemode sandbox:** `modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }]`.
- **Images:** `images: { binding: "IMAGES" }`, as the `workerd-session` project does.
