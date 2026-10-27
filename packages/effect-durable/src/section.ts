// Effect-defined pi-durable system prompt sections (ADR-0003).
import { type PromptInput, type PromptSection, section } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { invoker, settle } from "./chord.ts";

/**
 * A pi-durable prompt section `key` rendered by an Effect, run with the services of the Effect that builds it.
 * `undefined` omits the section; a failure or defect is thrown, which fails the request's preparation.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- as pi-durable's `section()`.
export const effectSection = <E, R>(
  key: string,
  render: (input: PromptInput) => Effect.Effect<string | undefined, E, R>,
  options?: { readonly tag?: boolean },
): Effect.Effect<PromptSection, never, R> =>
  Effect.map(Effect.context<R>(), (services) => {
    const invoke = invoker(services);

    return section(key, (input, context) => invoke(render(input), context).then(settle), options);
  });

/**
 * A section `key` read once per context, then shown as it was: `read` renders the text, which is the whole section
 * (nothing wraps it: `PromptInput.shown` holds the text as the request carried it). While `shown` holds a text for the
 * key the same text is returned and `read` is not run, so the section never reaches the provider as a patch to the
 * system prompt, the head of its cache prefix. A Handoff starts a context with nothing shown, and the next request
 * reads again. `read` giving `undefined` omits the section and so freezes nothing; a failure is thrown, as
 * `effectSection`'s is, which keeps nothing frozen either. An empty string is a text: it freezes "nothing to show".
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- as `effectSection`.
export const frozenSection = <E, R>(
  key: string,
  read: (input: PromptInput) => Effect.Effect<string | undefined, E, R>,
): Effect.Effect<PromptSection, never, R> =>
  effectSection(
    key,
    (input) => {
      const shown = input.shown[key];

      return shown === undefined ? read(input) : Effect.succeed(shown);
    },
    { tag: false },
  );
