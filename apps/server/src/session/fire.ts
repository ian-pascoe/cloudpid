// A Trigger's Fire reaching its Session (`docs/architecture/triggers.md` → Pending Fires; → Payload and untrusted
// content; → Overlap): the Trigger message under cloudpid's header, marked as the Trigger's (`via`), deduplicated by the
// Fire's key (its `requestId`), so a retried alarm never sends twice, with the Trigger's model and thinking level picked
// at its first Fire only. It goes in through the endpoint's send (`deliver`, `mcp.ts`), and `host.submit` records it in
// `notify-submissions`, so the end of its Run is pushed to the owner (→ Fire records, origin marks and notifications).
// A webhook's body is not in the message but in a block after it (`host.ts`: `firePayload`), never as the owner's words.
// A Session trigger's Fire is `fireSession`, a method of its own: it goes to a Session with a history, where `skip`
// skips it while a Run goes on (a Run waiting for the owner too), `queue` and `steer` are `session_send`'s, and it is not
// sent while an earlier Fire of the same Trigger is still queued (coalescing); a Session the Registry no longer lists,
// or one at its spend limit, fails it at no cost.
import { isModelId } from "@cloudpid/config";
import {
  type ApiResult,
  apiFailure,
  cleanPayload,
  apiOk,
  type ConfigureRequest,
  type FireRequest,
  type FireResult,
  type FireSkipped,
  type SessionFireRequest,
  fireText,
  type SubmitResult,
  triggerMessageProblem,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type * as Types from "effect/Types";
import type { SessionError } from "./errors.ts";
import type { Prompt } from "./host.ts";
import type { Deliver } from "./mcp.ts";
import { outOfBudgetMessage } from "./spend.ts";

/** Why a Trigger message can't be sent, as the failure it answers, or undefined when it can. */
const messageFailure = (message: string): ApiResult<never> | undefined => {
  const problem = triggerMessageProblem(message);

  return problem === undefined ? undefined : apiFailure("invalid_argument", problem);
};

/** What the Session's `fire` is made of: its send, and its pick of a model and thinking level. */
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
    const refused = messageFailure(request.message);

    if (refused !== undefined) return Effect.succeed(refused);

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

/** Where the request id of each Trigger's latest Fire sent to this Session is kept, for coalescing. */
const LAST_FIRES_KEY = "trigger-last-fires";

/** How many Triggers' latest Fires are kept: the newest. */
const LAST_FIRES_KEPT = 64;

/** What the Session's `fireSession` is made of: its send, and what it asks of the host and the Registry. */
export type SessionFireOptions = {
  readonly deliver: Deliver;
  /** The input admitted for a request id on the active branch, and whether it still waits in the line. */
  readonly admitted: (
    requestId: string,
  ) => Effect.Effect<{ readonly queued: boolean } | undefined, SessionError>;
  /** Why the spend limit stops a request now (a clause), or undefined when it does not. */
  readonly overLimit: Effect.Effect<string | undefined>;
  /** Whether the Registry still lists this Session; a Registry that cannot say fails the Fire, to be tried again. */
  readonly registered: Effect.Effect<boolean, SessionError>;
  /** The object's synchronous key-value storage. */
  readonly kv: {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
  };
};

/** The Session's `fireSession`: a Session trigger's Fire, over its send and what it asks of the host and the Registry. */
export const sessionFireSession =
  ({ deliver, admitted, overLimit, registered, kv }: SessionFireOptions) =>
  (request: SessionFireRequest): Effect.Effect<ApiResult<FireResult>> => {
    const refused = messageFailure(request.message);

    if (refused !== undefined) return Effect.succeed(refused);

    const { whenBusy } = request;
    const triggerId = request.trigger.id;

    /** Remember this Fire as its Trigger's latest, before it is sent: one never admitted is never found queued. */
    const remember = Effect.sync(() => {
      const known = kv.get<Record<string, string>>(LAST_FIRES_KEY) ?? {};

      const next = Arr.takeRight(
        [
          ...Record.toEntries(Record.remove(known, triggerId)),
          [triggerId, request.requestId] as const,
        ],
        LAST_FIRES_KEPT,
      );

      kv.put(LAST_FIRES_KEY, Record.fromEntries(next));
    });

    /** Whether the Trigger's latest Fire sent here is still queued in the line. */
    const earlierQueued = Effect.gen(function* () {
      const last = (kv.get<Record<string, string>>(LAST_FIRES_KEY) ?? {})[triggerId];

      return last === undefined ? false : (yield* admitted(last))?.queued === true;
    });

    const prompt: Types.Mutable<Prompt> = {
      input: fireText(request.header, request.message),
      via: { auth: "trigger", trigger: request.trigger },
      requestId: request.requestId,
    };

    // `queue` is the default of a busy conversation.
    if (whenBusy === "steer") prompt.whenBusy = "steer";

    return deliver<FireSkipped>({
      requestId: request.requestId,
      prompt,
      // What awaits the Registry or the host comes first, before the Session is read: the owner's message could
      // otherwise start a Run in between, and a Fire that skips a Run would be sent as the start of one.
      decline: Effect.gen(function* () {
        // The Session was deleted while its Fire was on its way: sending would start a Run in an object nothing owns.
        if (!(yield* registered)) {
          return apiFailure("not_found", "This Session was deleted", { retryable: false });
        }

        const reason = yield* overLimit;

        if (reason !== undefined) {
          // The Session's Runs are all refused at no cost, so a Fire is failed here, for the owner to be told.
          return apiFailure("unavailable", outOfBudgetMessage(reason), { retryable: false });
        }

        return (yield* earlierQueued) ? apiOk<FireSkipped>({ skipped: "coalesced" }) : undefined;
      }),
      refuse: (before) =>
        whenBusy === "skip" && before.unsettled
          ? apiOk<FireSkipped>({ skipped: "overlap" })
          : undefined,
      // Remembered at the Fire's first send only: a repeat finds the Session as it was left.
      first: remember,
    });
  };
