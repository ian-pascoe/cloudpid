// Last run on the Session (docs/architecture/diffs-and-review.md → Run diff): the Session's Workspace keeps a copy of its repos'
// files from before the Run's first writing call and another from its end, and this object tells it when each moment
// comes and every client where the Run stands.
//
// - A Run is the work from a message to the Session going idle (`settled`): the first call of a writing tool
//   (`WRITING_TOOLS`) of the Session's own conversation, or of a subagent that works in the Session's Workspace while the
//   Session's own conversation is working, opens it, and waits for the Workspace to copy the files, but never for long
//   (`WRITE_DEADLINE_MS`): a copy that is late or failed leaves the Run "not captured" and the write goes on. A subagent
//   in a Subagent Workspace of its own writes files the Session's Workspace does not have, so its calls open nothing;
//   nor do a subagent's the owner sent a message to while the Session's own conversation is idle.
// - The open Run is kept in storage, so a tool call replayed after an eviction finds it and the idle that ends it is
//   seen by the next instance. The Run's ID names it in the Workspace, whose start is the same Run when asked twice. It
//   is closed (`closed`) the moment the Session goes idle, before its end copy is made, so a write of the next prompt
//   opens the next Run.
// - The Run's drafts (Annotations on the Last run) keep its copies in the Workspace after the next Run replaces it, until
//   they are sent or deleted (`keep`).
// - Nothing here starts the Container: a Workspace that needs it for a copy while it is stopped says "not captured".
// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalDate:off globalTimers:off missingPipeableSignature:off newPromise:off preferEffectArray:off
import type { ChangeFile, ConversationId, LastRun, RunDiff } from "@cloudpid/protocol";
import {
  conversationOf,
  conversationWorkspace,
  EMPTY_SUBAGENTS_STATE,
  SubagentsDoc,
} from "@cloudpid/extensions/subagents";
import {
  defineExtension,
  type Extension,
  LiveDoc,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AnnotationStore } from "./annotations.ts";
import { WRITING_TOOLS } from "./changes.ts";
import { SessionError } from "./errors.ts";

/** The open Run, in storage while the Session works: its ID, its conversation, and the call that opened it. */
type OpenRun = {
  readonly run: string;
  readonly conversationId: number;
  readonly firstCall: string;
  /** When the Session saw the first writing call. */
  readonly startedAt: number;
  /** The start copy was late or failed: the Run is "not captured" and nothing asks for a copy again. */
  readonly missed?: boolean;
  /** The Session went idle: the Run is being ended, and the next write opens another. */
  readonly closed?: boolean;
  /** The conversation's newest entry when it was closed, kept so that ending the Run again (after an eviction) ends it there. */
  readonly until?: number;
};

/** How long a writing call waits for the start copy, and for the end copy of the Run before it. */
export const WRITE_DEADLINE_MS = 5_000;

/** How long the end copy may take before the Session stops waiting for it (it is made in the background). */
export const END_DEADLINE_MS = 30_000;

/** Whether `work` settled within `ms`, by a real timer: workerd's clock stands still while code runs. */
const within = <A>(
  work: Promise<A>,
  ms: number,
): Promise<{ readonly settled: true; readonly value: A } | { readonly settled: false }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ settled: false });
    }, ms);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });

const OPEN_KEY = "cloudpid:last-run:open";
const LAST_KEY = "cloudpid:last-run";

/** The object's synchronous key-value storage. */
export type RunsStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** Where Run copies come from: the Session's Workspace, in the directory the Session works in. */
export type RunsSource = {
  /** Copy the repos before the Run's first write; null with no Workspace. */
  readonly start: (request: {
    readonly run: string;
    readonly conversationId: number;
    readonly firstCall: string;
    readonly startedAt: number;
    readonly keep: ReadonlyArray<string>;
  }) => Promise<LastRun | null>;
  /** Copy them again at the Run's end and keep its diff; null when `run` is not the Workspace's latest. */
  readonly end: (request: {
    readonly run: string;
    readonly until: number;
    readonly missed: boolean;
    readonly keep: ReadonlyArray<string>;
  }) => Promise<LastRun | null>;
  readonly diff: () => Promise<RunDiff | null>;
  readonly file: (query: {
    readonly repo: string;
    readonly path: string;
    readonly oldPath?: string;
  }) => Promise<ChangeFile>;
};

export type SessionRunsService = {
  /** The Last run as the Session last heard it from the Workspace; null when no Run has written. */
  readonly lastRun: Effect.Effect<LastRun | null>;
  /** The Run diff as the Workspace has it now (a live Run's list is made again); null when no Run has written. */
  readonly diff: Effect.Effect<RunDiff | null, SessionError>;
  /** One file of the Last run: its two sides. It never starts the Container. */
  readonly file: (query: {
    readonly repo: string;
    readonly path: string;
    readonly oldPath?: string;
  }) => Effect.Effect<ChangeFile, SessionError>;
  /**
   * A writing tool is about to run for `conversationId` (the Session's active branch, whose Run it is) as the model's
   * call `firstCall`: open a Run if none is open, and resolve once the Workspace has copied the files, or after
   * `WRITE_DEADLINE_MS`. It never fails: a Run that could not be copied in time is not captured, is not tried again, and
   * the write goes on. Plain, for the tools' Promise code.
   */
  readonly beforeWrite: (call: {
    readonly conversationId: ConversationId;
    readonly firstCall: string;
  }) => Promise<void>;
  /**
   * The Session went idle: close the open Run, if there is one, at once (the next write opens the next Run), and end it in
   * the background with the newest entry `newest` finds in its conversation: the Workspace copies the files, and then the
   * clients are told. Never waits for the Workspace.
   */
  readonly settled: (
    newest: (conversationId: ConversationId) => Promise<number>,
  ) => Effect.Effect<void>;
  /** Tell `observer` each Run as it ends (the Workspace's answer); the result stops it. */
  readonly observeEnded: (observer: (run: LastRun) => void) => () => void;
};

/** The Session's Last run. */
export class SessionRuns extends Context.Service<SessionRuns, SessionRunsService>()(
  "@cloudpid/server/session/runs/SessionRuns",
) {}

export type SessionRunsOptions = {
  /** Tell every client the Last run changed. */
  readonly announce: (lastRun: LastRun | null) => Effect.Effect<void>;
  /** A fresh Run ID: lower-case letters and digits, 6 to 32 of them. */
  readonly newId?: () => string;
  /** The clock a Run's start is stamped with. */
  readonly now?: () => number;
  /** How long a writing call waits for a copy (`WRITE_DEADLINE_MS`). */
  readonly writeDeadlineMs?: number;
  /** How long the end copy may take (`END_DEADLINE_MS`). */
  readonly endDeadlineMs?: number;
};

const failed =
  (operation: string) =>
  (cause: unknown): SessionError =>
    SessionError.make({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    });

/** The Session's Last run over `source` and its object's storage. */
export const sessionRunsLayer = (
  source: RunsSource,
  storage: RunsStorage,
  options: SessionRunsOptions,
): Layer.Layer<SessionRuns, never, AnnotationStore> =>
  Layer.effect(
    SessionRuns,
    Effect.gen(function* () {
      const annotations = yield* AnnotationStore;
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);
      const observers = new Set<(run: LastRun) => void>();
      /** The Run whose start the Workspace has answered, so the calls after the first ask nothing. */
      let started: { readonly run: string; readonly done: Promise<void> } | undefined;
      /** An end under way: a write that comes meanwhile waits for it, then opens the next Run. */
      let ending: Promise<void> | undefined;
      /** The Run this instance is ending now: an idle that finds it closed and under way has nothing to do. */
      let endingRun: string | undefined;

      /** The IDs of the Runs that drafts name, whose copies the Workspace keeps. */
      const keep = (): Promise<ReadonlyArray<string>> =>
        runPromise(
          Effect.map(annotations.list, (drafts) =>
            Arr.dedupe(
              Arr.flatMap(drafts, (draft) =>
                draft.source.kind === "run" ? [draft.source.run] : [],
              ),
            ),
          ),
        );

      const record = (last: LastRun | null) =>
        Effect.sync(() => {
          if (last === null) storage.delete(LAST_KEY);
          else storage.put(LAST_KEY, last);
        }).pipe(Effect.andThen(options.announce(last)));

      const newId = options.newId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 16));
      const now = options.now ?? (() => Date.now());
      const writeDeadline = options.writeDeadlineMs ?? WRITE_DEADLINE_MS;
      const endDeadline = options.endDeadlineMs ?? END_DEADLINE_MS;

      const open = (call: {
        readonly conversationId: ConversationId;
        readonly firstCall: string;
      }): OpenRun => {
        const existing = storage.get<OpenRun>(OPEN_KEY);

        if (existing !== undefined && existing.closed !== true) return existing;

        const opened: OpenRun = {
          run: newId(),
          conversationId: Number(call.conversationId),
          firstCall: call.firstCall,
          startedAt: now(),
        };

        storage.put(OPEN_KEY, opened);

        return opened;
      };

      /** The Run `run` could not be copied in time: it is "not captured", and no later write asks again. */
      const markMissed = (run: OpenRun) => {
        const current = storage.get<OpenRun>(OPEN_KEY);

        if (current?.run === run.run) storage.put(OPEN_KEY, { ...current, missed: true });
      };

      /** `last` as the Session tells it when the Run was marked missed while the copy was still being made. */
      const uncaptured = (last: LastRun): LastRun => ({
        ...last,
        repos: last.repos.map(({ repo }) => ({
          repo,
          start: null,
          end: null,
          notCaptured: "failed" as const,
        })),
      });

      /**
       * The Workspace's answer to `run`'s end, told to the clients unless a newer Run is the Last run by now (a late answer
       * must not put an older Run over it).
       */
      const finish = (run: string, last: LastRun | null): Effect.Effect<void> =>
        Effect.suspend(() => {
          const current = storage.get<LastRun>(LAST_KEY);

          if (last === null || (current !== undefined && current.run !== run)) return Effect.void;

          return record(last).pipe(
            Effect.andThen(
              Effect.sync(() => {
                for (const observer of observers) observer(last);
              }),
            ),
          );
        });

      const beforeWrite: SessionRunsService["beforeWrite"] = async (call) => {
        try {
          // The Run before this one is being ended; its copy comes first in the Workspace, but not for long.
          if (ending !== undefined)
            await within(
              ending.catch(() => undefined),
              writeDeadline,
            );

          const run = open(call);

          if (run.missed === true) return;

          if (started?.run === run.run) {
            await within(started.done, writeDeadline);

            return;
          }

          const done = (async () => {
            const last = await source.start({
              run: run.run,
              conversationId: run.conversationId,
              firstCall: run.firstCall,
              startedAt: run.startedAt,
              keep: await keep(),
            });

            const current = storage.get<OpenRun>(OPEN_KEY);

            // A Run that has been replaced since is not told; one given up on is told as not captured.
            if (last !== null && current?.run === run.run) {
              await runPromise(record(current.missed === true ? uncaptured(last) : last));
            }
          })();

          started = { run: run.run, done };

          // A start that does not answer in time, or fails, is not asked again: the Run is not captured and the write goes on.
          const waited = await within(done, writeDeadline);

          if (!waited.settled) {
            markMissed(run);
            // The copy goes on in the Workspace; its failure is only logged.
            done.catch((cause: unknown) => {
              void runPromise(Effect.logWarning("The late copy before a Run failed", cause));
            });
            await runPromise(Effect.logWarning("Copying the files before a Run took too long"));
          }
        } catch (cause) {
          // `within` rejects with the copy's failure.
          const current = storage.get<OpenRun>(OPEN_KEY);

          if (current !== undefined) markMissed(current);

          await runPromise(Effect.logWarning("Copying the files before a Run failed", cause));
        }
      };

      const settled: SessionRunsService["settled"] = (newest) =>
        Effect.sync(() => {
          const run = storage.get<OpenRun>(OPEN_KEY);

          if (run === undefined) return;

          // A second idle while this instance is ending the Run has nothing to end again (an instance that was evicted
          // meanwhile finds the Run closed and ends it, at the same entry).
          if (run.closed === true && endingRun === run.run) return;

          // Closed at once, so a write of the next prompt opens the next Run whatever the end copy is doing.
          storage.put(OPEN_KEY, { ...run, closed: true });
          started = undefined;
          endingRun = run.run;

          const end = Effect.tryPromise({
            try: async () => {
              // SAFETY: the Run's conversation ID was stored as the number pi-durable gave.
              const until =
                run.until ?? (await newest(run.conversationId as ConversationId).catch(() => 0));

              const closed = storage.get<OpenRun>(OPEN_KEY);

              if (closed?.run === run.run) storage.put(OPEN_KEY, { ...closed, until });

              const asked = source.end({
                run: run.run,
                until,
                missed: run.missed === true,
                keep: await keep(),
              });

              const ended = await within(asked, endDeadline);

              if (!ended.settled) {
                // The Workspace goes on with the end: the answer is told when it comes, if this Run is still the Last run.
                void asked.then(
                  (late) => runPromise(finish(run.run, late)),
                  (cause: unknown) =>
                    runPromise(Effect.logWarning("The late end of a Run failed", cause)),
                );
                throw new Error("The Workspace has not ended the Run yet");
              }

              return ended.value;
            },
            catch: failed("lastRunEnd"),
          }).pipe(
            Effect.flatMap((last) => finish(run.run, last)),
            Effect.catchCause((cause) => Effect.logWarning("Ending the Last run failed", cause)),
            // Forgotten either way: a Run the Workspace could not end stays "live" there until the next Run replaces it.
            Effect.ensuring(
              Effect.sync(() => {
                if (storage.get<OpenRun>(OPEN_KEY)?.run === run.run) storage.delete(OPEN_KEY);

                if (endingRun === run.run) endingRun = undefined;
              }),
            ),
          );

          // In the background: the owner's notification and the title do not wait for the copy.
          const running: Promise<void> = runPromise(end).finally(() => {
            if (ending === running) ending = undefined;
          });

          ending = running;
        });

      return {
        lastRun: Effect.sync(() => storage.get<LastRun>(LAST_KEY) ?? null),
        diff: Effect.tryPromise({ try: () => source.diff(), catch: failed("runDiff") }),
        file: (query) =>
          Effect.tryPromise({ try: () => source.file(query), catch: failed("runFile") }),
        beforeWrite,
        settled,
        observeEnded: (observer) => {
          observers.add(observer);

          return () => {
            observers.delete(observer);
          };
        },
      } satisfies SessionRunsService;
    }),
  );

/**
 * An extension that opens a Run before each call of `tools`' writing tools (`WRITING_TOOLS`) of a conversation that works
 * in the Session's own Workspace, if none is open. The Run belongs to the Session's active branch (the root agent's
 * conversation), whichever of its agents writes while that conversation is working. A call of a subagent that works in a
 * Subagent Workspace of its own opens none, nor does one of a subagent the owner messaged while the root is idle. Install it after the extensions that bring the tools.
 */
export const runsOpeningTools = (
  tools: ReadonlyArray<ToolRegistration>,
  runs: Pick<SessionRunsService, "beforeWrite">,
): Extension =>
  defineExtension({
    name: "last-run",
    wraps: Arr.map(
      Arr.filter(tools, (tool) => WRITING_TOOLS.has(tool.name)),
      (tool) =>
        wrapTool(tool, (wrapped) => ({
          ...wrapped,
          execute: async (args, api, context) => {
            // A call a script makes is a nested call of the model's: the Run opens at the call that made it.
            const firstCall = api.callId.split("/")[0] ?? api.callId;

            const state = await api.snapshot(SubagentsDoc, context).catch(() => undefined);

            if (
              state === undefined ||
              conversationWorkspace(state, api.conversationId) === undefined
            ) {
              const root =
                conversationOf(state ?? EMPTY_SUBAGENTS_STATE, "root") ?? api.conversationId;

              // A subagent's write joins the Run of the Session's own conversation while that is working. When the owner
              // messaged the subagent alone, the Session's own conversation is idle and there is no Run to join.
              const rootWorking =
                root === api.conversationId ||
                (await api.snapshot(LiveDoc, root, context).catch(() => undefined))?.run !==
                  undefined;

              if (rootWorking) await runs.beforeWrite({ conversationId: root, firstCall });
            }

            return wrapped.execute(args, api, context);
          },
        })),
    ),
  });
