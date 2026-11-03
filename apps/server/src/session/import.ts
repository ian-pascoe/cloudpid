// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalDate:off -- the object's own clock and plain lists of warnings.
// A Session import in the Session object (`docs/architecture/mcp-endpoint.md` → Session import → The import channel): the
// `stageImport*` RPCs. Begin puts the new Session in the state a Fork is in while it fills (`importing`: no message, no
// move), append keeps the file's slices as rows (`import-staging.ts`), and finish checks the size and `sha256`, then
// translates the file into the root conversation, applies the model, and sends the instruction. The translation runs in
// a fiber of the object, which finish waits for up to 30 s and which the alarm resumes after an eviction. An import
// with no append for an hour expires, and the alarm then deletes the Session (`discard`).
import { Secrets } from "@cloudpid/extensions/secrets";
import {
  type ApiResult,
  apiFailure,
  apiOk,
  IMPORT_EXPIRY_MS,
  IMPORT_FINISH_WAIT_MS,
  MAX_MCP_IMPORT_BYTES,
  MAX_MCP_INPUT_BYTES,
  MAX_MCP_SLICE_BYTES,
  redactGithubTokens,
  type StageImportAppend,
  type StageImportBegin,
  type StageImportFinish,
  type StagedCancel,
  type StagedFinish,
  type StagedImport,
} from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
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
   * translation was cut off is started again. Never fails; it leaves the alarm to the next settle.
   */
  readonly sweep: Effect.Effect<void>;
};

export class SessionImport extends Context.Service<SessionImport, SessionImportService>()(
  "@cloudpid/server/session/import/SessionImport",
) {}

export type SessionImportOptions = {
  readonly staging: ImportStaging;
  /**
   * Delete the Session and its Workspace (when no other Session is in it): an import that expired or went unfinished. It
   * wipes the object itself, so it may not return.
   */
  readonly discard: Effect.Effect<void>;
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

/** How often a translation that keeps failing is started again before it is given up. */
const FINISH_ATTEMPTS = 5;

/** The request id the instruction is sent under, so a translation started again does not send it twice. */
const TEXT_REQUEST_ID = "session-import-text";

const notAnImport = apiFailure(
  "not_found",
  "This Session is not an import in progress: it was cancelled, or expired after an hour with no slice and was deleted.",
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

    return record.phase === "finishing" ? now + FINISH_RETRY_MS : record.expiresAt;
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

    /** Whether `record` passed its expiry without an append: it ends the call, and the alarm deletes the Session. */
    const isExpired = (record: ImportRecord, now: number): boolean =>
      (record.phase === "staging" || record.phase === "failed" || record.phase === "cancelled") &&
      record.expiresAt !== undefined &&
      now >= record.expiresAt;

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

          if (request.size_bytes < 0 || request.size_bytes > MAX_MCP_IMPORT_BYTES) {
            return apiFailure(
              "import_too_large",
              `The import is over ${String(MAX_MCP_IMPORT_BYTES)} bytes.`,
            );
          }

          if (
            request.text !== undefined &&
            new TextEncoder().encode(request.text).length > MAX_MCP_INPUT_BYTES
          ) {
            return apiFailure(
              "input_too_large",
              `The instruction is over ${String(MAX_MCP_INPUT_BYTES)} bytes.`,
            );
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

        staging.clear();
        update(record, {
          phase: "failed",
          failure: message,
          text: undefined,
          expiresAt: now + IMPORT_EXPIRY_MS,
        });
        yield* host.settle;
      });

    /** Translate the file into the Session and end the import; safe to run again after a cut. */
    const complete: Effect.Effect<void, SessionError> = Effect.gen(function* () {
      const record = staging.record();

      if (record?.phase !== "finishing") return;

      const defaults = yield* host.importDefaults;

      const chosen = resolveImportAgent(
        { model: record.model, thinking: record.thinking },
        defaults,
      );

      const translation = yield* Effect.try({
        try: () =>
          translate(linesOf(staging.rows()), {
            branch: record.workspace.branch,
            repos: record.workspace.repos,
            warnings: chosen.warnings,
          }),
        catch: (cause) => SessionError.make({ operation: "translate", message: String(cause) }),
      });

      if (!translated(translation)) return yield* failed(record, translation.failed);

      const root = yield* host.root;

      // The entries go in whole or not at all, so a root that has any holds them all: a translation cut off after that
      // resumes at the next step.
      const held = yield* host.entries({ conversationId: root, order: "ascending", limit: 1 });

      if (held.length === 0) yield* host.importTranslated(translation.entries);

      if (yield* host.copying) {
        yield* host.importFinish({
          conversationId: root,
          through: null,
          text: null,
          agent: chosen.agent,
          pick: chosen.pick,
          context: null,
          todo: null,
        });
        yield* sockets.greetAgain;
      }

      const usage = yield* host.contextUsage;

      const over =
        usage === null ? undefined : contextOverWindow(usage.tokens, usage.contextWindow);

      const warnings = yield* redacted([...chosen.warnings, ...(over === undefined ? [] : [over])]);

      // The instruction, once the notice is the last entry and the Session takes messages: marked as from the Local agent.
      // A repeat finds its first send (the request id), so a translation cut off after it does not send it twice.
      let cursor: string | undefined;

      if (record.text !== undefined) {
        const sent = yield* mcp.submit({
          input: record.text,
          requestId: TEXT_REQUEST_ID,
          via: record.via,
        });

        if (sent.ok) cursor = sent.value.cursor;
        else
          yield* Effect.logWarning(`The import's instruction was not sent: ${sent.error.message}`);
      }

      const outcome: Types.Mutable<NonNullable<ImportRecord["outcome"]>> = {
        summary: translation.summary,
        warnings,
      };

      if (cursor !== undefined) outcome.cursor = cursor;

      update(record, { phase: "ended", text: undefined, expiresAt: undefined, outcome });
      staging.clear();

      // Without a title of pi's, the Session is named once, from the import's first message and answer, beside the rest.
      yield* host.nameSession.pipe(Effect.forkIn(scope), Effect.asVoid);
      yield* host.settle;
    });

    /** A translation attempt that did not end it: counted, and the import is given up on when it keeps happening. */
    const attemptFailed = (message: string) =>
      Effect.gen(function* () {
        const record = staging.record();

        if (record?.phase !== "finishing") return;

        yield* Effect.logWarning(`Translating a Session import failed: ${message}`);

        const attempts = record.attempts + 1;

        if (attempts >= FINISH_ATTEMPTS) {
          yield* failed(update(record, { attempts }), "The import could not be completed.");
        } else {
          update(record, { attempts });
        }
      });

    /** Start the translation here, once; a failure that heals is counted, and one that keeps coming fails the import. */
    const start = Effect.gen(function* () {
      if (running !== undefined) return running;

      const fiber = yield* complete.pipe(
        Effect.catch((error) => attemptFailed(error.message)),
        // @effect-diagnostics-next-line missedPipeableOpportunity:off
        Effect.catchCause((cause) => attemptFailed(Cause.pretty(cause))),
        // Never fails: what could not be recorded is tried again by the alarm.
        Effect.catchCause((cause) =>
          Effect.logWarning("Recording a failed translation failed", cause),
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

    const finish: SessionImportService["finish"] = ({ sha256 }) =>
      guarded(
        Effect.gen(function* () {
          const record = staging.record();

          if (record === undefined || record.phase === "cancelled") return notAnImport;

          if (record.phase === "failed") {
            return apiFailure(
              "invalid_argument",
              `${record.failure ?? "The import failed."} Cancel it and begin again.`,
              { retryable: false },
            );
          }

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
                "The SHA-256 of the bytes held is not the one given: cancel the import and begin again.",
                { retryable: false },
              );
            }

            update(record, { phase: "finishing", expiresAt: undefined, attempts: 0 });
            // The retry for a translation that is cut off.
            yield* host.settle;
          }

          if (staging.record()?.phase === "finishing") {
            const fiber = yield* start;

            // Up to 30 s inline; the translation goes on after that, and `session_wait` reports its end.
            yield* Fiber.await(fiber).pipe(
              Effect.timeoutOption(Duration.millis(finishWaitMs())),
              Effect.asVoid,
            );
          }

          const now_ = staging.record();

          if (now_ === undefined) return notAnImport;

          if (now_.phase === "failed") {
            return apiFailure(
              "invalid_argument",
              `${now_.failure ?? "The import failed."} Cancel it and begin again.`,
              { retryable: false },
            );
          }

          return yield* finishResult(now_);
        }),
      );

    const cancel: SessionImportService["cancel"] = Effect.gen(function* () {
      const record = staging.record();

      if (record === undefined) return notAnImport;

      if (record.phase === "finishing") {
        return apiFailure(
          "invalid_argument",
          "The import was accepted and is being translated: it cannot be cancelled now.",
        );
      }

      if (record.phase === "ended") {
        return apiFailure(
          "invalid_argument",
          "The import has ended: the Session is the owner's now, to delete in cloudpid.",
        );
      }

      const now = yield* Clock.currentTimeMillis;

      // The bytes and the instruction go at once; the caller deletes the Session, and the alarm does if it cannot.
      staging.clear();
      update(record, { phase: "cancelled", text: undefined, expiresAt: now + DISCARD_RETRY_MS });
      yield* host.settle;

      return apiOk<StagedCancel>({ cancelled: true });
    }).pipe(guarded);

    const sweep: SessionImportService["sweep"] = Effect.gen(function* () {
      const record = staging.record();

      if (record === undefined) return;

      const now = yield* Clock.currentTimeMillis;

      if (isExpired(record, now)) {
        // The bytes and the instruction are discarded before the Session is, so a deletion that fails leaves neither.
        staging.clear();
        update(record, { phase: "cancelled", text: undefined, expiresAt: now + DISCARD_RETRY_MS });
        yield* options.discard;

        return;
      }

      if (record.phase === "finishing") yield* start;

      yield* host.settle;
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Sweeping a Session import failed", cause)),
    );

    return { begin, append, finish, cancel, sweep } satisfies SessionImportService;
  });

/** The Session's `SessionImport`; build it once per instance, over the host, the Secrets, the instruction and the sockets. */
export const sessionImportLayer = (options: SessionImportOptions) =>
  Layer.effect(SessionImport, sessionImport(options));
