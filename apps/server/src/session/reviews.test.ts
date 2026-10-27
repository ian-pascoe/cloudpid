// The wrap that drops a deleted subagent's drafts after `subagent_delete` (`annotationsPruningTools`), over a real draft
// store in memory and a fake `subagent_delete` that deletes the subagent from the Subagents document as the tool does.
// The rest of the Reviews run on a Session host, in workerd (`annotations.workerd.test.ts`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { Annotation } from "@cloudpid/protocol";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type AnnotationStorage, makeAnnotationStore } from "./annotations.ts";
import { annotationsPruningTools } from "./reviews.ts";

/** Storage in memory, as the object's synchronous key-value storage behaves. */
const memory = (): AnnotationStorage => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: each key holds what was put under it, which the caller names the type of.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => values.delete(key),
  };
};

const draft = (id: string, conversationId?: number): Annotation => {
  const made: Annotation = {
    id,
    source: { kind: "changes", repo: "app", head: null },
    path: "src/a.ts",
    side: "new",
    start: 1,
    end: 1,
    quote: ["a"],
    more: 0,
    text: "Why?",
    createdAt: 1,
    updatedAt: 1,
  };

  // SAFETY: a conversation ID the Subagents document names.
  return conversationId === undefined ? made : { ...made, conversationId: conversationId as never };
};

/** Subagents `1` (conversation 7) and `2` (conversation 8), by conversation. */
const BOTH = { "7": "1", "8": "2" };

/** Subagent `2` alone, once `1` is deleted. */
const AFTER = { "8": "2" };

/** The Subagents document with subagent `1` (conversation 7) until `subagent_delete` deletes it. */
const subagents = () => {
  let deleted = false;

  const deleteTool: ToolRegistration =
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the wrap reads only `name` and calls `execute`, which the fake has.
    {
      name: "subagent_delete",
      description: "Delete a subagent",
      parameters: {},
      execute: async () => {
        deleted = true;

        return { content: [{ type: "text", text: "Deleted." }] };
      },
    } as unknown as ToolRegistration;

  const api = (fails = false) =>
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the wrap reads only `snapshot`, which the fake answers.
    ({
      snapshot: async () => {
        if (fails) throw new Error("unreachable");

        return {
          agents: {},
          conversations: deleted ? AFTER : BOTH,
          tombstones: [],
          nextIndex: {},
          waiters: {},
        };
      },
    }) as unknown as ToolExecutionApi;

  return { deleteTool, api };
};

describe("the subagent_delete wrap", () => {
  const setup = async () => {
    const store = makeAnnotationStore({ storage: memory(), announce: () => Effect.void });

    for (const each of [draft("root"), draft("seven", 7), draft("eight", 8)]) {
      await Effect.runPromise(store.save(each));
    }

    const { deleteTool, api } = subagents();
    const [wrap] = annotationsPruningTools([deleteTool], store).wraps ?? [];

    if (wrap === undefined || !("tool" in wrap)) throw new Error("subagent_delete is not wrapped");

    return { store, run: wrap.wrap(deleteTool), api };
  };

  it("deletes the drafts addressed to the subagent the call deleted, and keeps the others", async () => {
    const { store, run, api } = await setup();
    // SAFETY: the wrap only hands the context on, to the fake tool and the fake document read, which ignore it.
    const context = {} as never;

    await run.execute({}, api(), context);

    expect((await Effect.runPromise(store.list)).map((each) => each.id)).toEqual(["root", "eight"]);
  });

  it("keeps every draft when the Subagents document cannot be read, and the call still answers", async () => {
    const { store, run, api } = await setup();
    // SAFETY: as above.
    const context = {} as never;

    await expect(run.execute({}, api(true), context)).resolves.toMatchObject({
      content: [{ type: "text", text: "Deleted." }],
    });
    expect(await Effect.runPromise(store.list)).toHaveLength(3);
  });
});
