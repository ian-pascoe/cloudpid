// The workerd test Worker: every test Durable Object, bound by `vitest.config.ts`, and `McpWorker`'s `McpEngine`, which a
// test `McpHost` reaches through `ctx.exports` to run a call end to end (`mcp/host.fixture.ts`).
export { McpEngine } from "@cloudpid/mcp-worker/engine";

export { TestMcpHost } from "./mcp/host.fixture.ts";

export { TestRegistry } from "./registry/store.fixture.ts";

export { TestSession } from "./session/host.fixture.ts";

export { TestSubagentSession } from "./session/subagents.workerd.fixture.ts";

export default {
  fetch: () => new Response("cloudpid workerd test worker"),
};
