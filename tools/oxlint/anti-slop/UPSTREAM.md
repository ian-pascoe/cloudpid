# Upstream provenance

- **Source repository:** https://github.com/dmmulroy/anti-slop
- **Source revision:** `13909c9e07590f5a85d93c62712259fe14a883f7` (repository HEAD when copied). The newest commit touching `skills/install-anti-slop/` at that revision is `d2a9aea3b896ffcb291a85f2c1301aa2543ad8c8`.
- **Pristine snapshot:** `skills/install-anti-slop/assets/anti-slop/` at the source revision. The files here matched it exactly (`diff -r`) when installed. Only this `UPSTREAM.md` was added afterwards.
- **Installed with:** `node skills/install-anti-slop/scripts/install.mjs` (default destination).

## Installed plugin paths

- Generic plugin: `tools/oxlint/anti-slop/index.ts` (`anti-slop`)
- Effect plugin: `tools/oxlint/anti-slop/effect/index.ts` (`anti-slop-effect`), enabled because `package.json` depends on `effect` directly
- Vendored Stylistic code: `tools/oxlint/anti-slop/vendor/eslint-stylistic/` (keeps its own `LICENSE` and `UPSTREAM.md`)

## Intentional deviations

- In the plugin source, only the imports: `@oxlint/plugins` became `vite-plus/lint/plugins`, which re-exports it (docs/adr/0055-vite-plus-and-pnpm.md).
- Configuration outside this directory:
  - The root `vite.config.ts` loads the plugins (`lint.jsPlugins`) and leaves this directory and `.repos/**`, the read-only reference clones, out of `vp lint` and `vp fmt`.
  - The root `tsconfig.json` excludes `tools/oxlint/anti-slop`. That file targets Cloudflare Workers with Effect language-service rules, and the plugin is Oxlint tooling that imports `.ts` paths.
- Dependency: none of its own; `@oxlint/plugins` comes with `vite-plus`, at the version the root `package.json` pins.
