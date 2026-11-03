// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off globalDate:off -- plain functions over lines of JSON and a few counts.
// The seam a Session import translates through (`docs/architecture/mcp-endpoint.md` → Session import → Translation): the
// raw pi file, as lines, becomes entries for the root conversation (the import notice last) and the counts of what was
// cut, dropped and closed. `translatePiSession` is the baseline this slice ships so the channel works end to end: it maps
// the three message roles and counts every other kind as dropped. The translator ticket (#474: extension state, bounds,
// dangling calls, compaction, the provider probes) replaces its body behind this signature.
import type { ImportRepo, ImportSummary } from "@cloudpid/protocol";
import type { Message } from "@earendil-works/pi-ai";
import { type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** What the translation knows of where the import lands, besides the file: the Workspace, and what was decided about the model. */
export type ImportFacts = {
  readonly branch: string;
  readonly repos: ReadonlyArray<ImportRepo>;
  /** The model fallback, as warnings the notice repeats. */
  readonly warnings: ReadonlyArray<string>;
};

/** What a translation made: the root conversation's entries, oldest first, with the notice last. */
export type Translation = {
  readonly entries: ReadonlyArray<EntryRecord>;
  readonly summary: ImportSummary;
};

/** A file that cannot be translated: why, as one sentence for the Local agent. */
export type TranslationFailure = { readonly failed: string };

export type ImportTranslator = (
  lines: Iterable<string>,
  facts: ImportFacts,
) => Translation | TranslationFailure;

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  cwd: Schema.optionalKey(Schema.String),
});

const Line = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.Struct({ role: Schema.String })),
});

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

/** The kind of the entry a message of `role` becomes, or none for a role this translation does not carry. */
const kindOf = (role: string): string | undefined => {
  switch (role) {
    case "user":
      return "pi.user";
    case "assistant":
      return "pi.assistant";
    case "toolResult":
      return "pi.tool-result";
    default:
      return undefined;
  }
};

/** The import notice: one model-visible user message, always the last entry. */
export const importNotice = (
  facts: ImportFacts,
  cwd: string | undefined,
  summary: ImportSummary,
): string => {
  const dropped = Arr.reduce(Object.values(summary.dropped), 0, (sum, count) => sum + count);

  const where =
    facts.repos.length === 0
      ? "a cloudpid Workspace"
      : `a cloudpid Workspace on branch \`${facts.branch}\` (${Arr.join(
          Arr.map(facts.repos, (repo) => `${repo.name} at ${repo.directory}`),
          ", ",
        )})`;

  return Arr.join(
    [
      `[cloudpid import] This conversation was imported from a pi Session on the owner's laptop${cwd === undefined ? "" : ` (working directory ${cwd})`}. It continues in ${where}; commands that ran on the laptop cannot be run here.`,
      ...facts.warnings,
      `The import cut ${String(summary.cut)}, dropped ${String(dropped)} and closed ${String(summary.closed)} entries.`,
      `The owner brings work back with \`git pull\` on \`${facts.branch}\`: commit and push your work there when you finish.`,
    ],
    " ",
  );
};

/** The baseline translation: messages as they are, everything else dropped and counted by its kind. */
export const translatePiSession: ImportTranslator = (lines, facts) => {
  const entries: EntryRecord[] = [];
  const dropped: Record<string, number> = {};
  let header: { readonly cwd?: string } | undefined;
  let number = 0;

  for (const line of lines) {
    number += 1;

    if (line.trim() === "") continue;

    if (header === undefined) {
      const first = decodeHeader(line);

      if (Option.isNone(first)) {
        return { failed: "The file does not start with a pi session header line." };
      }

      header = first.value;

      continue;
    }

    const parsed = decodeLine(line);

    if (Option.isNone(parsed)) return { failed: `Line ${String(number)} is not a pi entry.` };

    const { type, message } = parsed.value;
    const kind = message === undefined ? undefined : kindOf(message.role);

    if (type !== "message" || message === undefined || kind === undefined) {
      const name = type === "message" ? `message:${message?.role ?? "unknown"}` : type;

      dropped[name] = (dropped[name] ?? 0) + 1;

      continue;
    }

    // SAFETY: `line` is the JSON of an entry whose `message` is a pi-ai message of one of the three roles.
    const { message: content } = JSON.parse(line) as { readonly message: Message };

    entries.push(entryOf(entries.length + 1, kind, content));
  }

  if (header === undefined) return { failed: "The file is empty." };

  const summary: ImportSummary = { cut: 0, dropped, closed: 0 };

  entries.push(
    entryOf(entries.length + 1, "pi.user", {
      role: "user",
      content: [{ type: "text", text: importNotice(facts, header.cwd, summary) }],
      timestamp: Date.now(),
    }),
  );

  return { entries, summary };
};

/** An entry of the root conversation, with the ID the copy will renumber. */
const entryOf = (id: number, kind: string, message: Message): EntryRecord => {
  const base = {
    // SAFETY: an ID of this translation's own; the fill renumbers every one (`copiedDraft`).
    id: id as EntryId,
    conversationId: ROOT_CONVERSATION_ID,
    kind,
    model: [message],
  };

  const record = kind === "pi.tool-result" ? { ...base, data: { diagnostics: [] } } : base;

  // SAFETY: `message` is a pi-ai message of the role `kind` names, as pi wrote it.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return record as unknown as EntryRecord;
};

/** Whether `translation` is one, not a failure. */
export const translated = (
  translation: Translation | TranslationFailure,
): translation is Translation => !Predicate.hasProperty(translation, "failed");
