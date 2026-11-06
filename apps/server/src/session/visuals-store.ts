// The Session's Visuals (`docs/architecture/visuals.md` → The copy, Socket messages): one record for each `visual_show`, written
// by the `visuals` extension through the Session's `VisualRecorder` into this object's key-value storage, outside History, and
// read back for a mount (`visual_page`) on any device, after a reload and in an archived Session. The record's JSON is kept in
// parts under `cloudpid:visual:<callId>:<n>`, with an index of every record and stub, oldest first, under `cloudpid:visuals`,
// by the chunked-record primitive the App records share (`./call-records.ts`), in a bound of its own: 32 MiB, 1000 Visuals
// and 2000 stubs, past which the least recently mounted Visual (never the one just written) becomes a stub that keeps what its
// card shows. The page arrives prepared (inlined, redacted, bounded: `@cloudpid/extensions/visuals`); the store keeps it, lists
// it, and answers its page with the origin the Session's Visuals are served at, which is computed from the Session, never
// kept. A write is one synchronous run, so no reader sees half of it.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off -- plain storage reads under
// Effect.sync, and a record of JSON values kept as its text (its write is one `Effect.try`, whose failure is the call's).
import {
  VisualKeepError,
  type VisualKept,
  type VisualRecorderService,
} from "@cloudpid/extensions/visuals";
import {
  bytesFromBase64,
  type ConversationId,
  MAX_VISUAL_BYTES,
  MAX_VISUAL_STUBS,
  MAX_VISUALS,
  MAX_VISUALS_BYTES,
  sourcePathOf,
  type VisualDraft,
  type VisualEntry,
  type VisualFileAnswer,
  type VisualPageAnswer,
  VisualRecord,
  type VisualSource,
  type VisualStub,
  visualSizeText,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Mutable } from "effect/Types";
import { callRecords, type CallRecordEntry } from "./call-records.ts";
import type { SpillRead } from "./mcp-resource-previews.ts";
import type { SessionKv } from "./session-kv.ts";

/** The index of every Visual and stub, oldest first. */
const INDEX_KEY = "cloudpid:visuals";

const partKey = (callId: string, part: number) => `cloudpid:visual:${callId}:${part}`;

/** What a Visual's entry holds besides the primitive's fields: everything its card shows without the page. */
type VisualFields = {
  readonly title: string;
  readonly summary: string;
  readonly source: VisualSource;
  readonly parentCall?: string;
  /** The page's UTF-8 bytes: kept by a stub too, whose `bytes` (what the bound counts) is 0. */
  readonly size: number;
  readonly at: number;
};

type IndexEntry = CallRecordEntry<VisualFields>;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(VisualRecord));

/** What `visual_file` answers for the file at `path` as the Workspace read it: its text when it is UTF-8. */
export const visualFileAnswer = (path: string, read: SpillRead): VisualFileAnswer => {
  if (read.kind === "too_large") return { status: "too_large", path };

  if (read.kind !== "base64") return { status: "missing", path };

  const bytes = bytesFromBase64(read.base64);

  if (bytes === undefined) return { status: "missing", path };

  try {
    return {
      status: "text",
      path,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { status: "not_text", path };
  }
};

/** The Session's Visuals, as the sockets and the extension reach them. */
export type SessionVisualsService = VisualRecorderService & {
  /** `conversation`'s Visuals, oldest first: what `visuals` lists. */
  readonly list: (conversation: ConversationId) => Effect.Effect<ReadonlyArray<VisualEntry>>;
  /** `conversation`'s Visuals now, and again each time they change. */
  readonly updates: (conversation: ConversationId) => Stream.Stream<ReadonlyArray<VisualEntry>>;
  /** `callId`'s page with its origin (marking it the most recently mounted), its stub, or none. */
  readonly page: (callId: string) => Effect.Effect<VisualPageAnswer>;
  /**
   * The file `callId`'s Visual was shown from and the conversation that showed it, kept or evicted, for Open file; none for
   * an inline page or a call that showed no Visual.
   */
  readonly fileOf: (
    callId: string,
  ) => Effect.Effect<{ readonly conversation: string; readonly path: string } | undefined>;
};

export class SessionVisuals extends Context.Service<SessionVisuals, SessionVisualsService>()(
  "@cloudpid/server/session/visuals-store/SessionVisuals",
) {}

export type SessionVisualsOptions = {
  readonly storage: SessionKv;
  /**
   * The origin the Session's Visuals are served at (`viewOrigin` of `visualViewHash(session)` and the deploy-time label), or
   * none when the stage cannot build one: a page is then answered without it, and its frame fails to start rather than guess.
   */
  readonly origin: string | undefined;
  /** The time in epoch milliseconds, `Date.now` unless a test sets it. */
  readonly now?: () => number;
};

const entryOf = (entry: IndexEntry): VisualEntry => {
  const shown: Mutable<VisualEntry> = {
    callId: entry.callId,
    title: entry.title,
    summary: entry.summary,
    source: entry.source,
    state: entry.state,
    bytes: entry.size,
    at: entry.at,
  };

  if (entry.parentCall !== undefined) shown.parentCall = entry.parentCall;

  return shown;
};

const stubOf = (entry: IndexEntry): VisualStub => {
  const stub: Mutable<VisualStub> = {
    callId: entry.callId,
    conversation: entry.conversation,
    title: entry.title,
    summary: entry.summary,
    source: entry.source,
    bytes: entry.size,
    at: entry.at,
  };

  if (entry.parentCall !== undefined) stub.parentCall = entry.parentCall;

  return stub;
};

/** What a stub keeps of a Visual's own fields: all of them, since none is the page. */
const keeps = (entry: IndexEntry): VisualFields => {
  const fields: Mutable<VisualFields> = {
    title: entry.title,
    summary: entry.summary,
    source: entry.source,
    size: entry.size,
    at: entry.at,
  };

  if (entry.parentCall !== undefined) fields.parentCall = entry.parentCall;

  return fields;
};

export const sessionVisuals = (options: SessionVisualsOptions): SessionVisualsService => {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const listeners = new Set<(conversations: ReadonlySet<string>) => void>();

  const records = callRecords<VisualFields>({
    storage,
    indexKey: INDEX_KEY,
    partKey,
    bounds: { bytes: MAX_VISUALS_BYTES, records: MAX_VISUALS, stubs: MAX_VISUAL_STUBS },
    keeps,
  });

  const changed = (conversations: ReadonlySet<string>) => {
    for (const listener of listeners) listener(conversations);
  };

  const list = (conversation: ConversationId): ReadonlyArray<VisualEntry> =>
    Arr.map(
      Arr.filter(records.index(), (entry) => entry.conversation === String(conversation)),
      entryOf,
    );

  const put: SessionVisualsService["put"] = (draft: VisualDraft) =>
    Effect.suspend(() => {
      if (draft.bytes > MAX_VISUAL_BYTES) {
        return Effect.fail(
          VisualKeepError.make({
            message: `The page is over the ${visualSizeText(MAX_VISUAL_BYTES)} a Visual may be`,
          }),
        );
      }

      return Effect.try({
        try: (): VisualKept => {
          const at = now();
          const record: VisualRecord = { ...draft, at };
          const entries = records.index();
          const path = sourcePathOf(draft.source);

          // The earlier Visual of the same file in the same conversation, which now shows collapsed.
          const supersedes =
            path === undefined
              ? undefined
              : Arr.findLast(
                  entries,
                  (entry) =>
                    entry.callId !== draft.callId &&
                    entry.conversation === draft.conversation &&
                    sourcePathOf(entry.source) === path,
                ).pipe(
                  Option.map((entry) => entry.callId),
                  Option.getOrUndefined,
                );

          const keptBefore = new Set(
            Arr.map(
              Arr.filter(entries, (entry) => entry.state === "kept"),
              (entry) => entry.callId,
            ),
          );

          const written = records.write(entries, draft.callId, JSON.stringify(record), (parts) => {
            const entry: Mutable<IndexEntry> = {
              callId: draft.callId,
              conversation: draft.conversation,
              state: "kept",
              bytes: draft.bytes,
              parts,
              mountedAt: at,
              title: draft.title,
              summary: draft.summary,
              source: draft.source,
              size: draft.bytes,
              at,
            };

            if (draft.parentCall !== undefined) entry.parentCall = draft.parentCall;

            return entry;
          });

          const touched = records.settle(written, draft.callId);

          touched.add(draft.conversation);

          const keptNow = new Set(
            Arr.map(
              Arr.filter(records.index(), (entry) => entry.state === "kept"),
              (entry) => entry.callId,
            ),
          );

          const evicted = Arr.filter(Array.from(keptBefore), (callId) => !keptNow.has(callId));

          changed(touched);

          return { supersedes, evicted: evicted.length };
        },
        catch: (cause) =>
          VisualKeepError.make({
            message: `The Session could not keep the Visual: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
    });

  const page: SessionVisualsService["page"] = (callId) =>
    Effect.sync((): VisualPageAnswer => {
      const entries = records.index();
      const found = Arr.findFirst(entries, (entry) => entry.callId === callId);

      if (Option.isNone(found)) return { status: "none" };

      const entry = found.value;

      if (entry.state !== "kept") return { status: "evicted", stub: stubOf(entry) };

      const record = decodeRecord(records.read(entry));

      if (Option.isNone(record)) {
        // Its parts are gone or unreadable: all that is left of it is a stub.
        const touched = records.settle(records.evict(entries, entry), undefined);

        touched.add(entry.conversation);
        changed(touched);

        return { status: "evicted", stub: stubOf(entry) };
      }

      // The most recently mounted last to go, as `mcp_app_mount` does for an App record.
      records.touch(entries, entry, now());

      return options.origin === undefined
        ? { status: "page", record: record.value }
        : { status: "page", record: record.value, origin: options.origin };
    });

  const updates: SessionVisualsService["updates"] = (conversation) =>
    Stream.callback<ReadonlyArray<VisualEntry>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (conversations: ReadonlySet<string>) => {
            if (conversations.has(String(conversation))) {
              Queue.offerUnsafe(queue, list(conversation));
            }
          };

          listeners.add(listener);
          Queue.offerUnsafe(queue, list(conversation));

          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    ).pipe(
      // A mount only moves a Visual's time, which no client shows.
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    );

  const fileOf: SessionVisualsService["fileOf"] = (callId) =>
    Effect.sync(() =>
      Arr.findFirst(records.index(), (entry) => entry.callId === callId).pipe(
        Option.flatMap((entry) =>
          Option.map(Option.fromNullishOr(sourcePathOf(entry.source)), (path) => ({
            conversation: entry.conversation,
            path,
          })),
        ),
        Option.getOrUndefined,
      ),
    );

  return {
    put,
    list: (conversation) => Effect.sync(() => list(conversation)),
    updates,
    page,
    fileOf,
  };
};

/** The layer of a Session's Visuals, for the sockets. */
export const sessionVisualsLayer = (service: SessionVisualsService) =>
  Layer.succeed(SessionVisuals, service);
