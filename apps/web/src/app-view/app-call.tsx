// docs/architecture/mcp-apps.md → App Views in the transcript. What a tool call's card adds when the call is an App's: its View
// below the card, mounted when the card is, or the line that says why there is none. A call that is no App's adds nothing.
//
// Seams for the tickets that follow: `live` (the generation and live rule, collapse and Reopen, #490) is always true here;
// the card is always where the transcript puts it (placement in a codemode strip or a subagent's thread is #490's).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useShownSessionId } from "../chat/conversation.ts";
import { mcpAppsAtom, mcpAppToolsAtom } from "../session/atoms.ts";
import { AppFailed, AppFrame } from "./app-frame.tsx";
import { appKey, appLoadAtom, sessionMcpStatusesAtom } from "./atoms.ts";
import { appAvailability } from "./availability.ts";

/** A line of the card where there is no View: an App that is gone or whose data is. */
const AppNote = ({ children }: { children: string }) => (
  <div className="my-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
    {children}
  </div>
);

/** The View of call `callId`, loaded when this mounts: it shows nothing while it loads (the card has the call's state). */
const AppLoaded = ({
  sessionId,
  callId,
  title,
  badge,
  closing,
  onFramed,
  onClosed,
}: {
  sessionId: string;
  callId: string;
  title: string | undefined;
  badge: "offline" | "sign-in" | null;
  closing: boolean;
  onFramed: () => void;
  onClosed: () => void;
}) => {
  const key = appKey(sessionId, callId);
  const result = useAtomValue(appLoadAtom(key));
  const retry = useAtomRefresh(appLoadAtom(key));

  if (!AsyncResult.isSuccess(result)) return null;

  const load = result.value;

  switch (load.status) {
    case "view":
      return (
        <AppFrame
          record={load.record}
          page={load.page}
          title={title}
          badge={badge}
          closing={closing}
          onFramed={onFramed}
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

/**
 * The View of call `callId` while `live`, or the `note` that says why there is none. A View whose call stops being live
 * (evicted, its server off or shadowed) is not unmounted from under its frame: the frame stays, closing, until the View has
 * answered its teardown (`AppFrame`), and only then does the note replace it. `generation` makes a View that comes back
 * (the server reconnects) a new frame, never the dead one.
 */
const AppMount = ({
  sessionId,
  callId,
  title,
  badge,
  live,
  note,
}: {
  sessionId: string;
  callId: string;
  title: string | undefined;
  badge: "offline" | "sign-in" | null;
  live: boolean;
  note: string;
}) => {
  const [framed, setFramed] = useState(false);
  const [generation, setGeneration] = useState(0);

  // Nothing is mounted for a call that is not live, and nothing to wait for when no frame was.
  if (!live && !framed) return <AppNote>{note}</AppNote>;

  return (
    <AppLoaded
      key={generation}
      sessionId={sessionId}
      callId={callId}
      title={title}
      badge={badge}
      closing={!live}
      onFramed={() => {
        setFramed(true);
      }}
      onClosed={() => {
        setFramed(false);
        setGeneration((count) => count + 1);
      }}
    />
  );
};

/**
 * The App View of a finished tool call, under its card, when the call is an App's. `toolName` is the model-facing
 * name (`mcp__<server>__<tool>`); a call that is still running has no result to show, and none is mounted for it (a View
 * that mounts as the call streams is #496's).
 */
export const AppCall = ({ callId, toolName }: { callId: string; toolName: string }) => {
  const sessionId = useShownSessionId();
  const tools = useAtomValue(mcpAppToolsAtom(sessionId));
  const apps = useAtomValue(mcpAppsAtom(sessionId));
  const statuses = useAtomValue(sessionMcpStatusesAtom(sessionId));

  const entry = Arr.findFirst(
    Arr.flatten(Record.values(apps)),
    (each) => each.callId === callId,
  ).pipe(Option.getOrUndefined);

  const tool = Arr.findFirst(tools ?? [], (each) => each.name === toolName).pipe(
    Option.getOrUndefined,
  );

  const server = tool?.server ?? entry?.server;

  const availability = appAvailability({
    toolName,
    tools,
    entry,
    serverState: server === undefined ? undefined : statuses.chips[server]?.state,
  });

  if (availability.kind === "none") return null;

  const live = availability.kind === "mount";

  return (
    <AppMount
      sessionId={sessionId}
      callId={callId}
      title={tool?.title}
      badge={availability.kind === "mount" ? availability.badge : null}
      live={live}
      note={availability.kind === "evicted" ? "App data no longer kept" : "App unavailable"}
    />
  );
};
