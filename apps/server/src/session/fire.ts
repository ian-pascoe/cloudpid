// A Trigger's Fire reaching its Session (`docs/architecture/triggers.md` → Pending Fires; → Payload and untrusted
// content): the Trigger message under cloudpid's header, marked as the Trigger's (`via`), deduplicated by the Fire's key
// (its `requestId`), so a retried alarm never sends twice, with the Trigger's model and thinking level picked at its
// first Fire only. It goes in through the endpoint's send (`deliver`, `mcp.ts`), and `host.submit` records it in
// `notify-submissions`, so the end of its Run is pushed to the owner (→ Fire records, origin marks and notifications).
import { isModelId } from "@cloudpid/config";
import {
  type ApiResult,
  apiFailure,
  type ConfigureRequest,
  type FireRequest,
  fireText,
  type SubmitResult,
  triggerMessageProblem,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import type { SessionError } from "./errors.ts";
import type { Deliver } from "./mcp.ts";

/** The Session's `fire`, over its send (`deliver`) and its pick of a model and thinking level (`configure`). */
export const sessionFire =
  ({
    deliver,
    configure,
  }: {
    readonly deliver: Deliver;
    readonly configure: (pick: ConfigureRequest) => Effect.Effect<void, SessionError>;
  }) =>
  (request: FireRequest): Effect.Effect<ApiResult<SubmitResult>> => {
    const problem = triggerMessageProblem(request.message);

    if (problem !== undefined) return Effect.succeed(apiFailure("invalid_argument", problem));

    // A model this version doesn't offer is left to the Environment's Settings.
    const pick: Types.Mutable<ConfigureRequest> = {};

    if (request.model !== undefined && isModelId(request.model)) pick.model = request.model;

    if (request.thinking !== undefined) pick.thinkingLevel = request.thinking;

    return deliver({
      requestId: request.requestId,
      prompt: {
        input: fireText(request.header, request.message),
        via: { auth: "trigger", trigger: request.trigger },
        requestId: request.requestId,
      },
      // The Trigger's pick, at its first Fire only: a repeat finds the Session as it was left.
      first:
        pick.model === undefined && pick.thinkingLevel === undefined ? undefined : configure(pick),
    });
  };
