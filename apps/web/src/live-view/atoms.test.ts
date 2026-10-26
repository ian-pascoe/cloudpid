// @effect-diagnostics preferEffectArray:off strictEffectProvide:off missingPipeableSignature:off -- a fake browser over native arrays, given to a Live View held in an atom.

// The screen's atoms over a Live View with a fake link source and no handoff: the seam the Browser Pane (#238) uses.
// The web tests have no DOM, so this stands in for rendering the screen: it drives what `<LiveScreen>` reads (the state)
// and calls (show a window, Try again) through a registry.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Reactivity from "effect/reactivity/Reactivity";
import { ImageEncoderLive } from "../chat/image-encode.ts";
import { UploadsLive } from "../chat/uploads.ts";
import { PushManagerLive } from "../push.ts";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { appRuntime } from "../runtime.ts";
import { layerSessionProbe } from "../session/client.ts";
import { liveViewStateAtom, retryLiveViewAtom, showLiveViewWindowAtom } from "./atoms.ts";
import { LiveViewError } from "./cdp-socket.ts";
import { fakeBrowser } from "./connection.testing.ts";
import { make, type LiveViewState } from "./connection.ts";

/** A registry whose runtime has the fake browser's sockets, and a Live View atom over the fake's link source. */
const screen = (options: { readonly buildFails?: number } = {}) => {
  const fake = fakeBrowser({
    windows: () => [{ targetId: "W", openerId: "T", title: "Pop-up", link: "" }],
  });

  let builds = 0;

  const view = appRuntime.atom(
    Effect.suspend(() => {
      builds += 1;

      return builds <= (options.buildFails ?? 0)
        ? Effect.fail(LiveViewError.make({ message: "No links yet." }))
        : make(fake.source);
    }),
  );

  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        appRuntime.layer,
        Layer.mergeAll(
          fake.layer,
          Clipboard.layer,
          layerSessionProbe,
          PushManagerLive,
          UploadsLive,
          ImageEncoderLive,
          fakeRegistryLayer({}),
          Reactivity.layer,
          KeyValueStore.layerMemory,
        ),
      ),
    ],
  });

  return { fake, view, registry, builds: () => builds };
};

/** Resolves once `atom`'s value satisfies `done`. */
const until = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  done: (value: A) => boolean,
): Effect.Effect<A> =>
  Effect.callback((resume) => {
    const now = registry.get(atom);

    if (done(now)) return resume(Effect.succeed(now));

    const cancel = registry.subscribe(atom, (value) => {
      if (!done(value)) return;

      cancel();
      resume(Effect.succeed(value));
    });

    return Effect.sync(cancel);
  });

const status = (wanted: LiveViewState["status"]) => (state: LiveViewState) =>
  state.status === wanted;

describe("the screen's atoms over a Live View with a fake link source", () => {
  it.effect("goes from connecting to live, and follows a window the owner picks", () =>
    Effect.gen(function* () {
      const { view, registry } = screen();
      const state = liveViewStateAtom(view);

      registry.mount(state);
      expect(registry.get(state).status).toBe("connecting");

      yield* until(registry, state, status("live"));
      expect(registry.get(state).strip).toMatchObject({ tab: "T", shown: "T" });

      registry.set(showLiveViewWindowAtom(view), "W");
      yield* until(registry, state, (value) => value.strip?.shown === "W");
      expect(registry.get(state).strip?.windows).toEqual([
        { targetId: "W", openerId: "T", title: "Pop-up" },
      ]);

      registry.set(showLiveViewWindowAtom(view), "T");
      yield* until(registry, state, (value) => value.strip?.shown === "T");
    }),
  );

  it.effect("ends when the link source is over", () =>
    Effect.gen(function* () {
      const { fake, view, registry } = screen();
      const state = liveViewStateAtom(view);

      registry.mount(state);
      yield* until(registry, state, status("live"));

      fake.finish();
      registry.set(showLiveViewWindowAtom(view), "W");
      yield* until(registry, state, status("ended"));
    }),
  );

  it.effect("is lost when the Live View cannot be built, and Try again builds it", () =>
    Effect.gen(function* () {
      const { view, registry, builds } = screen({ buildFails: 1 });
      const state = liveViewStateAtom(view);

      registry.mount(state);

      const lost = yield* until(registry, state, status("lost"));

      expect(lost.failure).toContain("No links yet.");

      registry.set(retryLiveViewAtom(view), undefined);
      yield* until(registry, state, status("live"));
      expect(builds()).toBe(2);
    }),
  );
});
