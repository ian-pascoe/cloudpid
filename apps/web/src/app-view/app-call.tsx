// docs/architecture/mcp-apps.md → App Views in the transcript. What a tool call's card adds when the call is an App's: its View
// below the card while it is live, or the line that says why there is none (collapsed, with Reopen; shown in another place;
// unavailable). A call that is no App's adds nothing. The same component places the Views of a `codemode` script's calls
// (`AppStrip`, under the script's card) and of a subagent's thread.
//
// Which place mounts a View is `sandbox-frame/places.ts`'s; whether a View is live is `generation.ts`'s, with what the owner chose of it
// on this device. The frame itself is `app-frame.tsx`'s.
// @effect-diagnostics missingPipeableSignature:off globalTimers:off -- a hook over the Session's atoms, not a combinator; the grace for a record is a native timer.
import { GLOBAL_SCOPE, isKeptApp, type McpAppContext, type McpAppTool } from "@cloudpid/protocol";
import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createContext,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode } from "react";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Button } from "../components/ui/button.tsx";
import {
  conversationKey,
  useShownLayoutKey,
  useShownSessionId,
  useThreadConversation,
  useThreadPlace,
} from "../chat/conversation.ts";
import { appPaneKey } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { appChoiceAtom, sessionLayoutAtom } from "../session-layout-state.ts";
import { sessionPath } from "../router.ts";
import { appEntries, appEntryOf } from "../session/apps.ts";
import { mcpAppsAtom, mcpAppToolsAtom, sessionClientAtom } from "../session/atoms.ts";
import { mcpSignInStartHref } from "../settings/mcp-sign-in-model.ts";
import type { AppMessageChipState } from "../chat/attachments-state.ts";
import type { SessionClient } from "../session/client.ts";
import { BROWSER_PANE } from "../panes.ts";
import { browserPaneKey, ownerTabActionAtom } from "../live-view/browser-pane-atoms.ts";
import { AppContextChip } from "./app-context-chip.tsx";
import { AppFailed, AppFrame, type AppControls, type RunningCall } from "./app-frame.tsx";
import type { ToolArguments } from "./partial-input.ts";
import type { AppSpeech } from "./app-messages.ts";
import {
  appGenerationAtom,
  appKey,
  appLoadAtom,
  appRunningAtom,
  NO_RUNNING_PAGE,
  runningKey,
  sessionArchivedAtom,
  sessionEnvironmentAtom,
  sessionMcpStatusesAtom,
} from "./atoms.ts";
import { appAvailability, type AppAvailability } from "./availability.ts";
import type { AppPage } from "./load.ts";
import type { DisplayMode } from "./host-context.ts";
import { callsOfScript, isAppLive, stripRows } from "./generation.ts";
import {
  appPlaces,
  PLACE_NAMES,
  placeKey,
  type AppPlace,
  type AppPlaces,
} from "../sandbox-frame/places.ts";
import { holdWhereShown, shownInAtom } from "./shown-in.ts";
import { afterTeardown, paneElement } from "./teardown.ts";

/** The places of this page: one for the app. A test gives its own. */
export const AppPlacesContext = createContext<AppPlaces>(appPlaces);

/** A line of the card where there is no View: an App that is gone, whose data is, or that is shown elsewhere. */
export const AppNote = ({ children }: { children: ReactNode }) => (
  <div className="my-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
    {children}
  </div>
);

/** What a place that is not mounting a call's View says of it: where it is shown, and a way to bring it here. */
const ShownIn = ({ place, onBack }: { place: AppPlace; onBack: (() => void) | undefined }) => (
  <AppNote>
    <span>Shown in {PLACE_NAMES[place]}</span>
    {onBack !== undefined && (
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onBack}>
        Show here
      </Button>
    )}
  </AppNote>
);

/** What a place says where it has no View: a collapsed row with Reopen, or the note that says why there is no App. */
export const AppIdle = ({ facts, onReopen }: { facts: AppFacts; onReopen: () => void }) =>
  facts.mountable ? (
    <AppCollapsed
      server={facts.server}
      archived={facts.archived}
      context={facts.context}
      onReopen={onReopen}
    />
  ) : (
    <AppNote>{noteOf(facts.availability)}</AppNote>
  );

/** What a card says of a View that is collapsed: whose it is, the last context it told the model, and Reopen. */
const AppCollapsed = ({
  server,
  archived,
  context,
  onReopen,
}: {
  server: string | undefined;
  archived: boolean;
  context: McpAppContext | undefined;
  onReopen: () => void;
}) => (
  <div className="my-2 overflow-hidden rounded-md border border-dashed">
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="text-foreground">App</span>
      {server !== undefined && (
        <>
          <span>·</span>
          <span className="min-w-0 truncate">{server}</span>
        </>
      )}
      <span className="shrink-0">collapsed</span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0"
        title={archived ? "Reopen, reads only: this Session is archived" : "Reopen the App"}
        onClick={onReopen}
      >
        Reopen
      </Button>
    </div>
    <AppContextChip context={context} />
  </div>
);

/** What a call's card knows of it: its tool, its entry among the Session's App calls, and what its server's state allows. */
export interface AppFacts {
  readonly sessionId: string;
  readonly callId: string;
  readonly tool: McpAppTool | undefined;
  readonly server: string | undefined;
  readonly availability: AppAvailability;
  /** The server's state as a badge, when the View can mount. */
  readonly badge: "offline" | "sign-in" | null;
  /** The View can be mounted: the call is an App's, its record is kept and its server is on. */
  readonly mountable: boolean;
  /** The Session is archived: its Views are collapsed until reopened, and a reopened one may only read. */
  readonly archived: boolean;
  /** The last context the View told the model, with whether it was delivered. */
  readonly context: McpAppContext | undefined;
  /** The Session keeps the call's record: it finished, and its View has a result to be told. */
  readonly kept: boolean;
}

/**
 * Where a call is when its card is drawn, for a call that has not finished (`undefined` is a finished call, whose record
 * the View is given whole): the model is still emitting it (`streaming`, with the arguments so far), its message was
 * committed and it runs (`running`, with all its arguments), or it ended without a result (`stopped`: Stop, a timeout, a cut).
 */
export type CallProgress =
  | {
      readonly phase: "streaming" | "running";
      readonly arguments: ToolArguments;
    }
  | { readonly phase: "stopped" };

const STOPPED_REASON = "The call did not finish";

/** Why a View is told its call is over when the record that came is another server's than its page. */
const SHADOWED_REASON = "The server that made the call is no longer the one this App is of";

/** Why a View is told its call is over when the call has its result and no record came for it. */
const NO_RECORD_REASON = "The call ended without a result for the App";

/** How long a call that has its result is given for its record to arrive (the Session's list of records comes on its own). */
const NO_RECORD_GRACE_MS = 2000;

/** Whether the model is still emitting the call or it runs: its View is told of it as it goes. */
const isRunning = (
  progress: CallProgress | undefined,
): progress is Extract<CallProgress, { readonly phase: "streaming" | "running" }> =>
  progress?.phase === "streaming" || progress?.phase === "running";

/** What a place hands the component that loads and frames a call's View. */
export interface AppLoadedProps {
  readonly facts: AppFacts;
  readonly place: AppPlace;
  readonly controls: AppControls;
  readonly onRequestMode: (mode: DisplayMode) => void;
  readonly onFocused: (focused: boolean) => void;
  readonly closing: boolean;
  readonly onClosed: () => void;
  /** Where the call is while it has not finished: its View mounts before its record, and is told as it goes. */
  readonly progress?: CallProgress | undefined;
}

/**
 * The View of call `callId`, loaded when this mounts: it shows nothing while it loads (the card has the call's state). A call
 * that is running has no record, so its View is made from its tool's page and the arguments it has; the record, when the call
 * finishes, is read into the frame that is there, which is never made again for it (the page it was made with is kept, and the
 * record's is not swapped in).
 */
const AppLoaded = ({
  facts: { sessionId, callId, tool, badge, archived, context, kept },
  place,
  controls,
  onRequestMode,
  onFocused,
  closing,
  onClosed,
  progress,
}: AppLoadedProps) => {
  const key = appKey(sessionId, callId);
  const inProgress = isRunning(progress);

  // The page the View was made from, for as long as this card has it, and whose it is: a View made before its call had a record
  // (`early`) is of the server the inventory named then, which the record must be of too.
  const [held, setHeld] = useState<
    { readonly page: AppPage; readonly server: string; readonly early: boolean } | undefined
  >(undefined);

  const wantsRunning = tool !== undefined && !kept && (inProgress || held !== undefined);

  // A call without a record is not asked for one: the answer would be `none`, which the atom keeps.
  const recordResult = useAtomValue(wantsRunning ? NO_RUNNING_PAGE : appLoadAtom(key));

  const runningResult = useAtomValue(
    wantsRunning ? appRunningAtom(runningKey(sessionId, callId, tool.name)) : NO_RUNNING_PAGE,
  );

  const client = useAtomValue(sessionClientAtom(sessionId));
  const environment = useAtomValue(sessionEnvironmentAtom(sessionId));

  // What the View may say to the conversation is read where the View is shown when it says it, not as of this render.
  const registry = use(RegistryContext);

  // Retry loads again the one that failed. It is not a hook of either atom: reading one here would load it for a card that
  // wants the other (a call that runs has no record to mount yet, and the answer, `none`, would be kept for when it has).
  const retry = () => {
    registry.refresh(
      wantsRunning && tool !== undefined
        ? appRunningAtom(runningKey(sessionId, callId, tool.name))
        : appLoadAtom(key),
    );
  };

  // "Open in Browser Pane": the Pane is opened, and the Owner tab goes to the link on the Pane's own connection.
  const actOnPanes = useAtomSet(panesAtom);

  const navigate = useAtomSet(ownerTabActionAtom(browserPaneKey(sessionId, archived)), {
    mode: "promiseExit",
  });

  const recordLoad = AsyncResult.isSuccess(recordResult) ? recordResult.value : undefined;
  const runningLoad = AsyncResult.isSuccess(runningResult) ? runningResult.value : undefined;
  const recordView = recordLoad?.status === "view" ? recordLoad : undefined;

  const page =
    held?.page ??
    (runningLoad?.status === "running" ? runningLoad.page : undefined) ??
    recordView?.page;

  const server = recordView?.record.server ?? tool?.server ?? "";

  if (page !== undefined && held === undefined) {
    setHeld({ page, server, early: recordView === undefined });
  }

  // The record of a call whose View was made early is checked against the page it was made from before it is told anything: the
  // inventory may have changed while the call ran (an owner's server shadowing a Repo's, or back), and one server's result must
  // never reach another server's View at its origin. The record's `viewHash` names the origin of the server that made the call,
  // and the page's `view` that of the server it was read from; a record that pins none is compared by the server's name.
  const shadowed =
    held?.early === true &&
    ((recordView !== undefined &&
      (recordView.record.server !== held.server ||
        (recordView.record.viewHash !== undefined &&
          held.page.view !== undefined &&
          recordView.record.viewHash !== held.page.view))) ||
      recordLoad?.status === "unavailable");

  // A View made early whose record cannot be read (the Session failed to answer for its page) is of a call that has ended, and
  // is told so: it is torn down, and the card says why with Retry, which reads the record again into a frame made new.
  const failed =
    held?.early === true && recordLoad?.status === "failed" ? recordLoad.reason : undefined;

  // A View ended for that is replaced by the note once it has torn down.
  const [retired, setRetired] = useState(false);

  useLayoutEffect(() => {
    if (retired && closing) onClosed();
  }, [retired, closing, onClosed]);

  // A call that has its result and no record, after the record's grace: its View is told the call is over.
  const ended = held !== undefined && progress === undefined && !kept;
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    if (!ended) return;

    const timer = setTimeout(() => {
      setGaveUp(true);
    }, NO_RECORD_GRACE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [ended]);

  const speech: Partial<AppSpeech> = speechOf(
    AsyncResult.isSuccess(client) ? client.value : undefined,
    callId,
    server,
    (chip) => holdWhereShown(registry, key, chip),
    () => registry.get(shownInAtom(key))?.conversation,
  );

  if (retired) return <AppNote>App unavailable</AppNote>;

  if (page !== undefined) {
    // Until the record comes the View is told of the call from what the card knows of it.
    const running: RunningCall | undefined =
      (recordView !== undefined && !shadowed) || tool === undefined
        ? undefined
        : {
            callId,
            server: tool.server,
            tool: tool.tool,
            arguments: inProgress ? progress.arguments : undefined,
            final: progress?.phase === "running",
          };

    return (
      <AppFrame
        record={shadowed ? undefined : recordView?.record}
        running={running}
        cancelled={
          shadowed
            ? SHADOWED_REASON
            : failed !== undefined
              ? failed
              : recordView === undefined && progress?.phase === "stopped"
                ? STOPPED_REASON
                : recordView === undefined && ended && gaveUp
                  ? NO_RECORD_REASON
                  : undefined
        }
        page={page}
        tool={tool}
        badge={badge}
        readOnly={archived}
        speech={speech}
        context={context}
        onOpenInPane={(url) => {
          actOnPanes({ type: "open", key: BROWSER_PANE });
          void navigate({ type: "navigate", url });
        }}
        {...(AsyncResult.isSuccess(client) ? { client: client.value } : {})}
        signInHref={(stepUp) =>
          environment === undefined
            ? undefined
            : mcpSignInStartHref({
                scope: environment,
                global: GLOBAL_SCOPE,
                server,
                stepUp,
                returnPath: sessionPath(sessionId),
              })
        }
        place={place}
        controls={controls}
        onRequestMode={onRequestMode}
        onFocused={onFocused}
        closing={closing || shadowed || failed !== undefined}
        onClosed={() => {
          if (shadowed) setRetired(true);

          // Its frame gone, the card shows the failure (below) with Retry, and a record read later is framed anew.
          if (failed !== undefined) setHeld(undefined);

          if (closing) onClosed();
        }}
      />
    );
  }

  const load = wantsRunning ? runningLoad : recordLoad;

  switch (load?.status) {
    case "unavailable":
      return <AppNote>App unavailable</AppNote>;
    case "stub":
      return <AppNote>App data no longer kept</AppNote>;
    case "failed":
      return <AppFailed reason={load.reason} onRetry={retry} />;
    default:
      return null;
  }
};

/**
 * What a card lets its View say to the conversation, as far as the Session on this connection takes it (its `hello` says): a
 * message is held in the composer as a chip (`hold`, which answers `refused` when the conversation the View is shown in has
 * no composer), a context goes to the Session with the conversation the View is shown in now (`shownIn`). A Session that does
 * not take either is offered none, so the View is not told the host does it.
 */
export const speechOf = (
  client: Pick<SessionClient, "appContext" | "takes"> | undefined,
  callId: string,
  server: string,
  hold: (chip: AppMessageChipState) => Promise<"held" | "refused">,
  shownIn: () => number | undefined,
): Partial<AppSpeech> => {
  const speech: Types.Mutable<Partial<AppSpeech>> = {};

  if (client === undefined) return speech;

  const takes = client.takes();

  if (takes.appMessages) speech.message = (text) => hold({ callId, server, text });

  if (takes.appContext) {
    speech.context = (text) =>
      Effect.runPromise(client.appContext(callId, text, shownIn())).then(
        (answer) => ({
          held: answer.status === "held",
          message: "message" in answer ? answer.message : undefined,
        }),
        () => ({ held: false, message: "Connection lost: the host could not reach the Session" }),
      );
  }

  return speech;
};

export interface AppPlaceMountProps {
  readonly facts: AppFacts;
  /** Where this mounts the View: its card, a Subagent Pane or page's thread, or an App Pane. */
  readonly place: AppPlace;
  /** This place wants the View mounted. When it stops wanting it, the frame stays until its View has torn down. */
  readonly live: boolean;
  /** What this shows when it wants no View and has none: a collapsed row, or the note that says why there is no App. */
  readonly idle: ReactNode;
  readonly controls: AppControls;
  readonly onRequestMode: (mode: DisplayMode) => void;
  readonly onFocused?: (focused: boolean) => void;
  /** Bring a View that is shown in another place back here: undefined where it cannot be asked. */
  readonly onBack?: (() => void) | undefined;
  /** What loads and frames the View: the atoms' `AppLoaded`, or a stand-in in a test, which has no Session to load from. */
  readonly Loaded?: ComponentType<AppLoadedProps>;
  /** Where the call is while it has not finished (`CallProgress`); none for a call that has. */
  readonly progress?: CallProgress | undefined;
}

/**
 * One place's part in a call's View: it claims the call (`sandbox-frame/places.ts`), and is told whether it mounts the View, waits for
 * another place's frame to go first, or leaves it to another ("Shown in …"). A View that stops being wanted here (collapsed,
 * its server gone, moved to an App Pane) is not unmounted from under its frame: the frame stays, closing, until the View has
 * answered its teardown (`AppFrame`), and only then does the note replace it. A View that is wanted again (Reopen, the server
 * back) is a new frame, never the dead one.
 */
export const AppPlaceMount = ({
  facts,
  place,
  live,
  idle,
  controls,
  onRequestMode,
  onFocused = noFocus,
  onBack,
  Loaded = AppLoaded,
  progress,
}: AppPlaceMountProps) => {
  const places = use(AppPlacesContext);
  const id = useId();
  const { callId } = facts;
  const key = placeKey("app", callId);

  // The claim lives as long as this place; what it wants is told after every render, which costs nothing when it is the same.
  useLayoutEffect(() => {
    places.claim(id, key, place);

    return () => {
      places.release(id);
    };
  }, [places, id, key, place]);

  useLayoutEffect(() => {
    places.update(id, live);
  });

  const snapshot = () => places.viewKey(id);

  useSyncExternalStore(places.subscribe, snapshot, snapshot);

  const view = places.viewOf(id);

  // A frame is made only for a View that is wanted: when a higher place claimed the call in the same commit as this one (a
  // Pane that was open when the page did), this place's hosting began closing before it mounted anything, and is over.
  const mounted = useRef<number | undefined>(undefined);
  const unmade = view.kind === "hosting" && view.closing && mounted.current !== view.key;

  useLayoutEffect(() => {
    if (view.kind !== "hosting") return;

    if (unmade) places.closed(id);
    else mounted.current = view.key;
  });

  switch (view.kind) {
    case "hosting":
      if (unmade) return null;

      return (
        <Loaded
          key={view.key}
          facts={facts}
          place={place}
          controls={controls}
          onRequestMode={onRequestMode}
          onFocused={onFocused}
          closing={view.closing}
          progress={progress}
          onClosed={() => {
            places.closed(id);
          }}
        />
      );
    case "elsewhere":
      // Only an App Pane is a place to bring a View back from: the others are the thread's own.
      return <ShownIn place={view.place} onBack={view.place === "app-pane" ? onBack : undefined} />;
    case "waiting":
      return null;
    case "none":
      // Before the claim is made, a place that wants the View has nothing to say yet.
      return live ? null : idle;
  }
};

const noFocus = (): void => undefined;

/** What a call's card knows of it (`AppFacts`), from the Session's inventory, App calls and server chips. */
export const useAppFacts = (callId: string, toolName: string | undefined): AppFacts => {
  const sessionId = useShownSessionId();
  const tools = useAtomValue(mcpAppToolsAtom(sessionId));
  const apps = useAtomValue(mcpAppsAtom(sessionId));
  const statuses = useAtomValue(sessionMcpStatusesAtom(sessionId));
  const archived = useAtomValue(sessionArchivedAtom(sessionId));

  const entry = appEntryOf(apps, callId);

  // A call's tool as the model names it: the one a card was given, else the inventory's for the entry's server and tool.
  const named =
    toolName ??
    Arr.findFirst(
      tools ?? [],
      (each) => each.server === entry?.server && each.tool === entry.tool,
    ).pipe(
      Option.map((each) => each.name),
      Option.getOrElse(() => `mcp__${entry?.server}__${entry?.tool}`),
    );

  const tool = Arr.findFirst(tools ?? [], (each) => each.name === named).pipe(
    Option.getOrUndefined,
  );

  const server = tool?.server ?? entry?.server;

  const availability: AppAvailability = appAvailability({
    toolName: named,
    tools,
    entry,
    serverState: server === undefined ? undefined : statuses.chips[server]?.state,
  });

  return {
    sessionId,
    callId,
    tool,
    server,
    availability,
    badge: availability.kind === "mount" ? availability.badge : null,
    mountable: availability.kind === "mount",
    archived,
    context: entry?.context,
    kept: entry !== undefined && isKeptApp(entry),
  };
};

/** Why a call has no View when it cannot mount. */
export const noteOf = (availability: AppAvailability): string =>
  availability.kind === "evicted" ? "App data no longer kept" : "App unavailable";

/**
 * The App View of a tool call, under its card, when the call is an App's. `toolName` is the model-facing name
 * (`mcp__<server>__<tool>`). Without `progress` the call finished and its record is mounted; with it the View mounts as the
 * call streams (`CallProgress`): it is sent the arguments as they stream, then the final ones, then its result when the
 * record comes, and told when the call ended without one.
 *
 * It is live while its call is in the newest generation of its server's App calls in the thread (a call still running is),
 * or the owner reopened it, or they are using it, unless they collapsed it; in an archived Session it is collapsed until
 * reopened. A call that stopped with no record, which this card never saw run, has no View: later loads show the card.
 */
export const AppCall = ({
  callId,
  toolName,
  progress,
}: {
  callId: string;
  toolName?: string;
  progress?: CallProgress;
}) => {
  const facts = useAppFacts(callId, toolName);
  const conversationId = useThreadConversation();
  const place = useThreadPlace();
  const layoutKey = useShownLayoutKey();

  const newest = useAtomValue(
    appGenerationAtom(conversationKey(facts.sessionId, conversationId)),
    (calls) => calls.has(callId),
  );

  const [choice, choose] = useAtom(appChoiceAtom(layoutKey, callId));
  const actOnPanes = useAtomSet(panesAtom);
  const [focused, setFocused] = useState(false);
  // Whether this card saw its call run: only then is a call that stopped a View that is told so.
  const [sawRun, setSawRun] = useState(false);

  if (isRunning(progress) && !sawRun) setSawRun(true);

  if (facts.availability.kind === "none") return null;

  if (progress?.phase === "stopped" && !sawRun && !facts.kept) return null;

  // A card that saw its call run keeps its View until the call's record is there to be told, however the generation reads in
  // between (it counts the calls that run or have a record, and the transcript, the Session's list of records and the call's
  // end each arrive on their own): while the call runs, after it has ended with no record yet, and when it stopped. Only the
  // owner's Collapse ends it; a record that is there is the generation's again.
  const running = isRunning(progress);
  const awaiting = sawRun && !facts.kept && choice === undefined;

  const live =
    facts.mountable &&
    (isAppLive({ newest, choice, archived: facts.archived, focused }) || running || awaiting);

  // A View is popped out into a Pane of its own once its call has a record: the Pane mounts from the record alone.
  const popOut = facts.kept
    ? () => {
        actOnPanes({ type: "open", key: appPaneKey(callId) });
      }
    : undefined;

  const controls: Types.Mutable<AppControls> = {
    onCollapse: () => {
      choose("collapsed");
    },
  };

  if (popOut !== undefined) controls.onPopOut = popOut;

  return (
    <AppPlaceMount
      facts={facts}
      place={place}
      live={live}
      progress={progress}
      idle={
        <AppIdle
          facts={facts}
          onReopen={() => {
            choose("open");
          }}
        />
      }
      controls={controls}
      onRequestMode={(mode) => {
        if (mode === "fullscreen") popOut?.();
      }}
      onFocused={setFocused}
      onBack={() => {
        // The App Pane's View is torn down before the Pane goes, as when its own button closes it.
        afterTeardown(
          () => {
            actOnPanes({ type: "close", key: appPaneKey(callId) });
          },
          paneElement(appPaneKey(callId)),
        );
      }}
    />
  );
};

/**
 * The App Views of the calls a `codemode` script made, in a strip under its card and outside its disclosure: each is live by
 * the same rule as a direct call's (the last call per server of the newest generation, decided over all the script's calls),
 * and the rest are collapsed rows with Reopen. A script with very many shows the last rows and its live ones, and "N earlier"
 * for the rest, which opens them all and stays open: closing it again would unmount a View the owner reopened. Nothing when
 * the script made no App call.
 */
export const AppStrip = ({ parentId }: { parentId: string }) => {
  const sessionId = useShownSessionId();
  const conversationId = useThreadConversation();
  const apps = useAtomValue(mcpAppsAtom(sessionId));
  const [expanded, setExpanded] = useState(false);

  const calls = callsOfScript(appEntries(apps), parentId);

  // Which of the script's calls are live, as the set it changes by: a token of the transcript does not redraw the strip.
  const live = useAtomValue(
    appGenerationAtom(conversationKey(sessionId, conversationId)),
    (generation) =>
      new Set(
        Arr.filter(
          Arr.map(calls, (call) => call.callId),
          (id) => generation.has(id),
        ),
      ),
  );

  // And which the owner reopened on this device.
  const layoutKey = useShownLayoutKey();
  const opened = useAtomValue(sessionLayoutAtom(layoutKey), (layout) => new Set(layout.openApps));

  if (calls.length === 0) return null;

  const { shown, earlier } = stripRows(calls, live, opened, expanded);

  return (
    <div className="my-2" data-app-strip={parentId}>
      {earlier > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setExpanded(true);
          }}
        >
          {earlier} earlier
        </Button>
      )}
      {Arr.map(shown, (call) => (
        <AppCall key={call.callId} callId={call.callId} />
      ))}
    </div>
  );
};
