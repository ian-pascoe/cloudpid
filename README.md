<p align="center">
  <img src="apps/web/public/icon.svg" alt="" width="128" height="128">
</p>

# cloudpid

_Pronounced "cloud-pi-d"._

The pi coding agent, running all the time on Cloudflare. It is the owner's own pi harness (the same tools, skills, roles, and conversation model) with its Sessions in Durable Objects, so they keep working while the laptop is closed. The owner checks on them and steers them from a phone or a desk.

- **Sessions** run in Durable Objects through pi-durable and survive restarts and deploys.
- **Workspaces** hold the files in `@cloudflare/computer`, with a Container per Workspace for commands that need real binaries.
- **The web app** is an installable PWA that sends a Web Push when a Run ends, fails, or needs the owner.
- **alchemy** provisions everything, and Effect is the application language.

It has a single user: only the owner gets past Cloudflare Access.

## Docs

- [`docs/architecture/`](docs/architecture/overview.md): the settled design, the repository layout, and the milestones.
- [`docs/development/`](docs/development/): running, deploying and upgrading the stack.
- [`GLOSSARY.md`](GLOSSARY.md): the terms used in the code, the docs, and the UI.
- [`docs/adr/`](docs/adr/): the decisions that are hard to reverse.
- [`AGENTS.md`](AGENTS.md): how to work in the repo.

## Development

You need Node, Bun (the version in `package.json`'s `packageManager`, which `mise.toml` pins too), and Docker with `buildx` to build the Container image.

```sh
bun install
bun run check                               # typecheck, lint, test, format check
bun --cwd infra run dev                     # workerd on http://localhost:1337
bun --cwd apps/web run dev                  # the web app, proxied to the dev server
```

Deploying needs the secrets listed in [`docs/development/infra.md`](docs/development/infra.md) → _Secrets and variables_:

```sh
bun --cwd infra run deploy --stage dev_$USER
```
