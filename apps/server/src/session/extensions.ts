import * as Effect from "effect/Effect";
import { Dice } from "./dice.ts";

/** The extensions every Session's conversations run with. */
export const sessionExtensions = Effect.all([Dice]);
