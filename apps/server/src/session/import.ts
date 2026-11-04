// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalDate:off -- the object's own clock and plain lists of warnings.
// A Session import in the Session object (`docs/architecture/mcp-endpoint.md` → Session import → The import channel): the
// `stageImport*` RPCs. Begin puts the new Session in the state a Fork is in while it fills (`importing`: no message, no
// move), append keeps the file's slices as rows (`import-staging.ts`), and finish checks the size and `sha256`, then
// translates the file into the root conversation, applies the model, and sends the instruction. The translation runs in
// a fiber of the object, which finish waits for up to 30 s and which the alarm resumes after an eviction. An import
// with no append for an hour expires, and the alarm then deletes the Session (`discard`); once the entries are in the
// Session (`held`) it never expires and is never given up, only retried until the Registry is told it ended.
import { Secrets } from "@cloudpid/extensions/secrets";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  IMPORT_EXPIRY_MS,
  IMPORT_FINISH_WAIT_MS,
  MAX_MCP_SLICE_BYTES,
  redactGithubTokens,
  type StageImportAppend,
  type StageImportBegin,
  type StageImportFinish,
  type StagedCancel,
  type StagedFinish,
  type StagedImport,
} from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type * as Types from "effect/Types";
import { SessionError } from "./errors.ts";
import { SessionHost } from "./host.ts";
import { contextOverWindow, resolveImportAgent } from "./import-model.ts";
import { type ImportRecord, type ImportStaging, linesOf } from "./import-staging.ts";
import { type ImportTranslator, translatePiSession, translated } from "./import-translate.ts";
import { SessionMcp } from "./mcp.ts";
import { SessionSockets } from "./sockets.ts";

/** The Session's `stageImport*` RPCs. Never fails: a failure is the value's. */
export type SessionImportService = {
  readonly begin: (request: StageImportBegin) => Effect.Effect<ApiResult<StagedImport>>;
  readonly append: (request: StageImportAppend) => Effect.Effect<ApiResult<StagedImport>>;
  readonly finish: (request: StageImportFinish) => Effect.Effect<ApiResult<StagedFinish>>;
  readonly cancel: Effect.Effect<ApiResult<StagedCancel>>;
  /**
   * What the object does when its alarm fires: an import that expired is discarded and its Session deleted, one whose
   * translation was cut off is started again. Never fails. Answers whether the Session was deleted: nothing else may run
   * in the object then, for its storage is empty and anything that wrote to it would only bring it back.
   */
  readonly sweep: Effect.Effect<boolean>;
};

export class SessionImport extends Context.Service<SessionImport, SessionImportService>()(
  "@cloudpid/server/session/import/SessionImport",
) {}

export type SessionImportOptions = {
  readonly staging: ImportStaging;
  /**
   * Delete the Session and its Workspace (when no other Session is in it): an import that expired or went unfinished.
   * It wipes the object's own storage last, and never resets the object, so the alarm that ran it ends normally and is
   * not retried over empty storage. A failure is its own to log: the import stays, and the alarm tries again.
   */
  readonly discard: Effect.Effect<void>;
  /**
   * Tell the Registry the import ended, so the Session is no longer shown `importing` and no longer counts as open. A
   * failure is a defect: the translation stops there and the alarm runs it again, without counting an attempt, until it
   * is told.
   */
  readonly ended: Effect.Effect<void>;
  /** Translates the file; `translatePiSession` by default. */
  readonly translate?: ImportTranslator;
  /** How long finish waits for the translation, in milliseconds; read at each finish. */
  readonly finishWaitMs?: () => number;
  /** The SHA-256 of the held bytes, as lowercase hex. */
  readonly digest?: (rows: Iterable<Uint8Array>) => Promise<string>;
};

/** How long a translation may be cut off before the alarm starts it again, in milliseconds. */
export const FINISH_RETRY_MS = 60_000;

/** How long an import that ended badly, or was cancelled, waits for its Session to be deleted before it tries again, in milliseconds. */
const DISCARD_RETRY_MS = 5 * 60_000;

/**
 * How many times a translation is started (each counted before it runs) before the import is given up, while the
 * entries are not yet in the Session: once they are, it is never given up.
 */
const FINISH_ATTEMPTS = 5;

/** The request id the instruction is sent under, so a translation started again does not send it twice. */
const TEXT_REQUEST_ID = "session-import-text";

const notAnImport = apiFailure(
  "not_found",
  "This Session is not an import in progress: it was cancelled, or expired after an hour with no slice and was deleted.",
);

/** The import cannot go on (`message`, or a failed one's): it is cancelled, or it expires, and the owner begins again. */
const failure = (message: string | undefined) =>
  apiFailure("invalid_argument", `${message ?? "The import failed."} Cancel it and begin again.`, {
    retryable: false,
  });

const hasEnded = apiFailure(
  "invalid_argument",
  "The import has ended: the Session is the owner's now, to delete in cloudpid.",
);

const expired = apiFailure(
  "import_expired",
  "This import had no slice for an hour and is deleted: begin it again.",
  { retryable: false },
);

/** The SHA-256 of `rows`, as lowercase hex, without holding the whole file. */
// @effect-diagnostics-next-line asyncFunction:off
export const sha256Hex = async (rows: Iterable<Uint8Array>): Promise<string> => {
  const stream = new crypto.DigestStream("SHA-256");
  const writer = stream.getWriter();

  for (const row of rows) await writer.write(row);

  await writer.close();

  return Array.from(new Uint8Array(await stream.digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** When the object must wake for the import: its expiry, or the retry of a translation that may have been cut off. */
export const importWakeAt = (
  staging: Pick<ImportStaging, "record">,
): Effect.Effect<number | undefined> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const record = staging.record();

    if (record === undefined || record.phase === "ended") return undefined;

    // A translation that may have been cut off is started again soon, and given up on at its expiry. One whose entries
    // are held has no expiry: it is started again until the Registry is told.
    return record.phase === "finishing"
      ? Math.min(
          now + FINISH_RETRY_MS,
          record.held === true ? Infinity : (record.expiresAt ?? Infinity),
        )
      : record.expiresAt;
  });

const sessionImport = (options: SessionImportOptions) =>
  Effect.gen(function* () {
    const host = yield* SessionHost;
    const mcp = yield* SessionMcp;
    const sockets = yield* SessionSockets;
    const secrets = yield* Secrets;
    const scope = yield* Scope.Scope;
    const { staging } = options;
    const translate = options.translate ?? translatePiSession;
    const finishWaitMs = options.finishWaitMs ?? (() => IMPORT_FINISH_WAIT_MS);
    const digest = options.digest ?? sha256Hex;

    /** The translation in progress in this instance, if any. */
    let running: Fiber.Fiber<void> | undefined;

    /** Whether this instance deleted its Session: a retried alarm then finds it so, and nothing runs over the empty storage. */
    let deleted = false;

    const unavailable = (error: { readonly message: string }) =>
      apiFailure("unavailable", error.message);

    /** Every failure of the host is `unavailable`, which may heal. */
    const guarded = <A>(effect: Effect.Effect<ApiResult<A>, SessionError>) =>
      effect.pipe(Effect.catch((error) => Effect.sync(() => unavailable(error))));

    /** `record` with `changes` (a field set to undefined is left out of what is kept), saved. */
    const update = (record: ImportRecord, changes: Partial<ImportRecord>): ImportRecord => {
      const next: ImportRecord = { ...record, ...changes };

      staging.save(next);

      return next;
    };

    /**
     * `record` with the bytes and the instruction dropped and `changes` made: an import that ends badly or is given up
     * keeps neither. Saved.
     */
    const dropped = (record: ImportRecord, changes: Partial<ImportRecord>): ImportRecord => {
      staging.clear();

      return update(record, { ...changes, text: undefined });
    };

    /**
     * Whether `record` passed its expiry (an hour with no append, or the end of a translation's time): the alarm deletes
     * the Session. Never one whose entries are held: the Session has the work in it, and the import only has to end.
     */
    const isExpired = (record: ImportRecord, now: number): boolean =>
      record.phase !== "ended" &&
      record.held !== true &&
      record.expiresAt !== undefined &&
      now >= record.expiresAt;

    /** Stop the translation in progress, if there is one, and answer the import's record as it stands then. */
    const stopRunning = Effect.gen(function* () {
      if (running !== undefined) yield* Fiber.interrupt(running);

      // Read after the stop: a translation that reached its end first has ended the import, whatever was read before.
      return staging.record();
    });

    /**
     * `record`, with `held` found out when a translation was cut off after it wrote the last of its entries and before it
     * noted so (`host.importWritten`: the root holds only some of them until then, and a Session that is importing runs
     * nothing from them, so a partly written import is never held).
     */
    const adopted = (record: ImportRecord) =>
      Effect.gen(function* () {
        if (record.phase !== "finishing" || record.held === true) return record;

        return (yield* host.importWritten)
          ? update(record, { held: true, expiresAt: undefined })
          : record;
      });

    /** The held Secrets' redaction, with the GitHub token pass: every text that leaves the object goes through it. */
    const redacted = (texts: ReadonlyArray<string>) =>
      secrets.readable.pipe(
        Effect.map((readable) =>
          texts.map((text) =>
            readable
              ? redactGithubTokens(secrets.redact(text))
              : "A warning was withheld: the Secrets to redact it of could not be read.",
          ),
        ),
      );

    const staged = (record: ImportRecord): StagedImport => ({
      received: record.phase === "ended" ? record.size : staging.received(),
      expires_at: record.expiresAt ?? 0,
    });

    const begin: SessionImportService["begin"] = (request) =>
      guarded(
        Effect.gen(function* () {
          const known = staging.record();

          // A begin that is sent again (the same `request_id` finds the same Session) finds the import as it stands.
          if (known !== undefined) {
            if (known.phase === "cancelled") return notAnImport;

            if (known.phase === "staging" && !(yield* host.copying)) yield* host.importBegin;

            return apiOk(staged(known));
          }

          const now = yield* Clock.currentTimeMillis;

          const record: Types.Mutable<ImportRecord> = {
            phase: "staging",
            size: request.size_bytes,
            via: request.via,
            workspace: request.workspace,
            expiresAt: now + IMPORT_EXPIRY_MS,
            attempts: 0,
          };

          if (request.model !== undefined) record.model = request.model;

          if (request.thinking !== undefined) record.thinking = request.thinking;

          if (request.text !== undefined) record.text = request.text;

          // The record first: a begin cut off between the two is found again, and the Session made importing then.
          staging.save(record);
          yield* host.importBegin;
          // The alarm for the expiry.
          yield* host.settle;

          return apiOk(staged(record));
        }),
      );

    const append: SessionImportService["append"] = ({ offset, data }) =>
      guarded(
        Effect.gen(function* () {
          const record = staging.record();

          if (record === undefined || record.phase === "cancelled") return notAnImport;

          const now = yield* Clock.currentTimeMillis;

          if (isExpired(record, now)) {
            // The alarm deletes it: not inside this call, which the deletion would cut off.
            yield* host.settle;

            return expired;
          }

          const bytes = new TextEncoder().encode(data);

          if (bytes.length > MAX_MCP_SLICE_BYTES) {
            return apiFailure(
              "invalid_argument",
              `A slice is at most ${String(MAX_MCP_SLICE_BYTES)} bytes: send less data.`,
            );
          }

          const received = staging.received();

          // A slice sent again, because its answer was lost, is already held: nothing to do.
          if (offset < received && offset + bytes.length <= received) return apiOk(staged(record));

          if (offset !== received || record.phase !== "staging") {
            if (record.phase !== "staging" && offset >= received) {
              return apiFailure(
                "invalid_argument",
                "This import has finished receiving: no more slices are taken.",
              );
            }

            return apiFailure(
              "offset_mismatch",
              `The slice starts at byte ${String(offset)} but ${String(received)} bytes are held: send the next slice from offset ${String(received)}.`,
              { retryable: true, details: { received } },
            );
          }

          if (received + bytes.length > record.size) {
            return apiFailure(
              "import_too_large",
              `The slice goes past the ${String(record.size)} bytes the import declared.`,
            );
          }

          if (bytes.length > 0) staging.append(offset, bytes);

          return apiOk(staged(update(record, { expiresAt: now + IMPORT_EXPIRY_MS })));
        }),
      );

    /** What the import ended with, or where it is: the status and cursor are the Session's. */
    const finishResult = (record: ImportRecord): Effect.Effect<ApiResult<StagedFinish>> =>
      mcp.status().pipe(
        Effect.map((report): ApiResult<StagedFinish> => {
          if (!report.ok) return report;

          const { outcome } = record;

          const result: Types.Mutable<StagedFinish> = {
            // Until the import has ended, whatever the Session shows, the import is what it is doing.
            status: record.phase === "ended" ? report.value.status : "importing",
            cursor: outcome?.cursor ?? report.value.cursor,
            warnings: outcome?.warnings ?? [],
          };

          if (outcome !== undefined) result.summary = outcome.summary;

          return apiOk(result);
        }),
      );

    /** The import cannot be finished: its bytes and instruction are discarded, and the Session waits to be cancelled or to expire. */
    const failed = (record: ImportRecord, message: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        dropped(record, { phase: "failed", failure: message, expiresAt: now + IMPORT_EXPIRY_MS });
        yield* host.settle;
      });

    /** Translate the file into the Session and end the import; safe to run again after a cut. */
    const complete: Effect.Effect<void, SessionError> = Effect.gen(function* () {
      const first = staging.record();

      if (first?.phase !== "finishing") return;

      let record: ImportRecord = first;

      const defaults = yield* host.importDefaults;

      const chosen = resolveImportAgent(
        { model: record.model, thinking: record.thinking },
        defaults,
      );

      const tools = yield* host.importTools;

      const translation = yield* Effect.try({
        try: () =>
          translate(
            // The translation reads the file more than once, which a generator cannot: each read starts over from the rows.
            { [Symbol.iterator]: () => linesOf(staging.rows()) },
            {
              branch: record.workspace.branch,
              repos: record.workspace.repos,
              warnings: chosen.warnings,
              tools,
              changesCarried: record.changesCarried,
            },
          ),
        catch: (cause) => SessionError.make({ operation: "translate", message: String(cause) }),
      });

      if (!translated(translation)) {
        // What was held is the Session's now, and a translator that has since changed its mind does not undo it: the
        // import stays and is run again, and the owner can cancel it.
        if (record.held === true) {
          return yield* SessionError.make({ operation: "translate", message: translation.failed });
        }

        return yield* failed(record, translation.failed);
      }

      const root = yield* host.root;

      // The entries are written a page at a time (`host.importTranslated`), and until the import ends nothing reads them,
      // so they are in whole or not at all to anything that can see. A translation cut off part way resumes after the
      // pages the root already has.
      if (record.held !== true) {
        const unresumable = yield* host.importTranslated(translation.pages(), {
          version: translation.version,
          count: translation.count,
        });

        // The entries the cut-off run wrote are of another translation: they are not built on, and the owner begins again.
        if (unresumable !== undefined) return yield* failed(record, unresumable);
      }

      // From here the entries are in the Session, and a Run may start from them: the import is no longer counted in
      // attempts, never given up and never expires. All that is left is to tell the Registry it ended.
      if (record.held !== true) record = update(record, { held: true, expiresAt: undefined });

      if (yield* host.copying) {
        yield* host.importFinish({
          conversationId: root,
          through: null,
          text: null,
          agent: chosen.agent,
          pick: chosen.pick,
          context: translation.context,
          todo: translation.todo,
        });
        yield* sockets.greetAgain;
      }

      const usage = yield* host.contextUsage;

      const over =
        usage === null ? undefined : contextOverWindow(usage.tokens, usage.contextWindow);

      const notes = [...chosen.warnings, ...(over === undefined ? [] : [over])];

      // The instruction, once the notice is the last entry and the Session takes messages: marked as from the Local agent.
      // A repeat finds its first send (the request id), so a translation cut off after it does not send it twice. One
      // that is refused is told to the Local agent, which sends it again with `session_send`.
      let cursor: string | undefined;

      if (record.text !== undefined) {
        const sent = yield* mcp.submit({
          input: record.text,
          requestId: TEXT_REQUEST_ID,
          via: record.via,
        });

        if (sent.ok) cursor = sent.value.cursor;
        else {
          notes.push(
            `The instruction was not sent (${sent.error.message}): send it with session_send.`,
          );
        }
      }

      const warnings = yield* redacted(notes);

      const outcome: Types.Mutable<NonNullable<ImportRecord["outcome"]>> = {
        summary: translation.summary,
        warnings,
      };

      if (cursor !== undefined) outcome.cursor = cursor;

      // The Registry first: a cut after it is run again, and it is told the same. Uninterruptible with the end it
      // records, so a cancel that stops this fiber finds the import ended or not yet, never half.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* options.ended;
          dropped(record, { phase: "ended", expiresAt: undefined, held: undefined, outcome });
        }),
      );

      // Without a title of pi's, the Session is named once, from the import's first message and answer, beside the rest.
      yield* host.nameSession.pipe(Effect.forkIn(scope), Effect.asVoid);
      yield* host.settle;
    });

    /**
     * Start the translation here, once. The attempt is counted first and durably, so a translation that crashes the
     * object (memory, CPU, a reset) leaves its count behind: after `FINISH_ATTEMPTS` the import is given up, unless the
     * entries are held (then it is run until it ends). Answers none when there is nothing to run.
     */
    const start = Effect.gen(function* () {
      if (running !== undefined) return running;

      const found = staging.record();

      if (found?.phase !== "finishing") return undefined;

      const record = yield* adopted(found);

      // Entries held are not given up, and the run that ends the import is not an attempt to count.
      if (record.held !== true) {
        if (record.attempts >= FINISH_ATTEMPTS) {
          yield* failed(record, "The import could not be completed.");

          return undefined;
        }

        update(record, { attempts: record.attempts + 1 });
      }

      const fiber = yield* complete.pipe(
        // A failure that heals is run again by the alarm; what cannot be recorded is logged.
        Effect.catchCause((cause) =>
          Effect.logWarning("Translating a Session import failed", cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running = undefined;
          }),
        ),
        Effect.forkIn(scope),
      );

      running = fiber;

      return fiber;
    });

    const finish: SessionImportService["finish"] = ({ sha256, changes_carried }) =>
      guarded(
        Effect.gen(function* () {
          const record = staging.record();

          if (record === undefined || record.phase === "cancelled") return notAnImport;

          if (record.phase === "failed") return failure(record.failure);

          const now = yield* Clock.currentTimeMillis;

          if (isExpired(record, now)) {
            yield* host.settle;

            return expired;
          }

          if (record.phase === "staging") {
            const received = staging.received();

            if (received !== record.size) {
              return apiFailure(
                "offset_mismatch",
                `${String(received)} of the declared ${String(record.size)} bytes are held: send the rest from offset ${String(received)}, then finish.`,
                { retryable: true, details: { received } },
              );
            }

            const held = yield* Effect.tryPromise({
              try: () => digest(staging.rows()),
              catch: (cause) => SessionError.make({ operation: "digest", message: String(cause) }),
            });

            if (held !== sha256.toLowerCase()) {
              return apiFailure(
                "checksum_mismatch",
                "The SHA-256 of the bytes held is not the one given: check the file, then finish again with its SHA-256. The bytes are kept, so slices that were sent need no resending; or cancel the import and begin again.",
                { retryable: false },
              );
            }

            // The translation has an hour, to the alarm that gives it up and deletes the Session.
            update(record, {
              phase: "finishing",
              expiresAt: now + IMPORT_EXPIRY_MS,
              attempts: 0,
              // From the finish that is accepted: a repeat of it, once the import is finishing, changes nothing.
              changesCarried: changes_carried,
            });
            // The retry for a translation that is cut off.
            yield* host.settle;
          }

          if (staging.record()?.phase === "finishing") {
            const fiber = yield* start;

            // Up to 30 s inline; the translation goes on after that, and `session_wait` reports its end.
            if (fiber !== undefined) {
              yield* Fiber.await(fiber).pipe(
                Effect.timeoutOption(Duration.millis(finishWaitMs())),
                Effect.asVoid,
              );
            }
          }

          const after = staging.record();

          if (after === undefined) return notAnImport;

          if (after.phase === "failed") return failure(after.failure);

          return yield* finishResult(after);
        }),
      );

    const cancel: SessionImportService["cancel"] = Effect.gen(function* () {
      if (staging.record()?.phase === "ended") return hasEnded;

      // A translation under way stops: the Session is deleted next, and what it wrote with it. A translation that
      // reaches its end first has ended the import, which is then no longer the Local agent's to cancel.
      const record = yield* stopRunning;

      if (record === undefined) return notAnImport;

      if (record.phase === "ended") return hasEnded;

      const now = yield* Clock.currentTimeMillis;

      // The bytes and the instruction go at once; the caller deletes the Session, and the alarm does if it cannot.
      dropped(record, { phase: "cancelled", expiresAt: now + DISCARD_RETRY_MS });
      yield* host.settle;

      return apiOk<StagedCancel>({ cancelled: true });
    }).pipe(guarded);

    const sweep: SessionImportService["sweep"] = Effect.gen(function* () {
      if (deleted) return true;

      const found = staging.record();

      if (found === undefined) return false;

      const now = yield* Clock.currentTimeMillis;

      const record = yield* adopted(found);

      if (isExpired(record, now)) {
        // The bytes and the instruction are discarded before the Session is, so a deletion that fails leaves neither.
        const stopped = yield* stopRunning;

        // Ended, or ended since: the Session is the owner's now.
        if (stopped === undefined || stopped.phase === "ended") return false;

        // The translation wrote its entries before it was stopped: the Session is kept, and the import run again.
        if (stopped.held !== true) {
          dropped(stopped, { phase: "cancelled", expiresAt: now + DISCARD_RETRY_MS });
          yield* options.discard;

          // Wiped: no record is left to read. Anything else that runs now would write to storage that is empty.
          deleted = staging.record() === undefined;

          return deleted;
        }
      }

      if (staging.record()?.phase === "finishing") yield* start;

      yield* host.settle;

      return false;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Sweeping a Session import failed", cause).pipe(Effect.as(false)),
      ),
    );

    return { begin, append, finish, cancel, sweep } satisfies SessionImportService;
  });

/** The Session's `SessionImport`; build it once per instance, over the host, the Secrets, the instruction and the sockets. */
export const sessionImportLayer = (options: SessionImportOptions) =>
  Layer.effect(SessionImport, sessionImport(options));
