// @effect-diagnostics missingPipeableSignature:off preferEffectRecord:off -- a plain function over the Models object.
// A `Models` whose requests carry a changed context: the shape the image limit (`./browser/images.ts`) and the
// Session's absent-tool flattening share.
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";
import * as Predicate from "effect/Predicate";

/**
 * `models` with the context of every request (`stream`, `complete`, `streamSimple`, `completeSimple`) replaced by
 * `map(model, context)`; every other property is the models object's own. `map` returns its context as it was when there is
 * nothing to change.
 */
export const contextMappedModels = (
  models: Models,
  map: (model: Model<Api>, context: Context) => Context,
): Models => {
  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple"> = {
    stream: (model: Model<Api>, context, options) =>
      models.stream(model, map(model, context), options),
    complete: (model: Model<Api>, context, options) =>
      models.complete(model, map(model, context), options),
    streamSimple: (model: Model<Api>, context, options) =>
      models.streamSimple(model, map(model, context), options),
    completeSimple: (model: Model<Api>, context, options) =>
      models.completeSimple(model, map(model, context), options),
  };

  return new Proxy(models, {
    get: (target, key) => {
      if (Object.hasOwn(requests, key)) {
        // SAFETY: `key` is one of the request methods, checked just above.
        return requests[key as keyof typeof requests];
      }

      // SAFETY: every other property is read from the models object itself, as its own type describes it.
      const value: unknown = target[key as keyof Models];

      // Methods run on the models object itself, whose private state a proxy would not have.
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};
