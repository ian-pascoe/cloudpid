# What a test is for

A test earns its place by catching a regression no other test catches. Each one is paid for in CI time, in review, and in every refactor that has to move it. So test each rule once, where it lives, and test the wiring above it lightly. How to run a test file is in [`AGENTS.md`](../../AGENTS.md) → _Workspace_. What needs workerd, and how to wait in a test, is in [`workers.md`](workers.md) → _workerd tests_.

## Rules

1. **The owner tests the rule.** Test a rule (a limit, a refusal, a mapping, a retry cap, a rate limit) in full in the module that owns it. Each entry point above it gets one pass-through test that proves the wiring: an RPC handler, a socket message, a tool, a component. A shared mechanism is tested once, at its helper, and each tool or kind that uses it gets one pass-through. Examples:
   - output bounds: `packages/extensions/src/outputs.test.ts`;
   - the socket's rate limits: `apps/server/src/session/socket-requests.test.ts`;
   - a server-initiated MCP request's wait and withdrawal: `packages/mcp/src/sampling.test.ts`;
   - Decline, no-op and Secret-in-reason: `packages/extensions/src/approval-tools.test.ts`.
2. **Assert what the code computes.** A test earns its keep on behaviour the code produces: a custom transform, an invariant the code does not guarantee itself (the default model is in `SUPPORTED_MODELS`; every Visual library URL names an exact version), and one test per forward-compatibility mechanism (an unknown value reads as `unknown`; a hello without the field still reads). A constant, a default object, a table, a schema reading a plain struct, or a JSON round trip passes by construction and needs no test.
3. **Assert codes and structure.** Check the error code, kind, status, tool name or element. The wording of tool descriptions, prompts, notices, UI copy and error sentences stays free to change. When a sentence is itself the contract, the test says why.
4. **One row per branch.** An `it.each` table has a row for each branch the code takes. Security parsers (routes, hosts, CSP sources, SSRF addresses, return paths) keep a row for each rejection mechanism.
5. **Against a fake, test what the code under test does.** Above a fake Registry or host, test validation before the call, upkeep after it, ordering, and error mapping. A test that reads back what the fake was seeded with tests the fake.
6. **A `.workerd.test.ts` holds what needs workerd.** When `X.workerd.test.ts` sits beside `X.test.ts`, the workerd file keeps what only workerd can show (the list in [`workers.md`](workers.md) → _workerd tests_, plus real git through the Workspace's file provider) and one test of the binding's wiring. The scenarios stay in `X.test.ts`.
7. **A shim keeps one test until it goes.** A live rename or migration shim, or a legacy redirect, keeps one test: the old form reads as the new one. That test is deleted in the change that deletes the shim. Shipped migrations are held by the manifest check (`scripts/check-migration-manifests.sh`).
8. **Run it.** Test a script, Dockerfile or config by running it, or leave it to the CI job that uses it. A test reads source text only to hold two copies of one value in lockstep (`apps/web/src/sandbox-frame/style-values.test.ts`).
9. **Spend CI time on coverage.** A test that spawns a build or a tool (vite, oxlint, rolldown) carries one positive and one negative case per rule. Time is checked by counting work. A measurement, or a check that needs the network or a paid API, runs on demand behind an environment flag its doc names (`CHANGES_BENCH=1`; `MODEL_PROXY_API_KEY` in [`infra.md`](infra.md)).
10. **A cut is a doc change too.** A change that removes or moves a test also updates the test file's header comment and the architecture section's _Testing_ line that describe it.
