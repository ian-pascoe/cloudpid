// What the composer asks of the page and the Session besides its text: whether the screen is wide, the clipboard for
// `/copy`, and the Session's own Slash commands, whose file (`/export`) it hands the owner as a download.

import type { CommandOutcome } from "@cloudpid/protocol";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "./conversation.ts";

const WIDE_QUERY = "(min-width: 640px)";

/** Whether the screen has room for the composer's long placeholder; on a phone it would wrap. */
export const wideAtom = Atom.readable((get) => {
  const query = window.matchMedia(WIDE_QUERY);

  const changed = () => {
    get.setSelf(query.matches);
  };

  query.addEventListener("change", changed);
  get.addFinalizer(() => {
    query.removeEventListener("change", changed);
  });

  return query.matches;
});

/** Put `text` on the clipboard (`/copy`); fails when the browser does not allow it. */
export const copyAtom = appRuntime.fn(
  (text: string) =>
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;

      yield* clipboard.writeString(text);
    }),
  { concurrent: true },
);

/** How long a download's link to its file is kept: Safari on iOS reads the file after the click returns. */
export const DOWNLOAD_LINK_MS = 30_000;

/** Hand the owner `file` as a download, as a link to it would; the link to its contents goes after a while. */
const download = (file: NonNullable<CommandOutcome["file"]>) =>
  Effect.sync(() => {
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
    const link = document.createElement("a");

    link.href = url;
    link.download = file.name;
    link.hidden = true;
    // In the document, as Safari clicks only a link that is.
    document.body.append(link);
    link.click();
    link.remove();

    return url;
  }).pipe(
    Effect.flatMap((url) =>
      Effect.sleep(DOWNLOAD_LINK_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            URL.revokeObjectURL(url);
          }),
        ),
        // Whatever becomes of the composer meanwhile.
        Effect.forkDetach,
      ),
    ),
    Effect.asVoid,
  );

/** A Session's Slash command, typed in a conversation's composer. */
export interface CommandCall {
  readonly name: string;
  readonly args: string;
}

/**
 * Run one of the Session's Slash commands on the conversation: what it says it did (a notice), or null; a file it
 * gives is handed to the owner as a download. Fails with why it could not run.
 */
export const sessionCommandAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn(
    ({ name, args }: CommandCall, get) =>
      get.result(sessionClientAtom(key.sessionId)).pipe(
        Effect.flatMap((client) => client.command(name, args, key.conversationId)),
        Effect.tap((outcome) =>
          outcome.file === undefined ? Effect.void : download(outcome.file),
        ),
        Effect.map((outcome) => outcome.notice ?? null),
      ),
    { concurrent: true },
  ),
);
