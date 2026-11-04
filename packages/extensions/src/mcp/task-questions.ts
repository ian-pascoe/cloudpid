// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off -- plain Promise code over pi-durable's commits and the Session's question service.
// The questions an MCP task asks the owner while it goes on (`docs/architecture/mcp-server-requests.md` → MCP tasks,
// Questions in a task; ADR-0042): a Modern task whose status is `input_required` lists them in its `tasks/get` snapshot
// (`inputRequests`, by key). Each poll that finds one it has not seen takes it through the same hooks a call's questions
// take (`./elicit.ts`, `./sample.ts`), kept for the owner (`defer`) under the task's own key (`taskOwner`) rather than a
// call's id, so a card shows in the task's conversation with no call waiting, and survives every restart. The answers go
// to the server in `tasks/update`, sent by whoever finds the round answered: the owner's answer itself (`sendReady`, the
// Session's `onTaskAnswered`), or the next poll when that send did not take.
//
// - **A round** is the keys a poll found that were not asked: forms and pages the owner answers, Sampling requests the
//   owner allows or refuses, and what cloudpid answers at once (a credential form declined unseen, a request past a cap,
//   Roots, a Sampling request the definition `allow`s, run now and kept as its reply). They are sent together, as a call's
//   Modern round is: partial answers are never sent. A Sampling request is run when the round is sent, on what the owner
//   decided, so its reply is not kept for longer than that.
// - **A key whose answer was sent is never asked again**, whether the server shows it a little longer or asks it anew.
// - **A refused Sampling request ends the task:** the server has no way to be told a refusal, so cloudpid sends
//   `tasks/cancel` (`requestCancel`, by cloudpid) and the task ends `cancelled` with `sampling_refused`.
// - **Caps:** the call's caps hold per task (10 forms and pages, 20 samples), counted in the question service under the
//   task's key and kept in the record, so a restart counts on from them.
import {
  isJsonObject,
  type JsonObject,
  type McpInputAnswer,
  type McpInputRequest,
  type McpTaskInputResponses,
  type McpTaskSnapshot,
} from "@cloudpid/mcp/types";
import { declaresSampling, samplingOf } from "@cloudpid/config";
import type { Context } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import { elicitingHooks, type Eliciting, mutableContent } from "./elicit.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { type McpDeferredSample, McpRoundState, type McpQuestionsService } from "./questions.ts";
import { taskOwner } from "./question-records.ts";
import { sampled, UNAVAILABLE } from "./rounds.ts";
import { samplingHooks, type Sampling, wordsOf } from "./sample.ts";
import type { McpSamplingService } from "./sampling.ts";
import { type OwnerWrite, requestCancel } from "./task-owner.ts";
import { taskUpdate } from "./task-poll.ts";
import { taskContext } from "./task-port.ts";
import {
  MCP_TASK_QUESTION_KEYS,
  McpTasksDoc,
  type McpTaskQuestions,
  type McpTaskRecord,
  type McpTasksState,
} from "./task-state.ts";
import type { McpBuildServer } from "./tools.ts";

/** How many times one update is sent: once, and once more if that did not take; then the task is ended. */
export const MCP_TASK_UPDATE_SENDS = 2;

/** How long a key whose answer was sent may stay asked before the task's status says the server is slow to take it. */
export const MCP_TASK_ANSWER_SLOW_MS = 10 * 60 * 1000;

/** What a task's questions are asked and answered with: the Session's question and Sampling services, over its servers. */
export type TaskAsking = {
  readonly questions: McpQuestionsService;
  readonly sampling?: McpSamplingService | undefined;
  /** Whether the host lists `sampling`: only then did a call offer to answer Sampling requests. */
  readonly samples: boolean;
  /** The servers as the tools were last built, for each one's definition (`sampling`) and source. */
  readonly servers: ReadonlyArray<McpBuildServer>;
};

/** Where a task's record is read and written: the follower's runtime, the inline call's API, or the Session's Harness. */
export type TaskStore = {
  readonly read: (handle: string) => Promise<McpTaskRecord | undefined>;
  /** One commit of the Session's document. */
  readonly commit: (write: OwnerWrite) => Promise<void>;
};

/**
 * The store over what holds the tasks document: the follower's runtime, an inline call's API, or the Session's Harness, with
 * the `context` its commits run in.
 */
export const taskStoreOf = <Done>(
  host: {
    readonly snapshot: (
      token: typeof McpTasksDoc,
      context: Context,
    ) => Promise<Readonly<McpTasksState> | undefined | null>;
    readonly commit: (write: OwnerWrite, context: Context) => Promise<Done>;
  },
  context: Context,
): TaskStore => ({
  read: async (handle) => (await host.snapshot(McpTasksDoc, context))?.tasks[handle],
  commit: async (write) => {
    await host.commit(async (tx) => {
      await write(tx);
    }, context);
  },
});

/** Apply `apply` to the tasks document in one commit of `store`. */
const change = (store: TaskStore, apply: (doc: McpTasksState) => void): Promise<void> =>
  store.commit(async (tx) => {
    apply(await tx.doc(McpTasksDoc));
  });

/** What asking and answering a task's questions need. */
export type TaskQuestionDeps = {
  readonly asking: TaskAsking;
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  readonly store: TaskStore;
  readonly now: () => number;
  /** How long a key whose answer was sent may stay asked before the status says so, instead of `MCP_TASK_ANSWER_SLOW_MS`. */
  readonly slowMs?: number | undefined;
  /** Aborts when the caller is stopped. */
  readonly signal?: AbortSignal | undefined;
};

/** What a task does not stop for: its questions run on no call's clock. */
const NO_HOLD = { pause: Effect.void, resume: Effect.void };

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

/** The hooks of a task's server for its questions, or undefined when the server is not in the tools' build. */
const hooksFor = (
  asking: TaskAsking,
  record: McpTaskRecord,
  signal: AbortSignal | undefined,
): { readonly eliciting: Eliciting; readonly sampling: Sampling | undefined } | undefined => {
  const server = asking.servers.find((each) => each.name === record.server);

  if (server === undefined) return undefined;

  const owner = taskOwner(record.handle);

  const eliciting = elicitingHooks({
    questions: asking.questions,
    server: record.server,
    tool: record.modelTool,
    task: record.handle,
    callId: owner,
    conversationId: record.conversation,
    signal,
    source: server.source,
    defers: true,
    hold: NO_HOLD,
  });

  const sampling =
    asking.sampling !== undefined && asking.samples && declaresSampling(server.server)
      ? samplingHooks({
          sampling: asking.sampling,
          server: record.server,
          tool: record.modelTool,
          task: record.handle,
          callId: owner,
          conversationId: record.conversation,
          signal,
          decision: samplingOf(server.server) === "allow" ? "allow" : "ask",
          defers: true,
          source: server.source,
          hold: NO_HOLD,
        })
      : undefined;

  return { eliciting, sampling };
};

/** Tasks whose counts this instance has restored from the record, by question service. */
const restored = new WeakMap<McpQuestionsService, Set<string>>();

/** `owner` counts on from what the record says the task had asked, once per instance. */
const restoreCounts = (questions: McpQuestionsService, record: McpTaskRecord): void => {
  const seen = restored.get(questions) ?? new Set<string>();

  restored.set(questions, seen);

  if (seen.has(record.handle)) return;

  seen.add(record.handle);

  if (record.questions !== undefined) {
    questions.restoreCounts(taskOwner(record.handle), {
      count: record.questions.count,
      sampled: record.questions.sampled,
    });
  }
};

/** The handles whose answers this instance is sending: one send at a time per task. */
const sending = new WeakMap<McpHostClientService, Set<string>>();

/** The record's questions, made if it had none. */
const questionsOf = (record: McpTaskRecord): McpTaskQuestions => {
  const empty = (): McpTaskQuestions => ({ round: 0, count: 0, sampled: 0, keys: {} });

  record.questions ??= empty();

  // Read back, not the value just assigned: the document tracks changes made through what it holds.
  return record.questions ?? empty();
};

/** Keep the newest `MCP_TASK_QUESTION_KEYS` keys. */
const pruned = (questions: McpTaskQuestions): void => {
  const keys = Record.toEntries(questions.keys);

  if (keys.length <= MCP_TASK_QUESTION_KEYS) return;

  keys.sort(([, a], [, b]) => a.at - b.at);

  for (const [key] of keys.slice(0, keys.length - MCP_TASK_QUESTION_KEYS)) {
    delete questions.keys[key];
  }
};

/** The answers a round kept for what cloudpid answered at once: JSON objects by key. */
const answeredOf = (kept: Schema.Json): Mutable<McpTaskInputResponses> => {
  const answers: Mutable<McpTaskInputResponses> = {};

  if (!isJsonObject(kept)) return answers;

  for (const [key, value] of Record.toEntries(kept)) {
    if (isJsonObject(value)) answers[key] = value;
  }

  return answers;
};

/** The words a refused Sampling request ends its task with. */
const refusalReason = (server: string, words: string): string =>
  `${server} asked for a model reply, which was ${words}. A task cannot be told a refusal, so cloudpid cancelled it`;

/** End the task: `tasks/cancel`, which its next poll reads as `cancelled` by cloudpid, with `reason`. */
const cancelTask = async (
  deps: TaskQuestionDeps,
  record: McpTaskRecord,
  reason: string,
  error?: "sampling_refused",
): Promise<void> => {
  const { store, client, origin, now, asking } = deps;

  await run(asking.questions.settleCall(taskOwner(record.handle)));

  await requestCancel(
    { commit: store.commit, client, origin, now },
    record,
    "cloudpid",
    error === undefined ? { reason } : { reason, error },
  );
};

/** Whether every answer the round kept under `owner` was sent: its questions' and what cloudpid answered at once. */
const roundSent = async (
  asking: TaskAsking,
  owner: string,
  sent: (key: string) => boolean,
): Promise<boolean> => {
  const answers = await run(asking.questions.takeAnswers(owner));

  if (answers === undefined) return false;

  const round = await run(asking.questions.deferredRound(owner));

  const own =
    round !== undefined && Predicate.isTagged(round.state, "Task")
      ? Record.keys(answeredOf(round.state.answered))
      : [];

  return Arr.every([...Arr.map(answers, (each) => each.key), ...own], sent);
};

/**
 * The keys whose answers are being sent (`sending`) and which the server no longer lists: when it lists a question the
 * record does not know, it has gone on, so it took them, though the answer to its request was lost. They are marked `sent`,
 * dropped from what is kept to be resent, and the round that held them is ended once all of it was sent. A server that
 * merely lists less than before (a poll that omits a key, then lists it again) is no evidence: its keys stay `sending`, with
 * their round and what is kept, to be sent again when it lists them. Returns the record as it stands.
 */
const settleUnlisted = async (
  deps: TaskQuestionDeps,
  record: McpTaskRecord,
  listed: ReadonlySet<string>,
): Promise<McpTaskRecord> => {
  const asked = record.questions?.keys ?? {};
  const moved = Arr.some([...listed], (key) => asked[key] === undefined);

  if (!moved) return record;

  const inFlight = Arr.filter(Record.keys(asked), (key) => asked[key]?.state === "sending");
  const taken = Arr.filter(inFlight, (key) => !listed.has(key));

  if (taken.length === 0) return record;

  await change(deps.store, (doc) => {
    const task = doc.tasks[record.handle];

    if (task?.questions === undefined) return;

    const held = task.questions;

    for (const key of taken) {
      const was = held.keys[key];

      if (was !== undefined) held.keys[key] = { state: "sent", at: was.at };

      if (held.pending !== undefined) delete held.pending[key];
    }

    if (held.pending !== undefined && Record.size(held.pending) === 0) delete held.pending;

    // Nothing is left being sent: the update that was lost is not to be counted against the next.
    if (Arr.every(Record.values(held.keys), (each) => each.state !== "sending")) delete held.tries;
  });

  const current = (await deps.store.read(record.handle)) ?? record;
  const sent = (key: string) => current.questions?.keys[key]?.state === "sent";

  if (await roundSent(deps.asking, taskOwner(record.handle), sent)) {
    await run(deps.asking.questions.endRound(taskOwner(record.handle)));
  }

  return current;
};

/** What one pass over a task's snapshot did. */
export type Asked = "none" | "waiting" | "sent" | "ended";

/** What a pass over a task's snapshot did, from what sending its answers did. */
const outcomeOf = (sent: "waiting" | "sent" | "failed" | "ended"): Asked =>
  sent === "sent" || sent === "ended" ? sent : "waiting";

/**
 * The questions the snapshot of the task `record` lists that were not asked: each goes to the hooks a call's questions
 * take. What the owner is to answer is stored as a round and shown; what cloudpid answers at once is kept with it, or, when
 * nothing is left for the owner, sent now. A task with a round waiting is not asked more until it is answered and sent.
 */
export const observeQuestions = async (
  deps: TaskQuestionDeps,
  seen: McpTaskRecord,
  snapshot: McpTaskSnapshot,
): Promise<Asked> => {
  const { asking, store } = deps;
  const { questions } = asking;
  const owner = taskOwner(seen.handle);

  if (seen.end !== undefined || snapshot.status !== "input_required") return "none";

  restoreCounts(questions, seen);

  // An answer being sent whose key the server no longer lists was taken (the request got there, and its answer did not).
  const listed = new Set(Record.keys(snapshot.inputRequests));
  const record = await settleUnlisted(deps, seen, listed);

  const asked = record.questions?.keys ?? {};
  const inFlight = Arr.filter(Record.keys(asked), (key) => asked[key]?.state === "sending");

  // The server lists none of what is being sent: there is nothing to send again now, and it may list them again.
  if (inFlight.length > 0 && Arr.every(inFlight, (key) => !listed.has(key))) {
    await noteSlow(deps, record, Record.keys(snapshot.inputRequests), false);

    return "waiting";
  }

  // A round that waits for the owner, or that is answered and not sent yet (a send that did not take, or a restart).
  if ((await run(questions.deferredRound(owner))) !== undefined) {
    return outcomeOf(await sendReady(deps, record, listed));
  }

  // What cloudpid answered itself and was sending with no round stored: the keys the server lists are sent again, the once.
  const pending = record.questions?.pending;

  if (pending !== undefined && Record.size(pending) > 0) {
    const again = Record.filter(pending, (_, key) => listed.has(key));

    return outcomeOf(await send(deps, record, again, { ours: true, settles: true }));
  }

  const known = asked;

  const fresh = Arr.filter(
    Record.toEntries(snapshot.inputRequests),
    ([key]) => known[key] === undefined,
  );

  await noteSlow(deps, record, Record.keys(snapshot.inputRequests), fresh.length > 0);

  if (fresh.length === 0) return "none";

  const hooks = hooksFor(asking, record, deps.signal);

  if (hooks === undefined) return "none";

  const answered: Mutable<McpTaskInputResponses> = {};
  let kept = 0;

  const stop = async (reason: string, error?: "sampling_refused"): Promise<Asked> => {
    await hooks.sampling?.settle();
    await cancelTask(deps, record, reason, error);

    return "ended";
  };

  for (const [key, entry] of fresh) {
    const method = entry["method"];
    const params: JsonObject = isJsonObject(entry["params"]) ? entry["params"] : {};

    if (method === "roots/list") {
      // A task's server has no roots to be given: cloudpid never offers them to a remote server.
      answered[key] = { roots: [] };

      continue;
    }

    let answer: typeof McpInputAnswer.Encoded;

    if (method === "elicitation/create") {
      const input: typeof McpInputRequest.Encoded = {
        key,
        kind: "elicitation",
        params,
        mode: "deferrable",
        era: "modern",
      };

      answer = await hooks.eliciting.onInput(input);
    } else if (method === "sampling/createMessage" && hooks.sampling !== undefined) {
      const input: typeof McpInputRequest.Encoded = {
        key,
        kind: "sampling",
        params,
        mode: "deferrable",
        era: "modern",
      };

      answer = await hooks.sampling.onInput(input);
    } else {
      return stop(
        `${record.server} asked for ${Predicate.isString(method) ? method : "something"}, which cloudpid did not offer on this task`,
      );
    }

    if (answer.kind === "defer") kept += 1;
    else if (answer.kind === "answered" || answer.kind === "sampled") {
      answered[key] = { ...answer.result };
    } else {
      // Only a Sampling request is refused: a form cloudpid cannot take is a `cancel`. The server has no refusal to be told.
      const detail = hooks.sampling?.sunk();

      return stop(
        refusalReason(record.server, detail === undefined ? answer.message : wordsOf(detail)),
        "sampling_refused",
      );
    }
  }

  const counts = questions.counts(owner);

  // Nothing is left for the owner: what cloudpid answered goes now, as one request.
  if (kept === 0) {
    await change(store, (doc) => {
      const own = doc.tasks[record.handle];

      if (own === undefined) return;

      const held = questionsOf(own);

      held.count = counts.count;
      held.sampled = counts.sampled;
    });

    return outcomeOf(await send(deps, record, answered, { ours: true, settles: true }));
  }

  const round = (record.questions?.round ?? 0) + 1;

  const stored = await run(
    questions
      .commitRound({
        callId: owner,
        round,
        conn: record.conn,
        tool: record.tool,
        state: McpRoundState.Task({ answered }),
        asked: [],
      })
      .pipe(Effect.result),
  );

  const shown = Result.isSuccess(stored)
    ? await run(questions.showRound(owner).pipe(Effect.result))
    : stored;

  // The storage cannot take the questions (a replaced Session): none can be answered, so the task is cancelled, not left
  // waiting for an answer nobody can give.
  if (Result.isFailure(shown)) {
    return stop("cloudpid could not record the question");
  }

  await change(store, (doc) => {
    const own = doc.tasks[record.handle];

    if (own === undefined) return;

    const held = questionsOf(own);

    held.round = round;
    held.count = counts.count;
    held.sampled = counts.sampled;
  });

  return "waiting";
};

/**
 * The status of a task whose answers were sent and which still waits: after `MCP_TASK_ANSWER_SLOW_MS` it reads "waiting
 * for <server> to take your answer" (`McpTaskQuestions.stuck`). It stops reading so once the server no longer lists a key
 * that was sent, or asks a new one (`fresh`), as well as when the task works again (`applyDecision`).
 */
const noteSlow = async (
  deps: TaskQuestionDeps,
  record: McpTaskRecord,
  listed: ReadonlyArray<string>,
  fresh: boolean,
): Promise<void> => {
  const held = record.questions;

  if (held === undefined) return;

  const at = Arr.filterMap(listed, (key) => {
    const asked = held.keys[key];

    return asked?.state === "sent" ? Result.succeed(asked.at) : Result.failVoid;
  });

  const stuck =
    !fresh &&
    at.length > 0 &&
    deps.now() - Math.min(...at) >= (deps.slowMs ?? MCP_TASK_ANSWER_SLOW_MS);

  if (stuck === (held.stuck === true)) return;

  await change(deps.store, (doc) => {
    const own = doc.tasks[record.handle];

    if (own?.end !== undefined || own?.questions === undefined) return;

    if (stuck) own.questions.stuck = true;
    else delete own.questions.stuck;
  });
};

/**
 * Send what the owner has answered of the round kept for the task `record`: the pages they opened at once (Open answers a
 * page `accept` without waiting for the form beside it), and, once every question of the round has an answer, the rest in
 * one update. `waiting`: some wait for the owner; `sent`: the server took them, the round is settled and its keys will not
 * be asked again; `failed`: the send did not take (the round stays, and the next poll sends it again, the once);
 * `ended`: a Sampling request was refused, or an update was lost twice, and the task is being cancelled. A poll gives
 * the keys `listed` by the server: an answer that is being sent and that it does not list is held back (it may list it
 * again), and the round stays until it was sent.
 */
export const sendReady = async (
  deps: TaskQuestionDeps,
  record: McpTaskRecord,
  listed?: ReadonlySet<string>,
): Promise<"waiting" | "sent" | "failed" | "ended"> => {
  const { asking, client } = deps;
  const { questions } = asking;
  const owner = taskOwner(record.handle);
  const busy = sending.get(client) ?? new Set<string>();

  sending.set(client, busy);

  // One send at a time: the owner's answer and a poll may both find the round complete.
  if (busy.has(record.handle)) return "waiting";

  busy.add(record.handle);

  try {
    // The record as it stands: a send of the owner's answer is not the poll's, and the record the poll read is older.
    const held = (await deps.store.read(record.handle)) ?? record;
    // The keys sent alone just now are not in the record `held` was read from.
    const alone = new Set<string>();
    const sent = (key: string) => held.questions?.keys[key]?.state === "sent" || alone.has(key);

    const holds = (key: string) =>
      listed !== undefined && held.questions?.keys[key]?.state === "sending" && !listed.has(key);

    const opened = Arr.filter(
      await run(questions.takePages(owner)),
      (key) => !sent(key) && !holds(key),
    );

    if (opened.length > 0) {
      // A page's own update: the round goes on, since what is left of it was not sent.
      const taken = await send(
        deps,
        held,
        Record.fromEntries(Arr.map(opened, (key) => [key, { action: "accept" }] as const)),
        { ours: false, settles: false },
      );

      if (taken !== "sent") return taken;

      for (const key of opened) alone.add(key);
    }

    const answers = await run(questions.takeAnswers(owner));

    if (answers === undefined) return "waiting";

    const round = await run(questions.deferredRound(owner));
    const hooks = hooksFor(asking, held, deps.signal);

    const given: Mutable<McpTaskInputResponses> =
      round !== undefined && Predicate.isTagged(round.state, "Task")
        ? answeredOf(round.state.answered)
        : {};

    const samples: Array<McpDeferredSample> = [];
    let heldBack = 0;

    for (const each of answers) {
      if (each.kind === "sample") {
        // A request whose reply was sent already is not run again, nor one the server does not list now.
        if (holds(each.key)) heldBack += 1;
        else if (!sent(each.key)) samples.push(each);

        continue;
      }

      const { key, outcome, page } = each;

      // A page's `accept` has no content: the owner entered nothing the server could read.
      given[key] =
        outcome.action === "accept" && page === undefined
          ? { action: "accept", content: mutableContent(outcome.content) }
          : { action: outcome.action };
    }

    // What the server was told already (a page, sent alone) is not its again: the keys sent are never asked again.
    // What it does not list now stays being sent, and the round with it.
    for (const key of Record.keys(given)) {
      if (sent(key)) delete given[key];
      else if (holds(key)) {
        delete given[key];
        heldBack += 1;
      }
    }

    // The round's Sampling requests run now, on what the owner decided; a refusal ends the task.
    if (samples.length > 0) {
      const ran = await sampled(samples, hooks?.sampling, held.server, UNAVAILABLE);

      if (ran.kind === "sunk") {
        await run(questions.endRound(owner));
        await hooks?.sampling?.settle();
        await cancelTask(
          deps,
          held,
          refusalReason(held.server, wordsOf(ran.detail)),
          "sampling_refused",
        );

        return "ended";
      }

      Object.assign(given, ran.replies);
    }

    // Nothing to send now, with answers held back: the round stays for when the server lists them.
    if (Record.size(given) === 0 && heldBack > 0) return "waiting";

    return await send(deps, held, given, { ours: false, settles: heldBack === 0 });
  } finally {
    busy.delete(record.handle);
  }
};

/**
 * `tasks/update` with `responses`, marking their keys, and ending the round once the server took them when `settles`: a
 * page sent alone does not, the update that carries the rest of the round does, always. `ours`: they are all cloudpid's
 * (kept in the record, with no round, so a send that is lost is sent again); the owner's answers stay in their sealed
 * round instead. An update is sent `MCP_TASK_UPDATE_SENDS` times at most: one that was lost that often ends the
 * task, which the server would otherwise keep waiting on an answer it was never given.
 */
const send = async (
  deps: TaskQuestionDeps,
  record: McpTaskRecord,
  responses: McpTaskInputResponses,
  { ours, settles }: { readonly ours: boolean; readonly settles: boolean },
): Promise<"sent" | "failed" | "ended"> => {
  const { asking, client, origin, store, now } = deps;
  const keys = Record.keys(responses);

  if (keys.length === 0) {
    if (settles) await run(asking.questions.endRound(taskOwner(record.handle)));

    return "sent";
  }

  let lost = false;

  // SAFETY: a clone of JSON data is JSON data with mutable containers, which the document holds.
  const kept = structuredClone(responses) as NonNullable<McpTaskQuestions["pending"]>;

  await change(store, (doc) => {
    const task = doc.tasks[record.handle];

    if (task === undefined) return;

    const held = questionsOf(task);

    if ((held.tries ?? 0) >= MCP_TASK_UPDATE_SENDS) {
      lost = true;

      return;
    }

    held.tries = (held.tries ?? 0) + 1;

    for (const key of keys) held.keys[key] = { state: "sending", at: now() };

    if (ours) held.pending = { ...held.pending, ...kept };

    pruned(held);
  });

  if (lost) {
    await run(asking.questions.endRound(taskOwner(record.handle)));
    await cancelTask(
      deps,
      record,
      `cloudpid could not send your answer to ${record.server}: the update was lost twice`,
    );

    return "ended";
  }

  const answer = await run(
    client.request(taskUpdate(record, taskContext(origin, record), responses), {}),
  );

  if (!Predicate.isTagged(answer, "TaskAck")) return "failed";

  await change(store, (doc) => {
    const task = doc.tasks[record.handle];

    if (task === undefined) return;

    const held = questionsOf(task);

    for (const key of keys) held.keys[key] = { state: "sent", at: now() };

    // What was held back, because the server did not list it, is still to be sent: only what was sent is dropped.
    if (held.pending !== undefined) for (const key of keys) delete held.pending[key];

    if (held.pending !== undefined && Record.size(held.pending) === 0) delete held.pending;

    // One attempt of what is still being sent is spent: it is sent again once, not more.
    if (Arr.some(Record.values(held.keys), (each) => each.state === "sending")) held.tries = 1;
    else delete held.tries;
  });

  // The round goes with the update that carries the rest of it; a page sent alone leaves the rest waiting.
  if (settles) await run(asking.questions.endRound(taskOwner(record.handle)));

  return "sent";
};

/**
 * The task ended or was left: its waiting questions are withdrawn ("the server's call ended"), its counts and pages
 * forgotten. Best effort; never fails.
 */
export const closeQuestions = async (
  asking: TaskAsking | undefined,
  handle: string,
): Promise<void> => {
  if (asking === undefined) return;

  const owner = taskOwner(handle);

  try {
    await run(asking.questions.settleCall(owner));
    await run(asking.sampling?.settleCall(owner) ?? Effect.void);
  } catch {
    // The end stands without it: the storage's own bound removes what is left.
  }
};
