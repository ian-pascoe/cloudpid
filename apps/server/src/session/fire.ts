// A Trigger's Fire reaching its Session (`docs/architecture/triggers.md` → Pending Fires; → Payload and untrusted
// content): the Trigger message under cloudpid's header, marked as the Trigger's (`via`), deduplicated by the Fire's key
// (its `requestId`), so a retried alarm never sends twice, with the Trigger's model and thinking level picked at its
// first Fire only. It goes in through the endpoint's send (`deliver`, `mcp.ts`), and `host.submit` records it in
// `notify-submissions`, so the end of its Run is pushed to the owner (→ Fire records, origin marks and notifications). A
// webhook's body is not in the message but in a block after it (`host.ts`: `firePayload`), never as the owner's words.
import { isModelId } from "@cloudpid/config";
import {
  type ApiResult,
  apiFailure,
  cleanPayload,
  type ConfigureRequest,
  type FireRequest,
  fireText,
  type SubmitResult,
  triggerMessageProblem,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import type { SessionError } from "./errors.ts";
import type { Prompt } from "./host.ts";
import type { Deliver } from "./mcp.ts";

/** The Session's `fire`, over its send (`deliver`) and its pick of a model and thinking level (`configure`). */
export const sessionFire =
  ({
    deliver,
    configure,
    redact,
  }: {
    readonly deliver: Deliver;
    readonly configure: (pick: ConfigureRequest) => Effect.Effect<void, SessionError>;
    /** The Session's redactor of the Secrets it holds, refreshed: what goes inline of a delivery's body passes it. */
    readonly redact: Effect.Effect<(text: string) => string, SessionError>;
  }) =>
  (request: FireRequest): Effect.Effect<ApiResult<SubmitResult>> => {
    const problem = triggerMessageProblem(request.message);

    if (problem !== undefined) return Effect.succeed(apiFailure("invalid_argument", problem));

    // A model this version doesn't offer is left to the Environment's Settings.
    const pick: Types.Mutable<ConfigureRequest> = {};

    if (request.model !== undefined && isModelId(request.model)) pick.model = request.model;

    if (request.thinking !== undefined) pick.thinkingLevel = request.thinking;

    // The sender's own words are made plain here, once: the header, the block, the chip and the file's name say them as
    // they are after this.
    const payload = request.payload === undefined ? undefined : cleanPayload(request.payload);

    const prompt: Types.Mutable<Prompt> = {
      input: fireText(request.header, request.message, payload),
      via: { auth: "trigger", trigger: request.trigger },
      requestId: request.requestId,
    };

    // A webhook's body goes after the message, fenced as untrusted, with the whole body in a file (`host.ts`).
    if (payload !== undefined) {
      prompt.delivery = { payload, fireKey: request.requestId, redact };
    }

    return deliver({
      requestId: request.requestId,
      prompt,
      // The Trigger's pick, at its first Fire only: a repeat finds the Session as it was left.
      first:
        pick.model === undefined && pick.thinkingLevel === undefined ? undefined : configure(pick),
    });
  };
