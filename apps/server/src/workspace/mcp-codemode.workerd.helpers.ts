// What the tests of a script's MCP call share (`mcp-codemode.workerd.test.ts`, `mcp-codemode-legacy.workerd.test.ts`): a
// Session on a Workspace whose scripted model runs a script that calls the fake server's `ask` tool
// (`./mcp-codemode.fixture.ts`). It is not a test file, so importing it registers no tests.
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off missingPipeableSignature:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import type { TestMcpCodemodeSession } from "./mcp-codemode.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly MCP_CODEMODE_SESSIONS: DurableObjectNamespace<TestMcpCodemodeSession>;
    }
  }
}

let sessions = 0;

/** A new Session, its name, and a Workspace no other test uses. */
export const session = () => {
  const name = `mcp-codemode-${(sessions += 1)}`;

  return { stub: env.MCP_CODEMODE_SESSIONS.getByName(name), name, workspace: name };
};

/** The scripted model call of the `codemode` tool with `code`. */
export const script = (code: string) => `call:codemode:${JSON.stringify({ code })}`;

/** `vi.waitFor`, with room for a loaded CI runner. */
export const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

export type Stub = DurableObjectStub<TestMcpCodemodeSession>;

export const pending = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpPending());

export const pendingSampling = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpSamplingPending());

export const sent = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.mcpSent());

/** Start a Run whose script awaits the server's `ask` tool, and wait until its question is on a card. */
export const asked = async (
  stub: Stub,
  workspace: string,
  code: string,
  legacy = false,
  /** Whether the Modern server asks a Sampling request in the round too, which the Session's model answers. */
  sampling = false,
) => {
  await runInDurableObject(stub, async (instance: TestMcpCodemodeSession) => {
    instance.bindWorkspace(workspace);

    if (legacy) instance.mcpLegacy();

    if (sampling) instance.mcpSampling();

    instance.script(sampling ? [script(code), "a sampled reply", "done"] : [script(code), "done"]);
    await instance.submit({ requestId: crypto.randomUUID(), text: "go" });
  });

  await settles(async () => expect(await pending(stub)).toHaveLength(1));
};

/** Shut the instance down as an eviction does, and start the next one at its alarm. */
export const evict = async (stub: Stub) => {
  await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.closeSandbox());
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
};

/**
 * Shut the instance down as an eviction does and leave it down: no alarm runs, so a test can let a script's deadline pass
 * while no instance exists, then run `runDurableObjectAlarm` to start the next one.
 */
export const evictAndLeave = async (stub: Stub) => {
  await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.closeSandbox());
  await evictDurableObject(stub);
};

export const idle = (stub: Stub) =>
  settles(async () =>
    expect(
      await runInDurableObject(stub, (instance: TestMcpCodemodeSession) => instance.idle()),
    ).toBe(true),
  );

/** The script that awaits the server's `ask` tool and prints its answer. */
export const ASK = `
  const answer = await tools.mcp__docs__ask({});
  text(JSON.stringify(answer));
  return "asked";
`;
