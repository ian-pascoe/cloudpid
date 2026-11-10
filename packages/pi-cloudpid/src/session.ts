// @effect-diagnostics preferEffectArray:off -- native array methods over plain values (the extension carries no Effect runtime).
/**
 * The active pi Session as the import sends it (docs/architecture/mcp-endpoint.md → Session import → Translation): the
 * file's header line and the active branch's entries (`getBranch()`), one `JSON.stringify` per line, byte-identical to
 * the file pi writes.
 */
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { IMPORT_MARKER } from "./constants.ts";
import { isJson, stringField, toObject } from "./json.ts";

/** What of pi's `ReadonlySessionManager` the import reads. */
export interface SessionSource {
  readonly getSessionId: () => string;
  readonly getSessionFile: () => string | undefined;
  readonly getSessionName: () => string | undefined;
  readonly getHeader: () => SessionHeader | null;
  readonly getBranch: () => Array<SessionEntry>;
}

/** An earlier import of this Session, left by `/cloudpid` (`pi.appendEntry("cloudpid-import", …)`). */
export interface ImportMarker {
  readonly url: string;
  readonly branch: string | undefined;
}

export interface SessionSnapshot {
  readonly id: string;
  /** The Session's file; none for a Session pi keeps in memory. */
  readonly file: string | undefined;
  readonly name: string | undefined;
  /** The import's text: the header line and the branch's entries, each line ending in a newline. */
  readonly text: string;
  readonly entries: number;
  /** The first user message's text, for a branch name when the Session has no title. */
  readonly firstMessage: string | undefined;
  /** The last `cloudpid-import` marker on the branch. */
  readonly marker: ImportMarker | undefined;
}

const firstUserText = (entries: ReadonlyArray<SessionEntry>): string | undefined => {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;

    const { content } = entry.message;

    if (!Array.isArray(content)) return content;

    for (const part of content) {
      if (part.type === "text") return part.text;
    }
  }

  return undefined;
};

const markerOf = (entries: ReadonlyArray<SessionEntry>): ImportMarker | undefined => {
  let found: ImportMarker | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== IMPORT_MARKER) continue;

    const data = toObject(isJson(entry.data) ? entry.data : undefined);
    const url = data === undefined ? undefined : stringField(data, "url");

    if (data !== undefined && url !== undefined)
      found = { url, branch: stringField(data, "branch") };
  }

  return found;
};

/** The Session as it is now. */
export const snapshotOf = (source: SessionSource): SessionSnapshot => {
  const header = source.getHeader();
  const branch = source.getBranch();
  const lines = header === null ? [] : [JSON.stringify(header)];

  for (const entry of branch) lines.push(JSON.stringify(entry));

  return {
    id: source.getSessionId(),
    file: source.getSessionFile(),
    name: source.getSessionName(),
    text: lines.map((line) => `${line}\n`).join(""),
    entries: branch.length,
    firstMessage: firstUserText(branch),
    marker: markerOf(branch),
  };
};
