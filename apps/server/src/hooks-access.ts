// docs/architecture/triggers.md → Webhooks → Access, and ADR-0048: what the stack declares so that a Trigger URL reaches the
// Worker without an Access login. It is the fourth application on a deployed stage, beside the Worker's own owner-only
// application (`deployment()`), the MCP endpoint's (`mcp-access.ts`) and the sign-in paths' Bypass (`bypass-access.ts`).
// @effect-diagnostics missingPipeableSignature:off -- plain functions of the stack's props.

import * as Effect from "effect/Effect";
import { HOOKS_PREFIX } from "./hooks-path.ts";
import { appHost } from "./mcp-access.ts";

/**
 * The Hooks application's props: `self_hosted` with the one `public` destination `<host>/hooks/*` (a plain string from the
 * stage's app origin, so no Worker output is needed) and one Bypass/Everyone policy. A path-scoped application beats the
 * Worker's own. Access applies it to more than the shape of a Trigger URL (sub-paths, any capitalisation: #403), so the
 * Worker refuses every other form itself (`hooks-routes.ts`); `/hooks/*` does not cover the bare `/hooks`, which stays
 * behind Access. As with the Bypass application, `domain` is that destination, the same string, and `adopt` takes over a
 * leftover of a failed destroy instead of the deploy failing with a 409.
 */
export const hooksApplicationProps = (stage: string) => {
  const destination = `${appHost(stage)}${HOOKS_PREFIX}/*`;

  return {
    type: "self_hosted",
    domain: destination,
    adopt: true,
    destinations: [{ type: "public", uri: destination }],
    policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
  } as const;
};

/**
 * The stack's part for the Trigger URLs: on a live stage, the Hooks application (`options.declare`, which gets the props
 * above). `alchemy dev` has no Access, so it declares nothing, and nor does the bundle itself (`runtime`).
 */
export const hooksAccessProps = <Application, Error, Services>(options: {
  readonly stage: string;
  readonly runtime: boolean;
  /** Whether the stack is planned by `alchemy dev` (`AlchemyContext.dev`), which the caller reads once. */
  readonly dev: boolean;
  readonly declare: (
    props: ReturnType<typeof hooksApplicationProps>,
  ) => Effect.Effect<Application, Error, Services>;
}) =>
  Effect.gen(function* () {
    if (options.runtime) return;

    if (options.dev) return;

    yield* options.declare(hooksApplicationProps(options.stage));
  });
