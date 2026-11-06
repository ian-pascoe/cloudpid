// docs/architecture/visuals.md → The frame (The card, Lazy mounting), The copy (Revisions, Bounds), Lifecycle. What a
// `visual_show` call's card adds: its Visual, outside the card's disclosure, under the chrome "Visual · <title>", with
// Collapse, Copy HTML, Open file (for a `path` source) and Details; a collapsed row with Reopen (and "A newer version is
// below" for one a newer Visual of the same file supersedes); the evicted card; and, while the call streams, its progress.
// A `codemode` script's Visuals show in a strip under its card (`VisualStrip`), and a subagent's in its thread.
//
// Which place mounts a frame is `sandbox-frame/places.ts`'s, keyed `visual:`; a Visual has no teardown, so a place told to let
// its frame go lets it go at once. The frame mounts near the viewport only (`lazy.ts`), and is `visual-frame.tsx`'s.
// @effect-diagnostics missingPipeableSignature:off -- hooks over the Session's atoms, not combinators.
import {
  isKeptVisual,
  sourcePathOf,
  VISUAL_MIN_HEIGHT,
  type VisualEntry,
  type VisualFileAnswer,
  type VisualRecord,
} from "@cloudpid/protocol";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { formatSize } from "../chat/attachments.ts";
import {
  conversationKey,
  useShownLayoutKey,
  useShownSessionId,
  useThreadConversation,
  useThreadPlace,
} from "../chat/conversation.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { appPlaces, PLACE_NAMES, placeKey, type AppPlaces } from "../sandbox-frame/places.ts";
import { appChoiceAtom } from "../session-layout-state.ts";
import { keepsVisualsAtom, sessionClientAtom, visualsAtom } from "../session/atoms.ts";
import {
  type VisualLoad,
  visualHeightAtom,
  visualKey,
  visualLoadAtom,
  visualSupersededAtom,
} from "./atoms.ts";
import { shouldMount, useNearViewport } from "./lazy.ts";
import { VisualFailed, VisualFrame } from "./visual-frame.tsx";
import { visualEntries, visualEntryOf, visualsOfScript } from "./visuals.ts";

/** The places of this page: the app's, shared with App Views under their own keys. A test gives its own. */
export const VisualPlacesContext = createContext<AppPlaces>(appPlaces);

/** What a card reads while it wants no page: nothing is loaded. */
const NO_LOAD = Atom.make(AsyncResult.initial<VisualLoad>());

/** Where the call is when its card is drawn, for one that has not finished: streaming or running, with its title so far. */
export interface VisualProgress {
  readonly phase: "streaming" | "running" | "stopped";
  readonly title?: string | undefined;
}

/** The time a Visual was shown, as a line says it. */
const timeOf = (at: number) => {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(at));

  return (
    <time dateTime={iso}>
      {iso.slice(0, 10)} {iso.slice(11, 16)} UTC
    </time>
  );
};

/** The chrome of every state of a Visual's card: "Visual · <title>", then what the state adds on the right. */
const Chrome = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
    <span className="text-foreground">Visual</span>
    <span>·</span>
    <span className="min-w-0 truncate">{title}</span>
    <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span>
  </div>
);

/** One of the header's text buttons. */
const HeaderButton = ({
  onClick,
  expanded,
  disabled,
  children,
}: {
  onClick: () => void;
  expanded?: boolean;
  disabled?: boolean;
  children: string;
}) => (
  <button
    type="button"
    className="rounded-sm px-1 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
    aria-expanded={expanded}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);

/** Where a Visual's page came from, as a line says it. */
const sourceText = (entry: Pick<VisualEntry, "source">): string =>
  sourcePathOf(entry.source) ?? "Written inline by the call";

/**
 * The card's details: the source, size, time, warnings, origin and summary, and that the page was written by the agent.
 * The warnings and origin are the page's, there once it has loaded.
 */
export const VisualDetails = ({
  entry,
  record,
  origin,
}: {
  entry: VisualEntry;
  record?: VisualRecord | undefined;
  origin?: string | undefined;
}) => (
  <div className="space-y-1 border-t px-2 py-1.5 text-xs" data-visual-details="">
    <div>Written by the agent: what it shows is the agent's, not cloudpid's.</div>
    <div>
      <span className="text-muted-foreground">Summary: </span>
      {entry.summary}
    </div>
    <div>
      <span className="text-muted-foreground">Source: </span>
      <span className="font-mono break-all">{sourceText(entry)}</span>
    </div>
    <div>
      <span className="text-muted-foreground">Size: </span>
      {formatSize(entry.bytes)} <span className="text-muted-foreground">· Shown </span>
      {timeOf(entry.at)}
    </div>
    {origin !== undefined && (
      <div>
        <span className="text-muted-foreground">Served from </span>
        <span className="font-mono break-all">{origin}</span>
      </div>
    )}
    {record !== undefined && record.warnings.length > 0 && (
      <div>
        <div className="text-muted-foreground">Warnings at the show</div>
        <ul className="list-disc pl-4">
          {Arr.map(record.warnings, (warning, index) => (
            <li key={index}>{warning.message}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

/** What Open file shows: the file as it is now, or why it cannot. */
const fileText = (answer: VisualFileAnswer): string | undefined => {
  switch (answer.status) {
    case "missing":
      return "The file is no longer there.";
    case "too_large":
      return "The file is now larger than the 2 MiB a Visual may be.";
    case "not_text":
      return "The file is no longer UTF-8 text.";
    case "text":
      return undefined;
    default:
      return "There is no file to open.";
  }
};

/** Open file: the file a Visual was shown from, as it is now, read when the dialog opens. */
const OpenFile = ({ sessionId, entry }: { sessionId: string; entry: VisualEntry }) => {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<VisualFileAnswer | { status: "loading" } | undefined>();
  const client = useAtomValue(sessionClientAtom(sessionId));
  const path = sourcePathOf(entry.source);

  if (path === undefined) return null;

  const read = () => {
    setOpen(true);
    setAnswer({ status: "loading" });

    if (!AsyncResult.isSuccess(client)) {
      setAnswer({ status: "missing", path });

      return;
    }

    void Effect.runPromise(
      client.value
        .visualFile(entry.callId)
        .pipe(Effect.orElseSucceed((): VisualFileAnswer => ({ status: "missing", path }))),
    ).then(setAnswer);
  };

  return (
    <>
      <HeaderButton onClick={read}>Open file</HeaderButton>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="The file as it is now"
        description={<span className="font-mono break-all">{path}</span>}
        className="max-w-3xl"
      >
        {answer?.status === "loading" ? (
          <div className="text-xs text-muted-foreground">Reading the file…</div>
        ) : answer?.status === "text" && "text" in answer ? (
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
            {answer.text}
          </pre>
        ) : answer !== undefined ? (
          <div className="text-xs text-muted-foreground">{fileText(answer)}</div>
        ) : null}
      </Dialog>
    </>
  );
};

/** A Visual that was evicted: everything its card shows without the page, with Open file for a `path` source. */
export const VisualEvicted = ({ sessionId, entry }: { sessionId: string; entry: VisualEntry }) => (
  <div className="my-2 overflow-hidden rounded-md border border-dashed" data-visual={entry.callId}>
    <Chrome title={entry.title}>
      <span>no longer kept</span>
      <OpenFile sessionId={sessionId} entry={entry} />
    </Chrome>
    <div className="space-y-0.5 px-3 pb-2 text-xs">
      <div>{entry.summary}</div>
      <div className="text-muted-foreground">
        <span className="font-mono break-all">{sourceText(entry)}</span> · {formatSize(entry.bytes)}{" "}
        · {timeOf(entry.at)}
      </div>
    </div>
  </div>
);

/** A Visual that is collapsed: its title, why (a newer version of the same file is below), and Reopen. */
export const VisualCollapsed = ({
  entry,
  superseded,
  onReopen,
}: {
  entry: VisualEntry;
  superseded: boolean;
  onReopen: () => void;
}) => (
  <div className="my-2 overflow-hidden rounded-md border border-dashed" data-visual={entry.callId}>
    <Chrome title={entry.title}>
      <span>{superseded ? "A newer version is below" : "collapsed"}</span>
      <Button variant="ghost" size="sm" onClick={onReopen}>
        Reopen
      </Button>
    </Chrome>
  </div>
);

/** A call that is still showing its Visual: the model is writing it, or the Session is preparing it. */
const VisualPending = ({ title }: { title: string | undefined }) => (
  <div className="my-2 overflow-hidden rounded-md border border-dashed">
    <Chrome title={title ?? "…"}>
      <span>Preparing…</span>
    </Chrome>
  </div>
);

/**
 * One place's claim on a Visual (`sandbox-frame/places.ts`, keyed `visual:`): whether its frame is here, in another place,
 * or nowhere yet. A place told to let its frame go lets it go at once: a Visual has nothing to tear down.
 */
const useVisualPlace = (callId: string) => {
  const places = use(VisualPlacesContext);
  const place = useThreadPlace();
  const id = useId();
  const key = placeKey("visual", callId);

  useLayoutEffect(() => {
    places.claim(id, key, place);
    places.update(id, true);

    return () => {
      places.release(id);
    };
  }, [places, id, key, place]);

  const snapshot = () => places.viewKey(id);

  useSyncExternalStore(places.subscribe, snapshot, snapshot);

  const view = places.viewOf(id);

  useLayoutEffect(() => {
    if (view.kind === "hosting" && view.closing) places.closed(id);
  });

  return view;
};

/**
 * A kept Visual's open card: the chrome and its actions, the details, and the frame, which mounts when the card comes near
 * the viewport (its page loads the first time it does) and unmounts when it goes far, never while it has the focus. Where
 * there is no frame its remembered height holds the transcript still.
 */
export const VisualOpen = ({
  sessionId,
  entry,
  onCollapse,
}: {
  sessionId: string;
  entry: VisualEntry;
  onCollapse: () => void;
}) => {
  const card = useRef<HTMLDivElement>(null);
  const view = useVisualPlace(entry.callId);
  const hosting = view.kind === "hosting" && !view.closing;
  const { near, seen } = useNearViewport(card);
  const [focused, setFocused] = useState(false);
  const [details, setDetails] = useState(false);
  const key = visualKey(sessionId, entry.callId);
  const registry = use(RegistryContext);
  const loaded = useAtomValue(hosting && seen ? visualLoadAtom(key) : NO_LOAD);
  const [remembered, remember] = useAtom(visualHeightAtom(entry.callId));
  const load = AsyncResult.isSuccess(loaded) ? loaded.value : undefined;
  const page = load?.status === "page" ? load : undefined;

  const mounted = hosting && page !== undefined && shouldMount(near, focused);

  const placeholder = (
    <div className="border-t" style={{ height: remembered ?? VISUAL_MIN_HEIGHT }} />
  );

  const body = (() => {
    if (view.kind === "elsewhere") {
      return (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          Shown in {PLACE_NAMES[view.place]}
        </div>
      );
    }

    if (load?.status === "failed") {
      return (
        <VisualFailed
          reason={load.reason}
          onRetry={() => {
            registry.refresh(visualLoadAtom(key));
          }}
        />
      );
    }

    if (load?.status === "none") {
      return (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">Visual unavailable</div>
      );
    }

    if (load?.status === "evicted") {
      return (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          This Visual is no longer kept: {entry.summary}
        </div>
      );
    }

    if (page !== undefined && mounted) {
      return (
        <VisualFrame
          record={page.record}
          origin={page.origin}
          initialHeight={remembered}
          onHeight={remember}
          onEscape={() => card.current?.focus()}
          onFocused={setFocused}
        />
      );
    }

    return placeholder;
  })();

  return (
    <div
      ref={card}
      tabIndex={-1}
      role="group"
      aria-label={`Visual: ${entry.title}`}
      className="my-2 overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-visual={entry.callId}
    >
      <Chrome title={entry.title}>
        <HeaderButton onClick={onCollapse}>Collapse</HeaderButton>
        <HeaderButton
          disabled={page === undefined}
          onClick={() => {
            // The kept copy, redacted, without the shim, which is never stored.
            if (page !== undefined) void copyToClipboard(page.record.html);
          }}
        >
          Copy HTML
        </HeaderButton>
        <OpenFile sessionId={sessionId} entry={entry} />
        <HeaderButton
          expanded={details}
          onClick={() => {
            setDetails((open) => !open);
          }}
        >
          Details
        </HeaderButton>
      </Chrome>
      {details && <VisualDetails entry={entry} record={page?.record} origin={page?.origin} />}
      {body}
    </div>
  );
};

/** What a card shows of a Visual given its entry, whether a newer one supersedes it and what the owner chose of it. */
const VisualShown = ({ entry }: { entry: VisualEntry }) => {
  const sessionId = useShownSessionId();
  const conversationId = useThreadConversation();
  const layoutKey = useShownLayoutKey();
  const [choice, choose] = useAtom(appChoiceAtom(layoutKey, entry.callId));

  const superseded = useAtomValue(
    visualSupersededAtom(conversationKey(sessionId, conversationId)),
    (map) => map.has(entry.callId),
  );

  if (!isKeptVisual(entry)) return <VisualEvicted sessionId={sessionId} entry={entry} />;

  // The owner's Collapse or Reopen wins; else only a superseded Visual collapses.
  const collapsed = choice === "collapsed" || (choice === undefined && superseded);

  if (collapsed) {
    return (
      <VisualCollapsed
        entry={entry}
        superseded={superseded}
        onReopen={() => {
          choose("open");
        }}
      />
    );
  }

  return (
    <VisualOpen
      sessionId={sessionId}
      entry={entry}
      onCollapse={() => {
        choose("collapsed");
      }}
    />
  );
};

/**
 * The Visual of a `visual_show` call, under its card: the Visual once the Session lists it, its progress while the call
 * streams or runs, and nothing for a call that failed (the card says why) or a Session that keeps no Visual of it.
 */
export const VisualCall = ({
  callId,
  progress,
}: {
  callId: string;
  progress?: VisualProgress | undefined;
}) => {
  const sessionId = useShownSessionId();
  const entry = useAtomValue(visualsAtom(sessionId), (visuals) => visualEntryOf(visuals, callId));

  if (entry !== undefined) return <VisualShown entry={entry} />;

  if (progress?.phase === "streaming" || progress?.phase === "running") {
    return <VisualPending title={progress.title} />;
  }

  return null;
};

/** The Visuals a `codemode` script showed, in a strip under its card and outside its disclosure; nothing when it showed none. */
export const VisualStrip = ({ parentId }: { parentId: string }) => {
  const sessionId = useShownSessionId();

  const entries = useAtomValue(visualsAtom(sessionId), (visuals) =>
    visualsOfScript(visualEntries(visuals), parentId),
  );

  if (entries.length === 0) return null;

  return (
    <div className="my-2" data-visual-strip={parentId}>
      {Arr.map(entries, (entry) => (
        <VisualShown key={entry.callId} entry={entry} />
      ))}
    </div>
  );
};

/** Whether the Session shown keeps Visuals (`hello.visuals`): a `visual_show` card of one that does not is an ordinary card. */
export const useKeepsVisuals = (): boolean => {
  const sessionId = useShownSessionId();

  return useAtomValue(keepsVisualsAtom(sessionId));
};
