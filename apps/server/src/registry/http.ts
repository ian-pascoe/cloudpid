import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { REGISTRY_NAME, type Registry } from "./Registry.ts";
import { SessionTitle } from "./title.ts";

/** The Registry operations the temporary HTTP endpoint exposes. */
export type RegistryRoute = "createSession" | "listSessions" | "createWorkspace" | "listWorkspaces";

/** The Registry operation `request` asks for, if it is one. */
export const registryRoute = (
  request: HttpServerRequest.HttpServerRequest,
): RegistryRoute | undefined => {
  switch (`${request.method} ${new URL(request.url, "http://localhost").pathname}`) {
    case "POST /sessions":
      return "createSession";
    case "GET /sessions":
      return "listSessions";
    case "POST /workspaces":
      return "createWorkspace";
    case "GET /workspaces":
      return "listWorkspaces";
    default:
      return undefined;
  }
};

const CreateSessionBody = Schema.Struct({ title: Schema.optionalKey(SessionTitle) });

const CreateWorkspaceBody = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
});

/**
 * Temporary endpoint until the RPC protocol lands: create and list Sessions and Workspaces.
 *
 * - `POST /sessions` with a JSON object `{ "title"?: string }` registers a Session and answers 201 with its record,
 *   whose `id` addresses `POST /sessions/:id/prompt`.
 * - `GET /sessions` answers `{ sessions }`, newest first, each with its `status` (`idle` or `running`).
 * - `POST /workspaces` with `{ "slug": string }` records a Workspace; `GET /workspaces` answers `{ workspaces }`.
 *
 * It is reachable only through the Access gate in front of the Worker.
 */
export const serveRegistry = Effect.fn("serveRegistry")(
  function* (registries: Cloudflare.DurableObject<Registry>, route: RegistryRoute) {
    const registry = registries.getByName(REGISTRY_NAME);

    switch (route) {
      case "createSession": {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateSessionBody);

        return yield* HttpServerResponse.json(
          yield* registry.createSession({ title: body.title }),
          { status: 201 },
        );
      }

      case "listSessions":
        return yield* HttpServerResponse.json({ sessions: yield* registry.listSessions() });
      case "createWorkspace": {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateWorkspaceBody);

        return yield* HttpServerResponse.json(yield* registry.createWorkspace(body));
      }

      case "listWorkspaces":
        return yield* HttpServerResponse.json({ workspaces: yield* registry.listWorkspaces() });
    }
  },
  Effect.catchTags({
    // The body is not JSON.
    HttpServerError: (error) => HttpServerResponse.json({ error: error.message }, { status: 400 }),
    SchemaError: (error) => HttpServerResponse.json({ error: error.message }, { status: 400 }),
  }),
  Effect.catchCause((cause) =>
    Effect.logError("Registry request failed", cause).pipe(
      Effect.andThen(HttpServerResponse.json({ error: "Internal error" }, { status: 500 })),
    ),
  ),
);
