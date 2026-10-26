// What the composer asks of the page and the Session besides its text: whether the screen is wide, the clipboard for
// `/copy`, and the Session's own Slash commands, whose file (`/export`) it hands the owner as a download; and one
// composer's own state: where its caret is, which menu it shows, the note under it, and the draft's first message when
// the Session refused it.

import type { CommandOutcome } from "@cloudpid/protocol";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { replying } from "../calls.ts";
import { refusedFirstMessagesAtom } from "../draft-state.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { addAttachmentsAtom } from "./attachments-state.ts";
import { askCatalogAtom } from "./catalog.ts";
import { detectTrigger, type Trigger } from "./completion.ts";
import type { ConversationKey } from "./conversation.ts";
import { searchFilesAtom } from "./file-search.ts";
import { composerPrefillAtom } from "./tree-state.ts";

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
  replying((text: string) =>
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;

      yield* clipboard.writeString(text);
    }),
  ),
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
    replying(({ name, args }: CommandCall, get: Atom.FnContext) =>
      get.result(sessionClientAtom(key.sessionId)).pipe(
        Effect.flatMap((client) => client.command(name, args, key.conversationId)),
        Effect.tap((outcome) =>
          outcome.file === undefined ? Effect.void : download(outcome.file),
        ),
        Effect.map((outcome) => outcome.notice ?? null),
      ),
    ),
    { concurrent: true },
  ),
);

/** A line under the composer: why a command failed, or what one did. */
export type Note = { readonly tone: "error" | "info"; readonly text: string };

/** Where a composer's menus get what they list: the `@` menu's file search, and the catalog. */
export interface ComposerLookups {
  /** Say what the `@` menu shows now (`searchFilesAtom`): its query, or null while it is closed. */
  readonly searchFiles: Atom.Writable<unknown, string | null>;
  /** Ask for the catalog, unless it is fresh (`askCatalogAtom`). */
  readonly askCatalog: Atom.Writable<unknown, void>;
}

/** The lookups of a conversation's composer: its Session's answers about the conversation's directory. */
export const conversationLookups = (key: ConversationKey): ComposerLookups => ({
  searchFiles: searchFilesAtom(key),
  askCatalog: askCatalogAtom(key),
});

/**
 * What one composer's state is built from: the text its store holds (assistant-ui's, or the draft's), the input that
 * shows it, the conversation, and where its menus look.
 */
export interface ComposerSource {
  /** The conversation the composer writes to; none for the draft's, whose Session is not made yet. */
  readonly key?: ConversationKey | undefined;
  /** Where its menus' catalog and files come from: the conversation's (`conversationLookups`), or the draft's. */
  readonly lookups: ComposerLookups;
  /** The text the store holds. */
  readonly text: () => string;
  /** Hear every change of the store; returns how to stop. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The input, while it is rendered. */
  readonly input: () => { readonly value: string; readonly selectionStart: number } | null;
  /** Put `text` in the store. */
  readonly setText: (text: string) => void;
}

/** One composer's state, as atoms. */
export interface ComposerState {
  /** assistant-ui's text, as it changes. */
  readonly text: Atom.Atom<string>;
  readonly caret: Atom.Writable<number>;
  readonly focused: Atom.Writable<boolean>;
  /** Why a command failed, or what one did; cleared as the owner edits the text. */
  readonly note: Atom.Writable<Note | null>;
  /** Whether a command is running. */
  readonly busy: Atom.Writable<boolean>;
  /** What is being completed at the caret, while the input has the focus. */
  readonly trigger: Atom.Atom<Trigger | null>;
  /** The start of a trigger the owner dismissed with Escape: its menu stays closed until the trigger moves or goes. */
  readonly dismissed: Atom.Writable<number | null>;
  /** The highlighted row's id; a new menu, or a changed query, starts from its first row. */
  readonly highlighted: Atom.Writable<string | null>;
  /** What the `@` menu searches for, or null while it is closed. */
  readonly fileQuery: Atom.Atom<string | null>;
  /**
   * While mounted, the `@` menu's query goes to the composer's file search, and a menu that lists the catalog asks for
   * it as it opens (the catalog asks again only once it is stale). The root's composer takes back its Session's
   * first message when the Session refused it (`refusedFirstMessagesAtom`), before what was typed since, with why as
   * the note, as a refused message with Attachments comes back; and the owner's message the active branch moved to
   * before, or a Fork was made before (`composerPrefillAtom`).
   */
  readonly effects: Atom.Atom<void>;
}

/**
 * The state of the composer `source` describes. An edit that the input shows already is the owner's: its caret is the
 * input's, read once assistant-ui holds the text (an update before that would render the input with the old text, which
 * puts the caret at its end), and it clears the note. A text the composer sets itself (a pick, a command clearing it)
 * keeps both.
 */
export const composerState = (source: ComposerSource): ComposerState => {
  const caret = Atom.make(0);
  const note = Atom.make<Note | null>(null);

  const text = Atom.readable((get) => {
    get.addFinalizer(
      source.subscribe(() => {
        const now = source.text();

        if (Option.getOrUndefined(get.self<string>()) === now) return;

        const input = source.input();

        Atom.batch(() => {
          if (input?.value === now) {
            get.set(caret, input.selectionStart);
            get.set(note, null);
          }

          get.setSelf(now);
        });
      }),
    );

    return source.text();
  });

  const focused = Atom.make(false);

  const trigger = Atom.make((get) => {
    // Read whether or not the input has the focus, so the text and caret follow the owner's edits all along.
    const now = get(text);
    const at = get(caret);

    return get(focused) ? detectTrigger(now, at) : null;
  });

  const dismissed = Atom.writable(
    (get): number | null => {
      const start = get(trigger)?.start;
      const held = Option.getOrNull(get.self<number | null>());

      return held !== null && held === start ? held : null;
    },
    (ctx, start: number | null) => {
      ctx.setSelf(start);
    },
  );

  const menuKey = Atom.map(trigger, (current) =>
    current === null ? "" : `${current.kind}:${current.start}:${current.query}`,
  );

  const highlighted = Atom.writable(
    (get): string | null => {
      get(menuKey);

      return null;
    },
    (ctx, id: string | null) => {
      ctx.setSelf(id);
    },
  );

  const fileQuery = Atom.make((get) => {
    const current = get(trigger);

    return current?.kind === "file" && current.start !== get(dismissed) ? current.query : null;
  });

  const listsCatalog = Atom.map(
    trigger,
    (current) => current?.kind === "command" || current?.kind === "skill",
  );

  const effects = Atom.readable((get) => {
    const { searchFiles: search, askCatalog } = source.lookups;

    get.mount(search);
    get.mount(askCatalog);
    get.mount(fileQuery);
    get.mount(listsCatalog);
    get.subscribe(fileQuery, (query) => {
      get.set(search, query);
    });
    get.subscribe(listsCatalog, (lists) => {
      if (lists) get.set(askCatalog, undefined);
    });

    const { key } = source;

    if (key === undefined || key.conversationId !== undefined) return;

    const { sessionId } = key;

    // Where a refused first message's files go back to.
    get.mount(addAttachmentsAtom(key));

    get.subscribe(
      refusedFirstMessagesAtom,
      (refused) => {
        const { [sessionId]: message, ...others } = refused;

        if (message === undefined) return;

        const since = source.text();

        Atom.batch(() => {
          get.set(refusedFirstMessagesAtom, others);
          source.setText(since.trim() === "" ? message.text : `${message.text}\n\n${since}`);
          get.set(note, { tone: "error", text: message.reason });

          if (message.files !== undefined && message.files.length > 0) {
            get.set(addAttachmentsAtom(key), message.files);
          }
        });
      },
      { immediate: true },
    );

    // The owner's message the active branch moved to before, or a Fork was made before, ahead of what was typed.
    get.subscribe(
      composerPrefillAtom,
      (prefills) => {
        const { [sessionId]: text, ...others } = prefills;

        if (text === undefined) return;

        const since = source.text();

        Atom.batch(() => {
          get.set(composerPrefillAtom, others);
          source.setText(since.trim() === "" ? text : `${text}\n\n${since}`);
        });
      },
      { immediate: true },
    );
  });

  return {
    text,
    caret,
    focused,
    note,
    busy: Atom.make(false),
    trigger,
    dismissed,
    highlighted,
    fileQuery,
    effects,
  };
};
