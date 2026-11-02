// docs/architecture/mcp-sign-in.md → The client document and the callback outside Access (The Access guard): what the
// stack gives the main Worker for its guard.

import * as Effect from "effect/Effect";
import { guardVars } from "./deployment.ts";

/**
 * The Worker's Access application and the vars of its guard. A deployed stage declares the application (`options.declare`), so
 * that its `aud` can be a var of the Worker; the Worker is enrolled in it through its `access` prop. That is a cycle in
 * alchemy's graph (the application's destinations are the Worker's id), which the engine settles through the Worker's
 * precreate stub. `alchemy dev` has no Access and no `aud`: nothing is declared, and the Worker is put in local mode
 * instead. Where the bundle itself runs (`runtime`) nothing is declared and no var is set, as the bundle reads the vars
 * from its environment. Only `alchemy dev` gets the local-mode var.
 */
export const accessProps = <
  Application extends { readonly aud: Audience },
  Audience,
  Error,
  Services,
>(options: {
  readonly declare: Effect.Effect<Application, Error, Services>;
  readonly runtime: boolean;
  /** Whether the stack is planned by `alchemy dev` (`AlchemyContext.dev`), which the caller reads once. */
  readonly dev: boolean;
}) =>
  Effect.gen(function* () {
    if (options.runtime) return { props: {}, vars: {} };

    if (options.dev) return { props: {}, vars: guardVars(undefined) };

    const application = yield* options.declare;

    return { props: { access: application }, vars: guardVars(application.aud) };
  });
