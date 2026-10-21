import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import { askCatalogAtom, CATALOG_RETRY_MS, CATALOG_TTL_MS, catalogAtom } from "./catalog.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";
import { conversationKey } from "./conversation.ts";

const CATALOG = {
  commands: [{ name: "export", description: "Export", argument: "none" }],
  templates: [{ name: "review", description: "Review", argumentHint: "<ref>" }],
  skills: [{ name: "deploy", description: "Deploy" }],
};

const ROOT = conversationKey("s1", undefined);

/** A live Session whose root composer reads its catalog. */
const setup = Effect.gen(function* () {
  const chat = chatRegistry();

  chat.registry.mount(sessionStatusAtom("s1"));
  chat.registry.mount(catalogAtom(ROOT));
  chat.registry.mount(askCatalogAtom(ROOT));
  yield* settle;
  yield* live(chat.latest());

  const ask = Effect.sync(() => {
    chat.registry.set(askCatalogAtom(ROOT), undefined);
  }).pipe(Effect.andThen(settle));

  const asked = () => sent(chat.latest(), "catalog");

  return { ...chat, ask, asked };
});

/** Move the page's clock on by `ms` (its timers are real, so the socket's heartbeat does not run). */
const later = (ms: number) =>
  Effect.sync(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the composer's catalog", () => {
  it.effect("asks when first asked for, and again only once its answer is 30 s old", () =>
    Effect.gen(function* () {
      const { registry, latest, ask, asked } = yield* setup;

      expect(registry.get(catalogAtom(ROOT))).toBeNull();

      yield* ask;

      expect(asked()).toHaveLength(1);

      yield* latest().say({ type: "result", id: asked()[0]?.id, result: CATALOG });

      expect(registry.get(catalogAtom(ROOT))).toEqual(CATALOG);

      yield* later(CATALOG_TTL_MS - 1);
      yield* ask;

      expect(asked()).toHaveLength(1);

      yield* later(1);
      yield* ask;

      expect(asked()).toHaveLength(2);
      // The catalog held is shown while the next is asked for.
      expect(registry.get(catalogAtom(ROOT))).toEqual(CATALOG);
    }),
  );

  it.effect("asks once while a request is out", () =>
    Effect.gen(function* () {
      const { ask, asked } = yield* setup;

      yield* ask;
      yield* ask;

      expect(asked()).toHaveLength(1);
    }),
  );

  it.effect("asks again 5 s after the Session could not answer, keeping what it had", () =>
    Effect.gen(function* () {
      const { registry, latest, ask, asked } = yield* setup;

      yield* ask;
      yield* latest().say({ type: "error", id: asked()[0]?.id, message: "Busy" });

      expect(registry.get(catalogAtom(ROOT))).toBeNull();

      yield* later(CATALOG_RETRY_MS - 1);
      yield* ask;

      expect(asked()).toHaveLength(1);

      yield* later(1);
      yield* ask;

      expect(asked()).toHaveLength(2);
    }),
  );

  it.effect("keeps each conversation's catalog apart", () =>
    Effect.gen(function* () {
      const { registry, latest, ask, asked } = yield* setup;
      const child = conversationKey("s1", 2);

      registry.mount(catalogAtom(child));
      registry.mount(askCatalogAtom(child));
      yield* ask;
      registry.set(askCatalogAtom(child), undefined);
      yield* settle;

      const [rootAsk, childAsk] = asked();

      expect(childAsk).toMatchObject({ conversationId: 2 });

      yield* latest().say({ type: "result", id: rootAsk?.id, result: CATALOG });

      expect(registry.get(catalogAtom(child))).toBeNull();

      yield* latest().say({ type: "result", id: childAsk?.id, result: { ...CATALOG, skills: [] } });

      expect(registry.get(catalogAtom(child))?.skills).toEqual([]);
      expect(registry.get(catalogAtom(ROOT))).toEqual(CATALOG);
    }),
  );
});
