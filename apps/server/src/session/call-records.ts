// The chunked-record primitive under the Session's per-call stores (`docs/architecture/visuals.md` → The copy: The store;
// `docs/architecture/mcp-apps.md` → App records): the App record store (`./mcp-apps-store.ts`) sits on it today, and
// Visuals' store will share it (#658). A call's record is text, kept in this object's key-value storage in parts of at most
// `PART_LENGTH` characters, with an index of every record and stub, oldest first, under one key, written last of everything
// a change touches. Past its bounds (bytes kept, records kept, stubs kept) the least recently mounted record is evicted to a
// stub (a call's entry that holds no data), never the one just written, and the oldest stubs are dropped. Everything here is
// synchronous, so a write is one run that no reader sees half of; a store decides what a record is (its JSON, its
// redaction, its bounds, its entry's own fields), never how it is kept. A replaced instance's storage refuses every
// operation (`refusingStorage`), so a write it cuts has put no index: the index lists what it did before. A call new to the
// index leaves the parts it had written orphaned, outside every bound. A listed call that was being replaced has had its
// earlier parts dropped, and reads back whatever of its new parts was written, as far as its entry's part count reaches (a
// missing part reads as nothing); the primitive does not check that the text still parses, which is the store's to do.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { SessionKv } from "./session-kv.ts";

/** The most characters one stored value holds: a record's text over it is kept in parts. */
export const PART_LENGTH = 256 * 1024;

/**
 * What the index holds for a call, whatever a store adds to it: a record's (`kept`, with its size and parts) or a stub's
 * (`evicted`, with none). `mountedAt` orders the eviction.
 */
export type CallRecordBase = {
  readonly callId: string;
  readonly conversation: string;
  readonly state: "kept" | "evicted";
  readonly bytes: number;
  readonly parts: number;
  readonly mountedAt: number;
};

/** An entry of the index: the primitive's fields and the store's own, `Own`. */
export type CallRecordEntry<Own extends object> = CallRecordBase & Own;

/** What a stub is made of: the store's own fields, and the call it is of. The primitive sets the rest. */
export type CallRecordStub<Own extends object> = Own &
  Pick<CallRecordBase, "callId" | "conversation" | "mountedAt">;

export type CallRecordsOptions<Own extends object> = {
  readonly storage: SessionKv;
  /** Where the index is kept. */
  readonly indexKey: string;
  /** Where part `part` of call `callId`'s record is kept. */
  readonly partKey: (callId: string, part: number) => string;
  /** Other values kept for a call (an audit log), deleted with its parts. */
  readonly alsoKeys?: (callId: string) => ReadonlyArray<string>;
  /** The most bytes of records kept, the most records kept, and the most stubs kept. */
  readonly bounds: { readonly bytes: number; readonly records: number; readonly stubs: number };
  /**
   * What of its own fields a stub keeps when a record is evicted to one. The primitive sets the rest (the call, its
   * `mountedAt`, `state: "evicted"`, no bytes or parts), whatever this returns.
   */
  readonly keeps: (entry: CallRecordEntry<Own>) => Own;
};

export type CallRecords<Own extends object> = {
  /** Every record and stub, oldest first. */
  readonly index: () => ReadonlyArray<CallRecordEntry<Own>>;
  /** A kept record's text, put back together; a part that is gone reads as nothing, so the text may not parse. */
  readonly read: (entry: CallRecordEntry<Own>) => string;
  /**
   * `entries` with `text` kept as call `callId`'s record, replacing an earlier one (its parts and its other values dropped
   * first), and `entryOf`'s entry (given the number of parts) in place of the earlier entry, or last. The parts are written;
   * the index is not.
   */
  readonly write: (
    entries: ReadonlyArray<CallRecordEntry<Own>>,
    callId: string,
    text: string,
    entryOf: (parts: number) => CallRecordEntry<Own>,
  ) => ReadonlyArray<CallRecordEntry<Own>>;
  /** `entries` with `entry`'s parts and its other values dropped and the entry a stub, in its place. The index is not written. */
  readonly evict: (
    entries: ReadonlyArray<CallRecordEntry<Own>>,
    entry: CallRecordEntry<Own>,
  ) => ReadonlyArray<CallRecordEntry<Own>>;
  /**
   * `entries` with a stub of `call` as its call's entry, last: a record the call had loses its parts and its other values.
   * The index is not written.
   */
  readonly stub: (
    entries: ReadonlyArray<CallRecordEntry<Own>>,
    call: CallRecordStub<Own>,
  ) => ReadonlyArray<CallRecordEntry<Own>>;
  /**
   * Write `entries` as the index after the bounds held: the least recently mounted record past the byte and record bounds
   * is evicted (never `justWritten`'s, so a lone record at its own bound stays), and the oldest stubs past theirs dropped.
   * The index is written last. Answers the conversations of the entries it evicted or dropped.
   */
  readonly settle: (
    entries: ReadonlyArray<CallRecordEntry<Own>>,
    justWritten: string | undefined,
  ) => Set<string>;
  /** Write `entries` with `entry` as the most recently mounted, as of `mountedAt`; nothing else changes. */
  readonly touch: (
    entries: ReadonlyArray<CallRecordEntry<Own>>,
    entry: CallRecordEntry<Own>,
    mountedAt: number,
  ) => void;
};

export const callRecords = <Own extends object>(
  options: CallRecordsOptions<Own>,
): CallRecords<Own> => {
  type Entry = CallRecordEntry<Own>;

  const { storage, indexKey, partKey, bounds } = options;

  const index = (): ReadonlyArray<Entry> => storage.get<ReadonlyArray<Entry>>(indexKey) ?? [];

  const read = (entry: Entry): string =>
    Arr.join(
      Arr.makeBy(entry.parts, (part) => storage.get<string>(partKey(entry.callId, part)) ?? ""),
      "",
    );

  const dropParts = (entry: Entry) => {
    for (let part = 0; part < entry.parts; part++) storage.delete(partKey(entry.callId, part));

    for (const key of options.alsoKeys?.(entry.callId) ?? []) storage.delete(key);
  };

  const stubOf = (call: CallRecordStub<Own>): Entry => ({
    ...call,
    state: "evicted",
    bytes: 0,
    parts: 0,
  });

  const evict = (entries: ReadonlyArray<Entry>, entry: Entry): ReadonlyArray<Entry> => {
    dropParts(entry);

    const stub = stubOf({
      ...options.keeps(entry),
      callId: entry.callId,
      conversation: entry.conversation,
      mountedAt: entry.mountedAt,
    });

    return Arr.map(entries, (each) => (each.callId === entry.callId ? stub : each));
  };

  const stub = (entries: ReadonlyArray<Entry>, call: CallRecordStub<Own>): ReadonlyArray<Entry> => {
    const old = Arr.findFirst(entries, (entry) => entry.callId === call.callId);

    if (Option.isSome(old)) dropParts(old.value);

    return [...Arr.filter(entries, (entry) => entry.callId !== call.callId), stubOf(call)];
  };

  const write = (
    entries: ReadonlyArray<Entry>,
    callId: string,
    text: string,
    entryOf: (parts: number) => Entry,
  ): ReadonlyArray<Entry> => {
    const old = Arr.findFirst(entries, (entry) => entry.callId === callId);

    if (Option.isSome(old)) dropParts(old.value);

    const count = Math.max(1, Math.ceil(text.length / PART_LENGTH));

    for (let part = 0; part < count; part++) {
      storage.put(partKey(callId, part), text.slice(part * PART_LENGTH, (part + 1) * PART_LENGTH));
    }

    const entry = entryOf(count);

    return Option.isSome(old)
      ? Arr.map(entries, (each) => (each.callId === callId ? entry : each))
      : [...entries, entry];
  };

  const settle = (entries: ReadonlyArray<Entry>, justWritten: string | undefined) => {
    let next = entries;
    const touched = new Set<string>();
    const kept = () => Arr.filter(next, (entry) => entry.state === "kept");
    const bytes = () => Arr.reduce(kept(), 0, (sum, entry) => sum + entry.bytes);

    while (bytes() > bounds.bytes || kept().length > bounds.records) {
      let oldest: Entry | undefined;

      for (const entry of kept()) {
        if (
          entry.callId !== justWritten &&
          (oldest === undefined || entry.mountedAt < oldest.mountedAt)
        ) {
          oldest = entry;
        }
      }

      if (oldest === undefined) break;

      touched.add(oldest.conversation);
      next = evict(next, oldest);
    }

    let excess = Arr.filter(next, (entry) => entry.state === "evicted").length - bounds.stubs;

    if (excess > 0) {
      // The stubs oldest in the index first.
      next = Arr.filter(next, (entry) => {
        if (entry.state !== "evicted" || excess <= 0) return true;

        excess -= 1;
        touched.add(entry.conversation);

        return false;
      });
    }

    storage.put(indexKey, next);

    return touched;
  };

  const touch = (entries: ReadonlyArray<Entry>, entry: Entry, mountedAt: number) => {
    storage.put(
      indexKey,
      Arr.map(entries, (each) => (each.callId === entry.callId ? { ...entry, mountedAt } : each)),
    );
  };

  return { index, read, write, evict, stub, settle, touch };
};
