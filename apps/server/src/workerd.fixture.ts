// The workerd test Worker: every test Durable Object, bound by `vitest.config.ts`.
export { TestRegistry } from "./registry/store.fixture.ts";

export { TestSession } from "./session/host.fixture.ts";

export { TestSubagentSession } from "./session/subagents.workerd.fixture.ts";

export default {
  fetch: () => new Response("cloudpid workerd test worker"),
};
