// docs/architecture/mcp-sign-in.md → The client document and the callback outside Access (The Access bypass), and
// ADR-0035: what the stack declares so that the two public sign-in paths reach the Worker without an Access login. It
// sits beside the Worker's own owner-only application (`deployment()`) and the MCP endpoint's (`mcp-access.ts`).
// @effect-diagnostics missingPipeableSignature:off -- plain functions of the stack's props.

import * as Effect from "effect/Effect";
import { appHost } from "./mcp-access.ts";
import { CALLBACK_PATH, CLIENT_DOCUMENT_PATH } from "./mcp/sign-in-origin.ts";

/**
 * The Bypass application's props: `self_hosted` with exactly two `public` destinations, `<host>/oauth/mcp/client.json`
 * and `<host>/oauth/mcp/callback` (plain strings from the stage's app origin, so no Worker output is needed), and one
 * Bypass/Everyone policy. A path-scoped application beats the Worker's own. Access applies it to more than the two
 * paths (sub-paths, any capitalisation: #403), so the Worker refuses every other form itself (`sign-in-routes.ts`).
 *
 * Cloudflare refuses a second application with the same destinations (409, `application_already_exists`), which a
 * leftover of a failed destroy would be, and it echoes the first destination as the application's `domain` (the check of
 * #422 D6.2, on a preview). So the props set `domain` to that first destination, the same string, and `adopt`: alchemy
 * finds the leftover by its `domain` and takes it over, instead of the deploy failing with a 409.
 */
export const bypassApplicationProps = (stage: string) => {
  const documentUri = `${appHost(stage)}${CLIENT_DOCUMENT_PATH}`;

  return {
    type: "self_hosted",
    domain: documentUri,
    adopt: true,
    destinations: [
      { type: "public", uri: documentUri },
      { type: "public", uri: `${appHost(stage)}${CALLBACK_PATH}` },
    ],
    policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
  } as const;
};

/**
 * The stack's part for the bypass: on a live stage, the Bypass application (`options.declare`, which gets the props
 * above). `alchemy dev` has no Access, so it declares nothing, and nor does the bundle itself (`runtime`). This is the
 * same test alchemy applies to the Worker's own Access application, and the one the stage's `MCP_CLIENT_DOCUMENT`
 * flag follows. It is declared whatever that flag says: the public callback serves DCR too.
 */
export const bypassAccessProps = <Application, Error, Services>(options: {
  readonly stage: string;
  readonly runtime: boolean;
  /** Whether the stack is planned by `alchemy dev` (`AlchemyContext.dev`), which the caller reads once. */
  readonly dev: boolean;
  readonly declare: (
    props: ReturnType<typeof bypassApplicationProps>,
  ) => Effect.Effect<Application, Error, Services>;
}) =>
  Effect.gen(function* () {
    if (options.runtime) return;

    if (options.dev) return;

    yield* options.declare(bypassApplicationProps(options.stage));
  });
