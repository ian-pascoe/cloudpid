// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The dispatcher and `describe().harness`: the `api`
// target's one operation for the management tools. It runs the tool's shared core (`@cloudpid/extensions`) over the
// services of `./services.ts` with `surface: "endpoint"` and answers `{text, structured}`, which `McpServer` only wraps.
// It decodes the input again with the shared schema (the SDK validated it, but `McpServer` is a deploy apart), answers
// `unsupported` for a tool it does not serve, maps the cores' codes, and answers anything else `unavailable` with a fixed
// sentence, so no service's message reaches a caller that was not meant to read it.
// @effect-diagnostics missingPipeableSignature:off preferTypedSchemaDecoder:off -- the input is the caller's JSON, read again.
import { environmentGetRead, environmentListRead } from "@cloudpid/extensions/environment-reads";
import type { HarnessRead } from "@cloudpid/extensions/harness";
import { settingsGetRead } from "@cloudpid/extensions/settings-reads";
import { settingsMcpGetRead, settingsMcpListRead } from "@cloudpid/extensions/settings-mcp-reads";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  type HarnessAnswer,
  type HarnessRequest,
} from "@cloudpid/protocol/mcp-api";
import { HARNESS_TOOLS, type HarnessToolName } from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HarnessServices } from "./services.ts";

/** What a core's refusal carries that the dispatcher reads: the message the model sees, and the code that maps. */
type CoreError = { readonly message: string; readonly code?: "not_found" | "invalid_argument" };

/** The answer of a failure no code names: fixed, so a service's own message (a Registry's, a host's) is never relayed. */
const unavailable = apiFailure(
  "unavailable",
  "cloudpid could not read that just now: try again shortly.",
);

/** A tool as the dispatcher serves it: its input read again, and its core run on the endpoint's surface. */
type Served = (input: HarnessRequest["input"]) => Effect.Effect<ApiResult<HarnessAnswer>>;

/** What a tool's endpoint input decodes to. */
type InputOf<Name extends HarnessToolName> =
  (typeof HARNESS_TOOLS)[Name]["endpoint"]["input"]["Type"];

/** `read` as `tool`'s served form: the input read again with the tool's endpoint schema, then the core on the endpoint's surface. */
const serve = <Name extends HarnessToolName, E extends CoreError>(
  tool: Name,
  read: HarnessRead<InputOf<Name>, E>,
): Served => {
  const decode = Schema.decodeUnknownResult(HARNESS_TOOLS[tool].endpoint.input);

  return (given) => {
    const decoded = decode(given);

    if (Result.isFailure(decoded)) {
      return Effect.succeed(
        apiFailure("invalid_argument", `${tool}: ${decoded.failure.message}`.slice(0, 500)),
      );
    }

    return read(decoded.success, "endpoint").pipe(
      // SAFETY: a core's structured value is JSON (`asOutput`); chord's `JsonValue` and `Schema.Json` describe the same values.
      Effect.map(({ text, structured }) => apiOk({ text, structured: structured as Schema.Json })),
      Effect.catch((error: E) =>
        Effect.succeed(
          Predicate.isUndefined(error.code) ? unavailable : apiFailure(error.code, error.message),
        ),
      ),
    );
  };
};

/**
 * The dispatcher over `services`: `harness({tool, input, via})`. A defect of a service (a Registry call that threw) is
 * `unavailable`, which may heal.
 */
export const harnessDispatch = (services: HarnessServices) => {
  // The tools `harness` serves: the same names as `HARNESS_TOOLS_SERVED` (`../mcp/api.ts`), which `dispatch.test.ts` checks.
  const table: Record<HarnessToolName, Served> = {
    environment_list: serve("environment_list", environmentListRead(services.environments)),
    environment_get: serve("environment_get", environmentGetRead(services.environments)),
    settings_get: serve("settings_get", settingsGetRead(services.settings)),
    settings_mcp_list: serve("settings_mcp_list", settingsMcpListRead(services.settingsMcp)),
    settings_mcp_get: serve("settings_mcp_get", settingsMcpGetRead(services.settingsMcp)),
  };

  // Looked up by a name the caller sent: only the table's own keys are tools.
  const served: Readonly<Record<string, Served>> = table;

  return (request: HarnessRequest): Effect.Effect<ApiResult<HarnessAnswer>> => {
    const run = Record.get(served, request.tool);

    if (Option.isNone(run)) {
      return Effect.succeed(
        apiFailure("unsupported", `The server does not serve ${request.tool}: it is not offered.`),
      );
    }

    return Effect.suspend(() => run.value(request.input)).pipe(
      Effect.catchCause(() => Effect.succeed(unavailable)),
    );
  };
};
