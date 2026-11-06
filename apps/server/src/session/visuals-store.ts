// The Session's Visuals (`docs/architecture/visuals.md` → The copy, Socket messages, Fork and Clone): one record for each `visual_show`, written
// by the `visuals` extension through the Session's `VisualRecorder` into this object's key-value storage, outside History, and
// read back for a mount (`visual_page`) on any device, after a reload and in an archived Session. The record's JSON is kept in
// parts under `cloudpid:visual:<callId>:<n>`, with an index of every record and stub, oldest first, under `cloudpid:visuals`,
// by the chunked-record primitive the App records share (`./call-records.ts`), in a bound of its own: 32 MiB, 1000 Visuals
// and 2000 stubs, past which the least recently mounted Visual (never the one just written) becomes a stub that keeps what its
// card shows. The page arrives prepared (inlined, redacted, bounded: `@cloudpid/extensions/visuals`); the store keeps it, lists
// it, and answers its page with the origin the Session's Visuals are served at, which is computed from the Session, never
// kept. A Fork or Clone copies the Visuals of the calls it copies (`copiesFor`, `adopt`), reading each copy by its shape since
// the source may be another build. A write is one synchronous run, so no reader sees half of it.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off -- plain storage reads under
// Effect.sync, and a record of JSON values kept as its text (its write is one `Effect.try`, whose failure is the call's).
import {
  VisualKeepError,
  type VisualKept,
  type VisualRecorderService,
} from "@cloudpid/extensions/visuals";
import {
  type ConversationId,
  MAX_VISUAL_BYTES,
  MAX_VISUAL_STUBS,
  MAX_VISUALS,
  MAX_VISUALS_BYTES,
  sourcePathOf,
  type VisualCopies,
  type VisualCopy,
  type VisualDraft,
  type VisualEntry,
  type VisualPageAnswer,
  VisualRecord,
  type VisualSource,
  VisualStub,
  visualSizeText,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Mutable } from "effect/Types";
import { callRecords, type CallRecordEntry } from "./call-records.ts";
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

const isRecord = Schema.is(VisualRecord);
const isStub = Schema.is(VisualStub);

const encoder = new TextEncoder();

/** The Session's Visuals, as the sockets and the extension reach them. */
export type SessionVisualsService = VisualRecorderService &
  VisualCopies & {
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

/** A Visual's own fields, and nothing else of `from`: the one place they are listed, for an entry, a stub and a write. */
const fieldsOf = (from: VisualFields): VisualFields => {
  const fields: Mutable<VisualFields> = {
    title: from.title,
    summary: from.summary,
    source: from.source,
    size: from.size,
    at: from.at,
  };

  if (from.parentCall !== undefined) fields.parentCall = from.parentCall;

  return fields;
};

/** A Visual's own fields as a client reads them, where the page's size is `bytes`. */
const shownOf = (entry: IndexEntry) => {
  const { size, ...fields } = fieldsOf(entry);

  return { ...fields, bytes: size };
};

const entryOf = (entry: IndexEntry): VisualEntry => ({
  callId: entry.callId,
  state: entry.state,
  ...shownOf(entry),
});

const stubOf = (entry: IndexEntry): VisualStub => ({
  callId: entry.callId,
  conversation: entry.conversation,
  ...shownOf(entry),
});

export const sessionVisuals = (options: SessionVisualsOptions): SessionVisualsService => {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const listeners = new Set<(conversations: ReadonlySet<string>) => void>();

  const records = callRecords<VisualFields>({
    storage,
    indexKey: INDEX_KEY,
    partKey,
    bounds: { bytes: MAX_VISUALS_BYTES, records: MAX_VISUALS, stubs: MAX_VISUAL_STUBS },
    // What a stub keeps of a Visual's own fields: all of them, since none is the page.
    keeps: fieldsOf,
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

          const written = records.write(
            entries,
            draft.callId,
            JSON.stringify(record),
            (parts): IndexEntry => ({
              callId: draft.callId,
              conversation: draft.conversation,
              state: "kept",
              bytes: draft.bytes,
              parts,
              mountedAt: at,
              ...fieldsOf({ ...draft, size: draft.bytes, at }),
            }),
          );

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

  const copiesFor: SessionVisualsService["copiesFor"] = (callIds) => {
    if (callIds.length === 0) return [];

    const wanted = new Set(callIds);

    return Arr.map(
      Arr.filter(
        records.index(),
        (entry) =>
          wanted.has(entry.callId) ||
          (entry.parentCall !== undefined && wanted.has(entry.parentCall)),
      ),
      (entry): VisualCopy => {
        if (entry.state === "kept") {
          const record = decodeRecord(records.read(entry));

          if (Option.isSome(record)) return { kind: "record", record: record.value };
        }

        // Evicted, or its parts are gone or unreadable: all that is left of it is a stub.
        return { kind: "stub", stub: stubOf(entry) };
      },
    );
  };

  /** `entries` with `stub`'s call a stub of the conversation `root`. */
  const adoptStub = (
    entries: ReadonlyArray<IndexEntry>,
    stub: VisualStub,
    root: string,
    at: number,
  ) =>
    records.stub(entries, {
      ...fieldsOf({ ...stub, size: stub.bytes }),
      callId: stub.callId,
      conversation: root,
      mountedAt: at,
    });

  const adopt: SessionVisualsService["adopt"] = (copies, conversation) => {
    const at = now();
    const root = String(conversation);
    let entries = records.index();

    for (const copy of copies) {
      // A copy is an RPC's value, never decoded: each is read by its shape, and one this build cannot use is skipped, so a
      // Fork from another build is still made and a card says "no longer kept" where its Visual is not.
      if (copy.kind === "record" && "record" in copy && Predicate.isObject(copy.record)) {
        const { record } = copy;

        // Its size as this build counts it, which the bounds hold to.
        const bytes = Predicate.isString(record.html)
          ? encoder.encode(record.html).length
          : record.bytes;

        if (isRecord(record) && bytes <= MAX_VISUAL_BYTES) {
          const kept: VisualRecord = { ...record, conversation: root, bytes };

          entries = records.write(
            entries,
            kept.callId,
            JSON.stringify(kept),
            (parts): IndexEntry => ({
              callId: kept.callId,
              conversation: root,
              state: "kept",
              bytes,
              parts,
              mountedAt: at,
              ...fieldsOf({ ...kept, size: bytes }),
            }),
          );
        } else if (isStub({ ...record, bytes })) {
          // A page this build cannot keep or read leaves what its card shows.
          entries = adoptStub(entries, { ...record, bytes }, root, at);
        }
      } else if (copy.kind === "stub" && "stub" in copy && isStub(copy.stub)) {
        entries = adoptStub(entries, copy.stub, root, at);
      }
    }

    // The index is written once, after the bounds hold of every copy together.
    const touched = records.settle(entries, undefined);

    touched.add(root);
    changed(touched);
  };

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
    copiesFor,
    adopt,
  };
};

/** The layer of a Session's Visuals, for the sockets. */
export const sessionVisualsLayer = (service: SessionVisualsService) =>
  Layer.succeed(SessionVisuals, service);
