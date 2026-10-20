import { Web, WebNetworkLive } from "@cloudpid/extensions/web";
import * as Effect from "effect/Effect";
import { Dice } from "./dice.ts";

/**
 * The extensions every Session's conversations run with. Needs `WebConfig`: the search keys, which the Session DO
 * reads with `Config.Redacted` so the stack binds them as secrets.
 */
export const sessionExtensions = Effect.all([Dice, Web]).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(WebNetworkLive),
);
