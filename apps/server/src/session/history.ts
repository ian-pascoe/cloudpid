// `history`: a page of a conversation's History before a given entry, for the transcript to show what its snapshot no
// longer holds once a Rollover or a compaction started a new Context Window (docs/spec.md → Client and protocol).
// @effect-diagnostics missingPipeableSignature:off -- a reader and an entry ID in, a page out.
import {
  type HistoryPage,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ENTRIES,
  projectEntry,
} from "@cloudpid/protocol";
import type { Cursor, EntryId, EntryRecord, Page } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";

/** How many entries a page reads from the storage at a time. */
const READ_SIZE = 50;

/** The length of `entry` as JSON, in UTF-16 code units: about the bytes it adds to the socket message. */
const jsonLength = (entry: EntryRecord): number => JSON.stringify(entry).length;

/** Read a page of the conversation's entries newest first, at most `limit`, no newer than `maxEntryId`. */
export type ReadEntries<E> = (
  maxEntryId: EntryId,
  limit: number,
  cursor: Cursor | undefined,
) => Effect.Effect<Page<EntryRecord, Cursor>, E>;

/**
 * The entries just before entry `before`, read newest first with `read` and answered oldest first: at most
 * `MAX_HISTORY_ENTRIES` read, and those a transcript shows kept until they pass `MAX_HISTORY_BYTES` of JSON (the one
 * that passes it is kept, so a page always holds what it read). `before` is the oldest entry read when more may be left.
 */
export const historyPage = <E>(
  read: ReadEntries<E>,
  before: number,
): Effect.Effect<HistoryPage, E> =>
  Effect.gen(function* () {
    const kept: EntryRecord[] = [];
    let count = 0;
    let bytes = 0;
    let oldest: number | undefined;
    let cursor: Cursor | undefined;
    let full = false;

    if (before <= 1) return { entries: [], before: null };

    // SAFETY: entry IDs are positive integers; `before` is one the client was given.
    const maxEntryId = (before - 1) as EntryId;

    do {
      const page = yield* read(
        maxEntryId,
        Math.min(READ_SIZE, MAX_HISTORY_ENTRIES - count),
        cursor,
      );

      cursor = page.next;

      for (const entry of page.items) {
        count += 1;
        oldest = entry.id;

        // System prompts and bookkeeping are not shown, and a system prompt is large.
        if (projectEntry(entry) === undefined) continue;

        kept.push(entry);
        bytes += jsonLength(entry);

        if (bytes >= MAX_HISTORY_BYTES) {
          full = true;

          break;
        }
      }
    } while (cursor !== undefined && !full && count < MAX_HISTORY_ENTRIES);

    const more = full || cursor !== undefined;

    return { entries: kept.reverse(), before: more && oldest !== undefined ? oldest : null };
  });
