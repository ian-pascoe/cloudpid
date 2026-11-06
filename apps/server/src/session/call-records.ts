// The chunked-record primitive under the Session's per-call stores (`docs/architecture/visuals.md` → The copy: The store;
// `docs/architecture/mcp-apps.md` → App records): the App record store (`./mcp-apps-store.ts`) and Visuals' store sit on it.
// A call's record is text, kept in this object's key-value storage in parts of at most `PART_LENGTH` characters, with an
// index of every record and stub, oldest first, under one key, written last of everything a change touches. Past its bounds
// (bytes kept, records kept, stubs kept) the least recently mounted record is evicted to a stub (a call's entry that holds
// no data), never the one just written, and the oldest stubs are dropped. Everything here is synchronous, so a write is
// one run that no reader sees half of; a store decides what a record is (its JSON, its redaction, its bounds, its entry's
// fields), never how it is kept. A replaced instance's storage refuses every operation (`refusingStorage`), so a write it cuts
// has put no index: the index lists what it did before, a call new to it stays unlisted, and a listed record whose parts the
// cut dropped or half rewrote does not parse, which a store reads as a stub.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { SessionKv } from "./session-kv.ts";

/** The most characters one stored value holds: a record's text over it is kept in parts. */
export const PART_LENGTH = 256 * 1024;

/**
 * What the index holds for a call, whatever a store adds to it: a record's (`kept`, with its size and parts) or a stub's
 * (`evicted`, with none). `mountedAt` orders the eviction.
 */
export type CallRecordEntry = {
  readonly callId: string;
  readonly conversation: string;
  readonly state: "kept" | "evicted";
  readonly bytes: number;
  readonly parts: number;
  readonly mountedAt: number;
};

export type CallRecordsOptions<E extends CallRecordEntry> = {
  readonly storage: SessionKv;
  /** Where the index is kept. */
  readonly indexKey: string;
  /** Where part `part` of call `callId`'s record is kept. */
  readonly partKey: (callId: string, part: number) => string;
  /** Other values kept for a call (an audit log), deleted with its parts. */
  readonly alsoKeys?: (callId: string) => ReadonlyArray<string>;
  /** The most bytes of records kept, the most records kept, and the most stubs kept. */
  readonly bounds: { readonly bytes: number; readonly records: number; readonly stubs: number };
  /** The entry a record is left as when it is evicted: the same call, `state: "evicted"`, no bytes or parts, its `mountedAt`. */
  readonly evicted: (entry: E) => E;
};

export type CallRecords<E extends CallRecordEntry> = {
  /** Every record and stub, oldest first. */
  readonly index: () => ReadonlyArray<E>;
  /** A kept record's text, put back together; a part that is gone reads as nothing, so the text will not parse. */
  readonly text: (entry: E) => string;
  /**
   * `entries` with `text` kept as call `callId`'s record, replacing an earlier one (its parts dropped first), and `kept`'s
   * entry (given the number of parts) in place of the earlier entry, or last. The parts are written; the index is not.
   */
  readonly write: (
    entries: ReadonlyArray<E>,
    callId: string,
    text: string,
    kept: (parts: number) => E,
  ) => ReadonlyArray<E>;
  /** `entries` with `entry`'s parts and its other values dropped and the entry a stub. The index is not written. */
  readonly evict: (entries: ReadonlyArray<E>, entry: E) => ReadonlyArray<E>;
  /** Drop what is kept of `entry`: its parts and its other values. */
  readonly dropParts: (entry: E) => void;
  /**
   * Write `entries` as the index after the bounds held: the least recently mounted record past the byte and record bounds
   * is evicted (never `keep`'s, the one just written, so a lone record at its own bound stays), and the oldest stubs past
   * theirs dropped. The index is written last. Answers the conversations of the entries it evicted or dropped.
   */
  readonly settle: (entries: ReadonlyArray<E>, keep: string | undefined) => Set<string>;
  /** Write `entries` with `entry` as the most recently mounted, as of `mountedAt`; nothing else changes. */
  readonly touch: (entries: ReadonlyArray<E>, entry: E, mountedAt: number) => void;
};

export const callRecords = <E extends CallRecordEntry>(
  options: CallRecordsOptions<E>,
): CallRecords<E> => {
  const { storage, indexKey, partKey, bounds } = options;

  const index = (): ReadonlyArray<E> => storage.get<ReadonlyArray<E>>(indexKey) ?? [];

  const text = (entry: E): string =>
    Arr.join(
      Arr.makeBy(entry.parts, (part) => storage.get<string>(partKey(entry.callId, part)) ?? ""),
      "",
    );

  const dropParts = (entry: E) => {
    for (let part = 0; part < entry.parts; part++) storage.delete(partKey(entry.callId, part));

    for (const key of options.alsoKeys?.(entry.callId) ?? []) storage.delete(key);
  };

  const evict = (entries: ReadonlyArray<E>, entry: E): ReadonlyArray<E> => {
    dropParts(entry);

    return Arr.map(entries, (each) =>
      each.callId === entry.callId ? options.evicted(entry) : each,
    );
  };

  const write = (
    entries: ReadonlyArray<E>,
    callId: string,
    value: string,
    kept: (parts: number) => E,
  ): ReadonlyArray<E> => {
    const old = Arr.findFirst(entries, (entry) => entry.callId === callId);

    if (Option.isSome(old)) dropParts(old.value);

    const count = Math.max(1, Math.ceil(value.length / PART_LENGTH));

    for (let part = 0; part < count; part++) {
      storage.put(partKey(callId, part), value.slice(part * PART_LENGTH, (part + 1) * PART_LENGTH));
    }

    const entry = kept(count);

    return Option.isSome(old)
      ? Arr.map(entries, (each) => (each.callId === callId ? entry : each))
      : [...entries, entry];
  };

  const settle = (entries: ReadonlyArray<E>, keep: string | undefined) => {
    let next = entries;
    const touched = new Set<string>();
    const kept = () => Arr.filter(next, (entry) => entry.state === "kept");
    const bytes = () => Arr.reduce(kept(), 0, (sum, entry) => sum + entry.bytes);

    while (bytes() > bounds.bytes || kept().length > bounds.records) {
      let oldest: E | undefined;

      for (const entry of kept()) {
        if (entry.callId !== keep && (oldest === undefined || entry.mountedAt < oldest.mountedAt)) {
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

  const touch = (entries: ReadonlyArray<E>, entry: E, mountedAt: number) => {
    storage.put(
      indexKey,
      Arr.map(entries, (each) => (each.callId === entry.callId ? { ...entry, mountedAt } : each)),
    );
  };

  return { index, text, write, evict, dropParts, settle, touch };
};
