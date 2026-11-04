// docs/architecture/mcp-apps.md → App Views in the transcript. What a tool call's card adds when the call is an App's: its View
// below the card while it is live, or the line that says why there is none (collapsed, with Reopen; shown in another place;
// unavailable). A call that is no App's adds nothing. The same component places the Views of a `codemode` script's calls
// (`AppStrip`, under the script's card) and of a subagent's thread.
//
// Which place mounts a View is `places.ts`'s; whether a View is live is `generation.ts`'s, with what the owner chose of it
// on this device. The frame itself is `app-frame.tsx`'s.
// @effect-diagnostics missingPipeableSignature:off -- a hook over the Session's atoms, not a combinator.
import { GLOBAL_SCOPE, type McpAppEntry, type McpAppTool } from "@cloudpid/protocol";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode } from "react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
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
import { appChoiceAtom } from "../session-layout-state.ts";
import { sessionPath } from "../router.ts";
import { mcpAppsAtom, mcpAppToolsAtom, sessionClientAtom } from "../session/atoms.ts";
import { mcpSignInStartHref } from "../settings/mcp-sign-in-model.ts";
import { AppFailed, AppFrame, type AppControls } from "./app-frame.tsx";
import {
  appGenerationAtom,
  appKey,
  appLoadAtom,
  sessionArchivedAtom,
  sessionEnvironmentAtom,
  sessionMcpStatusesAtom,
} from "./atoms.ts";
import { appAvailability, type AppAvailability } from "./availability.ts";
import type { DisplayMode } from "./host-context.ts";
import { callsOfScript, isAppLive, stripRows } from "./generation.ts";
import { appPlaces, PLACE_NAMES, type AppPlace, type AppPlaces } from "./places.ts";
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
    <AppCollapsed server={facts.server} archived={facts.archived} onReopen={onReopen} />
  ) : (
    <AppNote>{noteOf(facts.availability)}</AppNote>
  );

/** What a card says of a View that is collapsed: whose it is, and Reopen. */
const AppCollapsed = ({
  server,
  archived,
  onReopen,
}: {
  server: string | undefined;
  archived: boolean;
  onReopen: () => void;
}) => (
  <div className="my-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
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
}

/** What a place hands the component that loads and frames a call's View. */
export interface AppLoadedProps {
  readonly facts: AppFacts;
  readonly place: AppPlace;
  readonly controls: AppControls;
  readonly onRequestMode: (mode: DisplayMode) => void;
  readonly onFocused: (focused: boolean) => void;
  readonly closing: boolean;
  readonly onClosed: () => void;
}

/** The View of call `callId`, loaded when this mounts: it shows nothing while it loads (the card has the call's state). */
const AppLoaded = ({
  facts: { sessionId, callId, tool, badge, archived },
  place,
  controls,
  onRequestMode,
  onFocused,
  closing,
  onClosed,
}: AppLoadedProps) => {
  const key = appKey(sessionId, callId);
  const result = useAtomValue(appLoadAtom(key));
  const retry = useAtomRefresh(appLoadAtom(key));
  const client = useAtomValue(sessionClientAtom(sessionId));
  const environment = useAtomValue(sessionEnvironmentAtom(sessionId));

  if (!AsyncResult.isSuccess(result)) return null;

  const load = result.value;

  switch (load.status) {
    case "view":
      return (
        <AppFrame
          record={load.record}
          page={load.page}
          tool={tool}
          badge={badge}
          readOnly={archived}
          {...(AsyncResult.isSuccess(client) ? { client: client.value } : {})}
          signInHref={(stepUp) =>
            environment === undefined
              ? undefined
              : mcpSignInStartHref({
                  scope: environment,
                  global: GLOBAL_SCOPE,
                  server: load.record.server,
                  stepUp,
                  returnPath: sessionPath(sessionId),
                })
          }
          place={place}
          controls={controls}
          onRequestMode={onRequestMode}
          onFocused={onFocused}
          closing={closing}
          onClosed={onClosed}
        />
      );
    case "unavailable":
      return <AppNote>App unavailable</AppNote>;
    case "stub":
      return <AppNote>App data no longer kept</AppNote>;
    case "failed":
      return <AppFailed reason={load.reason} onRetry={retry} />;
    case "none":
      return null;
  }
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
}

/**
 * One place's part in a call's View: it claims the call (`places.ts`), and is told whether it mounts the View, waits for
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
}: AppPlaceMountProps) => {
  const places = use(AppPlacesContext);
  const id = useId();
  const { callId } = facts;

  // The claim lives as long as this place; what it wants is told after every render, which costs nothing when it is the same.
  useLayoutEffect(() => {
    places.claim(id, callId, place);

    return () => {
      places.release(id);
    };
  }, [places, id, callId, place]);

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
          onClosed={() => {
            places.closed(id);
          }}
        />
      );
    case "elsewhere":
      return <ShownIn place={view.place} onBack={onBack} />;
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

  const entry: McpAppEntry | undefined = Arr.findFirst(
    Arr.flatten(Record.values(apps)),
    (each) => each.callId === callId,
  ).pipe(Option.getOrUndefined);

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
  };
};

/** Why a call has no View when it cannot mount. */
export const noteOf = (availability: AppAvailability): string =>
  availability.kind === "evicted" ? "App data no longer kept" : "App unavailable";

/**
 * The App View of a finished tool call, under its card, when the call is an App's. `toolName` is the model-facing
 * name (`mcp__<server>__<tool>`); a call that is still running has no result to show, and none is mounted for it (a View
 * that mounts as the call streams is #496's).
 *
 * It is live while its call is in the newest generation of its server's App calls in the thread, or the owner reopened
 * it, or they are using it, unless they collapsed it; in an archived Session it is collapsed until reopened.
 */
export const AppCall = ({ callId, toolName }: { callId: string; toolName?: string }) => {
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

  if (facts.availability.kind === "none") return null;

  const live = facts.mountable && isAppLive({ newest, choice, archived: facts.archived, focused });

  const popOut = () => {
    actOnPanes({ type: "open", key: appPaneKey(callId) });
  };

  return (
    <AppPlaceMount
      facts={facts}
      place={place}
      live={live}
      idle={
        <AppIdle
          facts={facts}
          onReopen={() => {
            choose("open");
          }}
        />
      }
      controls={{
        onCollapse: () => {
          choose("collapsed");
        },
        onPopOut: popOut,
      }}
      onRequestMode={(mode) => {
        if (mode === "fullscreen") popOut();
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

  const calls = callsOfScript(Arr.flatten(Record.values(apps)), parentId);

  // Which of the script's calls are live, as the string it changes by: a token of the transcript does not redraw the strip.
  const liveIds = useAtomValue(
    appGenerationAtom(conversationKey(sessionId, conversationId)),
    (live) =>
      Arr.join(
        Arr.map(
          Arr.filter(calls, (call) => live.has(call.callId)),
          (call) => call.callId,
        ),
        "\0",
      ),
  );

  if (calls.length === 0) return null;

  const { shown, earlier } = stripRows(calls, new Set(liveIds.split("\0")), expanded);

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
