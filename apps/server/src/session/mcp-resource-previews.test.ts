// The Session's checks of the owner's preview of a resource link (`./mcp-resource-previews.ts`): a page that is visible, the
// limits of a socket, a spill read from the Workspace, what is answered as it is read, and the end of what a socket has in
// flight.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off asyncFunction:off newPromise:off globalTimers:off
import {
  MAX_MCP_RESOURCE_IN_FLIGHT,
  MAX_MCP_RESOURCE_PER_MINUTE,
  type McpResourcePreviewAnswer,
} from "@cloudpid/protocol";
import { decodeSlotHeld, PREVIEW_SLOT_OVER, takeDecodeSlot } from "@cloudpid/extensions/mcp";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import {
  resourcePreviewsOver,
  type ResourceRead,
  type SpillRead,
} from "./mcp-resource-previews.ts";

// SAFETY: the Session only keys its counts by the socket, and never calls it.
const socket = () => ({}) as WebSocket;

const contents = (text: string): McpResourcePreviewAnswer => ({
  status: "contents",
  contents: [{ uri: "file:///a", text }],
});

/** One preview, answered and its scope closed, as the socket does once it has sent the answer. */
const scoped = <A>(preview: Effect.Effect<A, never, Scope.Scope>) =>
  preview.pipe(Effect.scoped, Effect.runPromise);

const SPILL = "/workspace/.cloudpid/tmp/tmp-a1/mcp-b2.png";

const read = (view: WebSocket, visible = true, more: Partial<ResourceRead> = {}): ResourceRead => ({
  socket: view,
  visible,
  conversation: "1",
  server: "docs",
  uri: "file:///a",
  workspaceOf: () => Effect.undefined,
  spill: () => Effect.succeed<SpillRead>({ kind: "missing" }),
  ...more,
});

describe("a preview's checks in the Session", () => {
  it("refuses a page that has not said it is visible, and asks the host for nothing", async () => {
    let asked = 0;

    const previews = resourcePreviewsOver({
      read: () => Effect.sync(() => (asked++, contents("x"))),
      now: () => 0,
    });

    expect(await scoped(previews.resourcePreview(read(socket(), false)))).toMatchObject({
      status: "unavailable",
      reason: "hidden",
    });
    expect(asked).toBe(0);
  });

  it("answers what the server sent as it was sent: a preview is the owner's own view, and is not redacted", async () => {
    const previews = resourcePreviewsOver({
      read: () => Effect.succeed(contents("the token is hunter2")),
      now: () => 0,
    });

    expect(await scoped(previews.resourcePreview(read(socket())))).toEqual(
      contents("the token is hunter2"),
    );
  });

  describe("a Result Spill's chip", () => {
    const serving = (file: SpillRead) => {
      const asked: Array<string> = [];
      let reads = 0;

      const previews = resourcePreviewsOver({
        read: () => Effect.sync(() => (reads++, contents("from the server"))),
        now: () => 0,
      });

      const ask = (path: string | undefined) =>
        scoped(
          previews.resourcePreview(
            read(socket(), true, {
              path,
              spill: (conversation, at) =>
                Effect.sync(() => (asked.push(`${conversation}:${at}`), file)),
            }),
          ),
        );

      return { ask, asked, reads: () => reads };
    };

    it("is previewed from its file in the Workspace, and the server is not asked", async () => {
      const held = serving({ kind: "base64", base64: "AQID+g==" });

      expect(await held.ask(SPILL)).toEqual({
        status: "contents",
        contents: [{ uri: "file:///a", blob: "AQID+g==" }],
      });
      expect(held.asked).toEqual([`1:${SPILL}`]);
      expect(held.reads()).toBe(0);
    });

    it("falls back to one read by its URI when cleanup removed the file", async () => {
      const gone = serving({ kind: "missing" });

      expect(await gone.ask(SPILL)).toEqual(contents("from the server"));
      expect(gone.reads()).toBe(1);
    });

    it("is too large past a preview's bytes, without a read of the server", async () => {
      const big = serving({ kind: "too_large" });

      expect(await big.ask(SPILL)).toMatchObject({ status: "unavailable", reason: "too_large" });
      expect(big.reads()).toBe(0);
    });

    it("is not read from the Workspace when the card names no spill", async () => {
      const none = serving({ kind: "base64", base64: "AQ==" });

      expect(await none.ask(undefined)).toEqual(contents("from the server"));
      expect(none.asked).toEqual([]);
    });

    it("counts against the socket's limits as any preview does", async () => {
      const previews = resourcePreviewsOver({
        read: () => Effect.succeed(contents("x")),
        now: () => 0,
      });

      const view = socket();

      for (let index = 0; index < MAX_MCP_RESOURCE_PER_MINUTE; index++) {
        await scoped(
          previews.resourcePreview(
            read(view, true, {
              path: SPILL,
              spill: () => Effect.succeed<SpillRead>({ kind: "base64", base64: "" }),
            }),
          ),
        );
      }

      expect(
        await scoped(previews.resourcePreview(read(view, true, { path: SPILL }))),
      ).toMatchObject({ reason: "limit" });
    });
  });

  it("limits a socket to a number of previews a minute, counted as they arrive, and lets it ask again a minute on", async () => {
    let now = 0;

    const previews = resourcePreviewsOver({
      read: () => Effect.succeed(contents("x")),
      now: () => now,
    });

    const view = socket();
    const ask = () => scoped(previews.resourcePreview(read(view)));

    for (let index = 0; index < MAX_MCP_RESOURCE_PER_MINUTE; index++) {
      expect(await ask()).toMatchObject({ status: "contents" });
    }

    expect(await ask()).toMatchObject({ status: "unavailable", reason: "limit" });
    // Another socket is not counted.
    expect(await scoped(previews.resourcePreview(read(socket())))).toMatchObject({
      status: "contents",
    });

    now = 61_000;
    expect(await ask()).toMatchObject({ status: "contents" });
  });

  it("limits what one socket has in flight, and aborts it all when the socket goes", async () => {
    const gate = Deferred.makeUnsafe<void>();
    const signals: AbortSignal[] = [];

    const previews = resourcePreviewsOver({
      read: (input) =>
        Effect.sync(() => signals.push(input.signal)).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(contents("x")),
        ),
      now: () => 0,
    });

    const view = socket();

    const pending = Array.from({ length: MAX_MCP_RESOURCE_IN_FLIGHT }, () =>
      scoped(previews.resourcePreview(read(view))),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toHaveLength(MAX_MCP_RESOURCE_IN_FLIGHT);

    expect(await scoped(previews.resourcePreview(read(view)))).toMatchObject({
      status: "unavailable",
      reason: "limit",
    });

    await Effect.runPromise(previews.endResourcePreviews(view));
    expect(signals.every((each) => each.aborted)).toBe(true);

    Effect.runSync(Deferred.succeed(gate, undefined));
    await Promise.all(pending);
  });
});

describe("large previews", () => {
  /** A large spill, which asks for the decode slot as the host does once it knows the file's size. */
  const large = (events: Array<string>, name: string) =>
    resourcePreviewsOver({
      read: () => Effect.succeed(contents("x")),
      now: () => 0,
    }).resourcePreview(
      read(socket(), true, {
        path: SPILL,
        spill: (_conversation, _path, hold) =>
          hold(PREVIEW_SLOT_OVER + 1).pipe(
            Effect.map((taken): SpillRead => {
              events.push(`${name} ${taken}`);

              return { kind: "base64", base64: "AQ==" };
            }),
          ),
      }),
    );

  it("take turns: the second reads only once the first's answer has been sent", async () => {
    const events: Array<string> = [];
    const firstScope = Scope.makeUnsafe();
    const first = await Effect.runPromise(large(events, "first").pipe(Scope.provide(firstScope)));

    expect(first).toMatchObject({ status: "contents" });

    // The first's answer is made, and not yet sent: its scope is open, so the slot is held.
    const secondPreview = large(events, "second").pipe(
      Effect.tap(() => Effect.sync(() => events.push("second answered"))),
    );

    const second = Effect.runPromise(secondPreview.pipe(Effect.scoped));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["first held"]);

    // Sent: the scope closes, and the next preview takes its turn.
    await Effect.runPromise(Scope.close(firstScope, Exit.void));
    expect(await second).toMatchObject({ status: "contents" });
    expect(events).toEqual(["first held", "second held", "second answered"]);
  });

  it("lets a waiting preview go when its page is closed", async () => {
    const previews = resourcePreviewsOver({
      read: () => Effect.succeed(contents("x")),
      now: () => 0,
    });

    const events: Array<string> = [];
    const holder = Scope.makeUnsafe();

    await Effect.runPromise(large(events, "holder").pipe(Scope.provide(holder)));

    // Another page's preview waits behind the holder, and its socket goes.
    const view = socket();

    const waiting = scoped(
      previews.resourcePreview(
        read(view, true, {
          path: SPILL,
          spill: (_c, _p, hold) =>
            hold(PREVIEW_SLOT_OVER + 1).pipe(
              Effect.map((taken): SpillRead => {
                if (taken === "held") return { kind: "base64", base64: "AQ==" };

                return { kind: taken };
              }),
            ),
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await Effect.runPromise(previews.endResourcePreviews(view));
    expect(await waiting).toMatchObject({ status: "unavailable", reason: "cancelled" });

    await Effect.runPromise(Scope.close(holder, Exit.void));
  });

  it("takes its turn once: the read by URI after a missing spill is the same turn, and does not wait for itself", async () => {
    const asked: Array<string> = [];
    const view = socket();
    const scope = Scope.makeUnsafe();

    const previews = resourcePreviewsOver({
      read: (input) =>
        Effect.suspend(() => input.holdSlot ?? Effect.succeed("none")).pipe(
          Effect.map((taken) => {
            asked.push(`read ${taken}`);

            return contents(taken);
          }),
        ),
      now: () => 0,
    });

    const answer = await Promise.race([
      Effect.runPromise(
        previews
          .resourcePreview(
            read(view, true, {
              path: SPILL,
              // The file is large, and then gone (or unreadable): the card reads the resource by its URI.
              spill: (_c, _p, hold) =>
                hold(PREVIEW_SLOT_OVER + 1).pipe(
                  Effect.map((taken): SpillRead => {
                    asked.push(`spill ${taken}`);

                    return { kind: "missing" };
                  }),
                ),
            }),
          )
          .pipe(Scope.provide(scope)),
      ),
      new Promise((resolve) => setTimeout(resolve, 500, "waited for itself")),
    ]);

    expect(answer).toEqual(contents("held"));
    expect(asked).toEqual(["spill held", "read held"]);

    // And the one turn is let go with the answer.
    expect(decodeSlotHeld()).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(decodeSlotHeld()).toBe(false);
  });

  it("gives its place in line back when what waits for the slot is given up on, not only when the page closes", async () => {
    const holder = Scope.makeUnsafe();
    const events: Array<string> = [];

    await Effect.runPromise(large(events, "holder").pipe(Scope.provide(holder)));

    const scope = Scope.makeUnsafe();

    // A preview whose wait for the slot is cut short (as a time limit on the spill's read would).
    const answer = await Effect.runPromise(
      resourcePreviewsOver({
        read: () => Effect.succeed(contents("x")),
        now: () => 0,
      })
        .resourcePreview(
          read(socket(), true, {
            path: SPILL,
            spill: (_c, _p, hold) =>
              hold(PREVIEW_SLOT_OVER + 1).pipe(
                Effect.timeout(30),
                Effect.map((taken): SpillRead => ({ kind: taken === "held" ? "missing" : taken })),
                Effect.orElseSucceed((): SpillRead => ({ kind: "missing" })),
              ),
          }),
        )
        .pipe(Scope.provide(scope)),
    );

    expect(answer).toEqual(contents("x"));

    // The holder goes, and the slot is free at once: the preview that gave up does not take it in the background.
    await Effect.runPromise(Scope.close(holder, Exit.void));

    const next = await takeDecodeSlot(undefined, 200);

    expect(next.kind).toBe("held");

    if (next.kind === "held") next.release();

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("a spill's read when the page goes", () => {
  it("is stopped with it, whatever the Workspace is doing", async () => {
    const view = socket();

    const previews = resourcePreviewsOver({
      read: () => Effect.succeed(contents("x")),
      now: () => 0,
    });

    const pending = scoped(
      previews.resourcePreview(read(view, true, { path: SPILL, spill: () => Effect.never })),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await Effect.runPromise(previews.endResourcePreviews(view));

    expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
  });
});
