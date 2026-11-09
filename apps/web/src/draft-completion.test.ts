import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readingOldWorker } from "./draft-completion.ts";

describe("the draft composer's completions", () => {
  it.effect("read a Worker from before the RPC, which answers a defect, as unsupported", () =>
    Effect.gen(function* () {
      expect(yield* readingOldWorker(Effect.die("Unknown request tag: draftComplete"))).toEqual({
        status: "unsupported",
        values: [],
        hasMore: false,
      });
      expect(
        yield* readingOldWorker(Effect.die(new Error("Unknown request tag: draftComplete"))),
      ).toMatchObject({ status: "unsupported" });
    }),
  );
});
