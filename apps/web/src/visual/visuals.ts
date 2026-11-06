// docs/architecture/visuals.md → The copy (Revisions), Socket messages. The Session's Visuals arrive by conversation
// (`SessionState.visuals`); what reads them wants one call wherever it was made, a script's, or which of a thread's are
// superseded. Pure: the transcript's messages and the entries go in.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain decisions over small native lists.
import { sourcePathOf, type TranscriptMessage, type VisualEntry } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

/** The Session's Visuals by conversation, as its state keeps them. */
export type Visuals = Readonly<Record<string, ReadonlyArray<VisualEntry>>>;

/** Every conversation's Visuals in one list. */
export const visualEntries = (visuals: Visuals): ReadonlyArray<VisualEntry> =>
  Arr.flatten(Record.values(visuals));

/** The Visual call `callId` showed, in whichever conversation; undefined when the Session has none. */
export const visualEntryOf = (visuals: Visuals, callId: string): VisualEntry | undefined =>
  Arr.findFirst(visualEntries(visuals), (entry) => entry.callId === callId).pipe(
    Option.getOrUndefined,
  );

/**
 * Whether the Session has sent the Visuals of `conversation` (undefined: the root thread's, which is the active branch's, null
 * until the Session says): a call with no Visual in a list that came is one the Session keeps none of, and in one that has not
 * come is one it may yet send.
 */
export const visualsListed = (
  visuals: Visuals,
  conversation: number | null | undefined,
  activeBranch: number | null,
): boolean => {
  const id = conversation ?? activeBranch;

  return id !== null && Record.has(visuals, String(id));
};

/** The Visuals a `codemode` script showed (`parentCall` is its call), oldest first. */
export const visualsOfScript = (
  entries: ReadonlyArray<VisualEntry>,
  scriptCallId: string,
): ReadonlyArray<VisualEntry> => entries.filter((entry) => entry.parentCall === scriptCallId);

/** No Visual is superseded: what a thread with none, or with no file shown twice, gives. */
export const NO_SUPERSEDED: ReadonlyMap<string, string> = new Map();

/**
 * The Visuals of a thread that a newer one from the same file supersedes, each to the one right after it
 * (`docs/architecture/visuals.md` → The copy: Revisions): worked out from the transcript, so a Fork, a branch move or an
 * older page reads the same. A Visual is placed by the tool call that showed it, or by its script's for a nested one, and
 * within one script by the time it was shown; an entry whose call is not in `messages` (a branch not shown, History not
 * loaded) is no revision of anything here. An inline page supersedes nothing.
 */
export const supersededIn = (
  messages: ReadonlyArray<Pick<TranscriptMessage, "parts">>,
  entries: ReadonlyArray<VisualEntry>,
): ReadonlyMap<string, string> => {
  if (entries.length < 2) return NO_SUPERSEDED;

  // Where each tool call is in the transcript, in order of the messages and their parts.
  const positionOf = new Map<string, number>();
  let position = 0;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-call") positionOf.set(part.id, position++);
    }
  }

  const placed = entries.flatMap((entry, order) => {
    const at = positionOf.get(entry.parentCall ?? entry.callId);
    const path = sourcePathOf(entry.source);

    return at === undefined || path === undefined ? [] : [{ entry, order, at, path }];
  });

  placed.sort((a, b) => a.at - b.at || a.entry.at - b.entry.at || a.order - b.order);

  const superseded = new Map<string, string>();
  const latest = new Map<string, string>();

  for (let index = placed.length - 1; index >= 0; index--) {
    const each = placed[index];

    if (each === undefined) continue;

    const newer = latest.get(each.path);

    if (newer !== undefined) superseded.set(each.entry.callId, newer);

    latest.set(each.path, each.entry.callId);
  }

  return superseded.size === 0 ? NO_SUPERSEDED : superseded;
};

/** Whether two supersession maps say the same: an atom that compares by it does not redraw a card per token. */
export const sameSuperseded = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
