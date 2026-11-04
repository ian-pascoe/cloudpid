// The look at the servers of the rounds of questions kept for later (`docs/architecture/mcp-server-requests.md` → The
// waiting-question record, #569). A Modern form or a Legacy `-32042` page waits for the owner with no request on the host
// (the host has no way to reach a Session that holds none), so the Session looks when it has a reason to: a client
// connecting, who sees the cards, and a request start. Never a timer, which would keep the Session's instance awake for as
// long as a round waits. A look that cannot be made (the host fails or does not answer) says nothing: the round keeps
// waiting.
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { McpHostClientService } from "./client.ts";
import { isReachable } from "./exposure.ts";
import type { McpQuestionsService } from "./questions.ts";

/** How long a look waits for the host before it gives up and the rounds keep waiting. */
export const MCP_ROUND_LOOK_TIMEOUT = Duration.seconds(5);

/**
 * Look at the servers of the rounds that wait: one that is gone, switched off or hidden has its rounds' questions
 * answered `cancel` by cloudpid ("<server> was switched off, hidden or removed"), and a round that asked on another
 * connection key than the server has now ("<server> was changed") has its own questions answered so. The calls are
 * woken, and their resume goes to the host, which refuses it as it does any resume whose `conn` differs.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const lookAtRounds = (
  client: McpHostClientService,
  questions: McpQuestionsService,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rounds = yield* questions.waitingRounds;

    if (rounds.length === 0) return;

    const names = Arr.dedupe(Arr.map(rounds, (round) => round.server));
    const answer = yield* client.servers({ names, parts: [] });

    // Unknown is not gone: a host that fails says nothing of its servers.
    if (Predicate.isTagged(answer, "HostFailed")) return;

    for (const name of names) {
      const found = Arr.findFirst(answer.servers, (each) => each.name === name);

      if (Option.isNone(found) || !isReachable(found.value)) {
        yield* questions.withdrawServer(name, `${name} was switched off, hidden or removed`);

        continue;
      }

      for (const round of Arr.filter(rounds, (each) => each.server === name)) {
        if (round.conn !== found.value.conn) {
          yield* questions.withdrawRound(round.callId, `${name} was changed`);
        }
      }
    }
  }).pipe(
    Effect.timeoutOption(MCP_ROUND_LOOK_TIMEOUT),
    Effect.asVoid,
    // A look that fails or dies is no word on the server: the rounds keep waiting.
    Effect.ignoreCause,
  );
