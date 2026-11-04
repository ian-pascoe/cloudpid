// A union that reads a member it does not know as a fallback member (`docs/development/workers.md` → Bindings): every
// RPC edge only gains, so an older build decoding a newer one's value, over RPC or from storage, still reads the record.
// @effect-diagnostics missingPipeableSignature:off -- a constructor of Schemas, called directly.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * `literals` that read a value it does not list as `fallback`, never as a decoding failure: a newer deploy may add a
 * member, and an older one decoding it (over RPC, or from storage) must still read the record, as the generic member or
 * an existing neutral one.
 */
export const openLiterals = <S extends Schema.Top>(literals: S, fallback: S["Type"]) =>
  literals.pipe(Schema.catchDecoding(() => Effect.succeedSome(fallback)));
