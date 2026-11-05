// `entries`: a page of a conversation's transcript, for a client's transcript to load the entries before the oldest it
// holds and those a gap is missing (docs/architecture/client-and-protocol.md → Session socket).
// @effect-diagnostics missingPipeableSignature:off -- a page in, a page out.
import { WATCH_IMAGES, limitEntryImages } from "@cloudpid/extensions/browser";
import { type EntriesPage, MAX_ENTRIES_PAGE_BYTES } from "@cloudpid/protocol";
import type { Cursor, EntryRecord, Page, ScanOrder } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";

/** The length of `entry` as JSON, in UTF-16 code units: about the bytes it adds to the socket message. */
const jsonLength = (entry: EntryRecord): number => JSON.stringify(entry).length;

/** A continuation a page cut short by its bytes says it has; the client never sends it back. */
const MORE: Cursor = {};

/**
 * `page`, read in `order`, as one socket message: its screenshots bounded (`WATCH_IMAGES`, the newest kept), and its
 * entries kept until they pass `MAX_ENTRIES_PAGE_BYTES` of JSON (the one that passes it is kept, so a page always holds
 * one). A page cut short keeps a `next`, so the client asks again from the entry after its last.
 */
export const entriesPage = (page: Page<EntryRecord, Cursor>, order: ScanOrder): EntriesPage => {
  const items =
    order === "ascending"
      ? limitEntryImages(page.items, WATCH_IMAGES)
      : Arr.reverse(limitEntryImages(Arr.reverse(page.items), WATCH_IMAGES));

  let bytes = 0;
  let kept = items.length;

  for (const [index, entry] of items.entries()) {
    bytes += jsonLength(entry);

    if (bytes >= MAX_ENTRIES_PAGE_BYTES) {
      kept = index + 1;

      break;
    }
  }

  const cut = kept < items.length;
  const next = cut ? (page.next ?? MORE) : page.next;
  const shown = cut ? items.slice(0, kept) : items;

  return next === undefined ? { items: shown } : { items: shown, next };
};
