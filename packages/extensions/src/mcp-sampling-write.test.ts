// The write behind the Sampling card's *Always allow* and *Never* (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, The card): the server's definition gets `sampling: "allow"` or `"off"` at the Scope it is in, recorded as a change
// the owner approved, and the Environment's host is pushed the new set. The world is the shared fixture's.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { McpQuestionsError } from "./mcp/question-records.ts";
import { rememberSampling, SAMPLING_WRITE_TOOL } from "./mcp/sampling-write.ts";
import { DEFAULT, setup } from "./settings-mcp.fixture.ts";

const ENTRY = { url: "https://docs.example/mcp" };

const write = async (
  world: Awaited<ReturnType<typeof setup>>,
  source: { kind: string; slug?: string } | undefined,
  value: "allow" | "off",
) =>
  Effect.runPromise(
    rememberSampling({ settings: world.settings, mcp: world.access })({
      server: "docs",
      source,
      conversationId: ROOT_CONVERSATION_ID,
      value,
    }).pipe(Effect.result),
  );

describe("the Sampling card's write of the definition", () => {
  it("sets sampling at Global for a Global definition, as the owner's approved change, and pushes the Environment's host", async () => {
    const world = await setup({ global: { mcp: { servers: { docs: ENTRY } } } });
    const result = await write(world, { kind: "global" }, "allow");

    expect(Result.isSuccess(result)).toBe(true);
    expect(world.world.global).toMatchObject({
      mcp: { servers: { docs: { ...ENTRY, sampling: "allow" } } },
    });
    expect(world.changeCalls).toEqual([{ scope: "*", approved: true, guard: undefined }]);
    expect(world.recorded).toMatchObject([
      { field: "mcp.servers.docs", tool: SAMPLING_WRITE_TOOL, conversation: ROOT_CONVERSATION_ID },
    ]);
    expect(world.events).toEqual([
      "change * mcp.servers.docs",
      `pushes ${DEFAULT}`,
      `pushed ${DEFAULT}`,
    ]);
  });

  it("sets off at the Environment for the Environment's own definition", async () => {
    const world = await setup({ overrides: { [DEFAULT]: { mcp: { servers: { docs: ENTRY } } } } });
    const result = await write(world, { kind: "environment" }, "off");

    expect(Result.isSuccess(result)).toBe(true);
    expect(world.world.environments[DEFAULT]?.overrides).toMatchObject({
      mcp: { servers: { docs: { ...ENTRY, sampling: "off" } } },
    });
    expect(world.changeCalls).toEqual([{ scope: DEFAULT, approved: true, guard: undefined }]);
  });

  it("changes nothing for a Repo's definition or an unknown source", async () => {
    const world = await setup({ global: { mcp: { servers: { docs: ENTRY } } } });

    for (const source of [{ kind: "repo", slug: "acme/app" }, undefined]) {
      const result = await write(world, source, "allow");

      expect(Result.isFailure(result)).toBe(true);
      expect(Result.getOrUndefined(Result.flip(result))).toBeInstanceOf(McpQuestionsError);
    }

    expect(world.changeCalls).toEqual([]);
  });

  it("says so when the Settings have no such definition", async () => {
    const world = await setup();
    const result = await write(world, { kind: "global" }, "allow");

    expect(result.pipe(Result.flip, Result.getOrUndefined)?.message).toBe(
      "The Settings have no definition of docs to change",
    );
  });
});
