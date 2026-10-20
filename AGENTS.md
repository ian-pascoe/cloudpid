# AGENTS.md

## Reference repositories

`pnpm install` (its `prepare` script; rerun with `pnpm run prepare`) materializes these read-only references in `.repos/`.
Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                  | Path            | Useful for                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Effect-TS/effect`](https://github.com/Effect-TS/effect)   | `.repos/effect` | Source of the `effect` v4 dependency: `Effect`, `Layer`, `Schema`, services, and error-handling APIs (`packages/effect`), plus `platform`, `ai`, and `vitest` packages and their idiomatic usage patterns                                                        |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | `.repos/pi`     | Source of the `@earendil-works/pi-ai`, `pi-durable`, and `chord` dependencies (`packages/ai`, `packages/durable`, `packages/chord`): LLM provider API, durable agent storage and turn recovery, and multi-process object hosting that Pi on Cloudflare builds on |

## Git hooks

Husky hooks run on every commit and push:

- **pre-commit**: lint-staged runs `oxlint --fix` and `oxfmt` on staged files.
- **commit-msg**: commitlint requires [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `chore: …`).
- **pre-push**: `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check`. Tests run in CI; run `pnpm run check` for everything locally.
- **post-merge / post-checkout**: `pnpm install` when `pnpm-lock.yaml` changed, otherwise a reference-repository sync.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `ian-pascoe/cloudpid` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
