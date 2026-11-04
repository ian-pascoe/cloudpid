// docs/architecture/mcp-apps.md → App Views in the transcript, The bridge. One App View in its card: the sandbox's proxy
// frame, the bridge to the View inside it, and the card's own chrome (what it is, whose, where it is served, its CSP).
// The frame never takes focus, and is given the browser's clipboard-write permission only when its View declared it (nothing
// else); it asks the owner before a link is opened, and holds what a View says to the conversation (`app-messages.ts`).
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off -- DOM effects: a native debounce timer and observers.
import type { McpAppAuditEntry, McpAppContext, McpAppRecord, McpAppTool } from "@cloudpid/protocol";
import type { McpUiToolResultNotification } from "@modelcontextprotocol/ext-apps";
import { Check, Copy } from "lucide-react";
import * as DateTime from "effect/DateTime";
import type * as Types from "effect/Types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { copyToClipboard } from "../lib/clipboard.ts";
import { cn } from "../lib/utils.ts";
import { AppContextChip } from "./app-context-chip.tsx";
import { refusingSpeech, speechHandlers, type AppSpeech } from "./app-messages.ts";
import { createBridge, retire, type Bridge, type BridgeOptions } from "./bridge.ts";
import { createPartialFeed, type PartialFeed, type ToolArguments } from "./partial-input.ts";
import { displayModeHandler, displayOf, isFullscreen } from "./display-mode.ts";
import { focusWatch } from "./focus.ts";
import { declaredCsp, frameUrl } from "./frame-url.ts";
import {
  type DisplayMode,
  changedContext,
  hostCapabilities,
  hostContextOf,
  HOST_INFO,
  inlineHeight,
} from "./host-context.ts";
import type { AppPage } from "./load.ts";
import { openLinkHandler, type PendingLink } from "./open-link.ts";
import { readEnvironment, readSafeAreaInsets, scrollerOf } from "./page-environment.ts";
import type { AppPlace } from "./places.ts";
import { auditLog, viewLogSink, viewRequestHandlers, type AppRequestClient } from "./requests.ts";
import { appViews } from "./teardown.ts";

/** How long a change of the card's size or the page's theme settles before the View is told. */
const CONTEXT_DEBOUNCE_MS = 150;

/** What a card says when its View could not come up. */
export const AppFailed = ({ reason, onRetry }: { reason: string; onRetry: () => void }) => (
  <div
    role="alert"
    className="my-2 flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive"
  >
    <span className="min-w-0 flex-1 break-words">App couldn't load: {reason}</span>
    <Button variant="ghost" size="sm" onClick={onRetry}>
      Retry
    </Button>
  </div>
);

/** The domains of one list of the View's declared CSP, as a line, or undefined when it declares none. */
const domainLine = (label: string, domains: ReadonlyArray<string> | undefined) =>
  domains === undefined || domains.length === 0 ? undefined : (
    <div key={label}>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono break-all">{domains.join(", ")}</span>
    </div>
  );

/** The View's audit log, newest last: what it asked of its server, and what came of it. */
const AuditLog = ({ entries }: { entries: ReadonlyArray<McpAppAuditEntry> }) =>
  entries.length === 0 ? null : (
    <div>
      <div className="text-muted-foreground">Requests to the server</div>
      <ul className="font-mono break-all" aria-label="Audit log">
        {entries.map((entry, index) => (
          <li key={`${entry.at}:${index}`}>
            <time
              dateTime={DateTime.formatIso(DateTime.makeUnsafe(entry.at))}
              className="text-muted-foreground"
            >
              {DateTime.formatIso(DateTime.makeUnsafe(entry.at)).slice(11, 19)}
            </time>{" "}
            {entry.summary}
          </li>
        ))}
      </ul>
    </div>
  );

/** The card's details: where the View is served, what its CSP lets it reach, the origin it asked for, and its audit log. */
const AppDetails = ({ page, audit }: { page: AppPage; audit: ReadonlyArray<McpAppAuditEntry> }) => {
  const [copied, setCopied] = useState(false);
  const csp = declaredCsp(page.meta.csp);

  const lines = [
    domainLine("Connect", csp?.connectDomains),
    domainLine("Resources", csp?.resourceDomains),
    domainLine("Frames", csp?.frameDomains),
    domainLine("Base URIs", csp?.baseUriDomains),
  ].filter((line) => line !== undefined);

  return (
    <div className="space-y-1 border-t px-2 py-1.5 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Served from </span>
        <span className="min-w-0 font-mono break-all">{page.origin}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Copy the App's origin"
          onClick={() => {
            void copyToClipboard(page.origin).then((done) => {
              setCopied(done);
            });
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      {page.meta.domain !== undefined && (
        <div>
          <span className="text-muted-foreground">Asked for the origin </span>
          <span className="font-mono break-all">{page.meta.domain}</span>
        </div>
      )}
      {lines.length === 0 ? (
        <div className="text-muted-foreground">
          Declares no domains: it can reach nothing outside itself.
        </div>
      ) : (
        lines
      )}
      <AuditLog entries={audit} />
    </div>
  );
};

/**
 * A call whose View is up before its record is: it is streaming its arguments, or has them all and is running
 * (`docs/architecture/mcp-apps.md` → Lifecycle). Its record, when it finishes, comes as `AppFrameProps.record` to the
 * frame that is already there.
 */
export interface RunningCall {
  readonly callId: string;
  readonly server: string;
  /** The tool as its server names it. */
  readonly tool: string;
  /** The arguments so far while the call streams; all of them once `final` (its message was committed); none for a call that stopped. */
  readonly arguments: ToolArguments | undefined;
  readonly final: boolean;
}

export interface AppFrameProps {
  /** The finished call's record: its arguments and whole result, sent to the View as soon as it is ready. */
  readonly record?: McpAppRecord | undefined;
  /** The call while it has no record: its partial input is sent, then its final input. One of this and `record` is given. */
  readonly running?: RunningCall | undefined;
  readonly page: AppPage;
  /** The tool as the inventory lists it, for `toolInfo` (its title and input schema) and the frame's title. */
  readonly tool: McpAppTool | undefined;
  /** The server's state as a badge: shown beside the App's name. */
  readonly badge: "offline" | "sign-in" | null;
  /** Where it is shown: its card, a Subagent Pane or page's thread, or an App Pane (`fullscreen`, filling the Pane). */
  readonly place?: AppPlace;
  /** What the owner can do about the View from its header: collapse it, pop it out to an App Pane, or put it back. */
  readonly controls?: AppControls;
  /** The View asked for another display mode (`ui/request-display-mode`): its place moves it, tearing it down first. */
  readonly onRequestMode?: (mode: DisplayMode) => void;
  /** The View has, or no longer has, the keyboard focus: a View in use is not collapsed for a newer generation. */
  readonly onFocused?: (focused: boolean) => void;
  /** The View may only read (an archived Session's reopened View): `resources/read` is served, `tools/call` is not. */
  readonly readOnly?: boolean;
  /** The Session's client, which serves the View's requests of its server (`requests.ts`); none, and the View is served none. */
  readonly client?: AppRequestClient;
  /**
   * What the View may say to the conversation: `message` holds its `ui/message` in the composer, `context` sends its
   * `ui/update-model-context` to the Session. A frame is advertised and answers only those it is given.
   */
  readonly speech?: Partial<AppSpeech>;
  /** The last context the View told the model (the Session's `McpAppEntry.context`), shown as a chip. */
  readonly context?: McpAppContext | undefined;
  /** Open a link the owner confirmed in the Browser Pane; without it the confirmation offers only Open. */
  readonly onOpenInPane?: (url: string) => void;
  /** The link that signs in to the call's server (a step-up, for more access), or none while the Environment is unknown. */
  readonly signInHref?: (stepUp: boolean) => string | undefined;
  /**
   * Its place is ending this View (its call was evicted, its server is gone or shadowed, the owner collapsed or moved it):
   * the frame stays until its View has been told to tear down and has answered (at most 2 s), then `onClosed` says it may go.
   */
  readonly closing?: boolean;
  /** For a call that did not finish: the `tool-cancelled` reason, sent when it is known and before any teardown. */
  readonly cancelled?: string | undefined;
  readonly onClosed?: () => void;
}

/** The header's buttons a place adds: each is there only when the place can do it. */
export interface AppControls {
  readonly onCollapse?: () => void;
  readonly onPopOut?: () => void;
  readonly onBack?: () => void;
}

const BADGES = { offline: "Server offline", "sign-in": "Needs sign-in" } as const;

/**
 * An App View: a frame at the sandbox origin the Session named, and the bridge that hands it its page and the call. The
 * bridge is built and closed with the frame (a failure to start the View shows as "App couldn't load" with Retry, which
 * builds both again). The View is sent the call's arguments and whole result as soon as it is ready; it is told of the page's
 * theme and the card's width as they change, and its own height is the card's, up to the inline cap.
 */
export const AppFrame = (props: AppFrameProps) => {
  // What the frame is of. A page or call that differs from it is not swapped in at once: the View it holds is told to tear
  // down first, and the new frame mounts when it has answered (`epoch` makes it a new component, with new state).
  // What the frame may do is part of what it is of: a View reopened read only that is let go of by an unarchive is made again
  // with every call served, so that its badge and its handlers agree.
  const readOnly = props.readOnly === true;

  const callId = props.record?.callId ?? props.running?.callId ?? "";

  const [shown, setShown] = useState({
    callId,
    page: props.page,
    readOnly,
    epoch: 0,
  });

  // The record that comes to a View mounted as its call streamed is the same call: it is not a new frame.
  const differs =
    shown.page !== props.page || shown.callId !== callId || shown.readOnly !== readOnly;

  return (
    <LiveFrame
      {...props}
      key={shown.epoch}
      page={shown.page}
      readOnly={shown.readOnly}
      closing={props.closing === true || differs}
      onClosed={() => {
        if (props.closing === true) props.onClosed?.();
        else {
          setShown((was) => ({
            callId,
            page: props.page,
            readOnly,
            epoch: was.epoch + 1,
          }));
        }
      }}
    />
  );
};

/** Why a View is told its call is over when it is torn down before the call has a result and nothing else says why. */
const UNSHOWN_REASON = "The call is no longer shown";

const NO_AUDIT: ReadonlyArray<McpAppAuditEntry> = [];

const LiveFrame = ({
  record,
  running,
  page,
  tool,
  badge,
  place = "card",
  controls,
  onRequestMode,
  onFocused,
  client,
  signInHref,
  speech,
  context,
  onOpenInPane,
  readOnly = false,
  closing = false,
  cancelled,
  onClosed,
}: AppFrameProps) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<Bridge | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  // What the frame reported, by the frame it reported it: a new frame (Retry, another page) starts again.
  const [failed, setFailed] = useState<{ key: string; reason: string } | null>(null);
  const [size, setSize] = useState<{ key: string; height: number } | null>(null);
  const [scrollerHeight, setScrollerHeight] = useState(0);
  const [details, setDetails] = useState(false);
  // What the View's requests came to, since the card mounted: a sign-in the server asked for, and the audit entries kept.
  const [signIn, setSignIn] = useState<{ stepUp: boolean } | null>(null);
  const [audited, setAudited] = useState<ReadonlyArray<McpAppAuditEntry>>([]);
  // The link the View asked to open, waiting for the owner (`open-link.ts`).
  const [link, setLink] = useState<PendingLink | null>(null);

  // Who the call is, from its record or, while it runs, from what the card knows of it.
  const call = record ?? running;
  const callId = call?.callId ?? "";
  const server = call?.server ?? "";
  const toolName = call?.tool ?? "";

  // The call is still going as far as the card knows: no record, and it was not said to have ended.
  const unfinished = record === undefined && running !== undefined && cancelled === undefined;

  const csp = declaredCsp(page.meta.csp);
  const src = frameUrl(page.origin, csp, window.location.origin);
  const frameKey = `${src}\0${attempt}`;
  // The one permission a View is given, and only when it declared it: the proxy's inner frame and the outer one both say so.
  const clipboardWrite = page.meta.permissions?.["clipboardWrite"] !== undefined;

  // The page's latest context, which a bridge reads when it answers `ui/initialize`, read again whenever it is needed.
  const latest = useRef({
    callId,
    toolName,
    tool,
    csp,
    place,
    onRequestMode,
    client,
    readOnly,
    speech,
    onOpenInPane,
    unfinished,
  });

  latest.current = {
    callId,
    toolName,
    tool,
    csp,
    place,
    onRequestMode,
    client,
    readOnly,
    speech,
    onOpenInPane,
    unfinished,
  };
  const inPane = isFullscreen(place);

  useLayoutEffect(() => {
    const element = frame.current;
    const target = element?.contentWindow;

    if (element === null || target === null || target === undefined) return;

    const scroller = scrollerOf(element);

    const contextNow = () => {
      const now = latest.current;

      const env = readEnvironment(element.clientWidth, scroller.clientHeight);

      return hostContextOf(
        env,
        {
          callId: now.callId,
          name: now.toolName,
          title: now.tool?.title,
          inputSchema: now.tool?.inputSchema,
        },
        displayOf(now.place, {
          height: element.clientHeight,
          mobile: env.mobile,
          insets: readSafeAreaInsets,
        }),
      );
    };

    let sent = contextNow();

    // What the View may ask its server, when the Session's client is there to serve it.
    const served =
      latest.current.client === undefined
        ? undefined
        : viewRequestHandlers(
            latest.current.client,
            callId,
            {
              onSignIn: (need) => {
                setSignIn((was) => ({ stepUp: need.stepUp || was?.stepUp === true }));
              },
              onAudit: (entry) => {
                setAudited((was) => auditLog(was, [entry]));
              },
            },
            { readOnly: latest.current.readOnly },
          );

    // What the View may say to the conversation: only what the frame was given. An archived Session's View (read only) is not
    // told the host takes it, and a View that says it all the same is refused: nothing is held for a Session that is archived.
    const given = latest.current.speech ?? {};

    const speaking = latest.current.readOnly ? refusingSpeech(given) : given;

    const viewPage: Types.Mutable<BridgeOptions["page"]> = { html: page.html };

    if (csp !== undefined) viewPage.csp = csp;

    if (clipboardWrite) viewPage.permissions = { clipboardWrite: {} };

    const bridge: Bridge = createBridge({
      frame: target,
      origin: page.origin,
      listen: (handler) => {
        const onMessage = (event: MessageEvent) => {
          handler({ source: event.source, origin: event.origin, data: event.data });
        };

        window.addEventListener("message", onMessage);

        return () => {
          window.removeEventListener("message", onMessage);
        };
      },
      page: viewPage,
      hostContext: () => {
        sent = contextNow();

        return sent;
      },
      // Only a frame with a Session's client serves the View's calls, so it is the only one that says it does.
      capabilities: hostCapabilities(
        csp,
        latest.current.client !== undefined,
        latest.current.readOnly,
        {
          openLinks: true,
          message: !latest.current.readOnly && speaking.message !== undefined,
          updateModelContext: !latest.current.readOnly && speaking.context !== undefined,
          clipboardWrite,
        },
      ),
      hostInfo: HOST_INFO,
      handlers: {
        ...served,
        ...speechHandlers(speaking),
        "ui/open-link": openLinkHandler({
          show: setLink,
          open: (url) => {
            window.open(url, "_blank", "noopener,noreferrer");
          },
          openInPane: (url) => {
            latest.current.onOpenInPane?.(url);
          },
        }),
        "ui/request-display-mode": displayModeHandler(latest.current.place, (mode) => {
          latest.current.onRequestMode?.(mode);
        }),
      },
      logs:
        latest.current.client === undefined
          ? undefined
          : viewLogSink(latest.current.client, callId),
      onEvent: (event) => {
        if (event.type === "failed") setFailed({ key: frameKey, reason: event.reason });

        if (event.type === "size" && event.height !== undefined) {
          setSize({ key: frameKey, height: event.height });
          setScrollerHeight(scroller.clientHeight);
        }
      },
    });

    bridgeRef.current = bridge;
    bridge.start();

    // The theme, and the card's width, as they change: the View is told what differs, once they settle.
    let timer: ReturnType<typeof setTimeout> | undefined;

    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = contextNow();
        const difference = changedContext(sent, next);

        sent = next;
        setScrollerHeight(scroller.clientHeight);

        if (difference !== undefined) bridge.hostContextChanged(difference);
      }, CONTEXT_DEBOUNCE_MS);
    };

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const resize = new ResizeObserver(changed);

    scheme.addEventListener("change", changed);
    resize.observe(element);

    return () => {
      clearTimeout(timer);
      scheme.removeEventListener("change", changed);
      resize.disconnect();

      // The View is asked to tear down, and the frame goes with the card at once: React cannot wait the 2 s the
      // spec allows it, so a View that saves on teardown is not sure to finish (docs/architecture/mcp-apps.md → As built).
      // A card that goes while its call was going (the message that made it is gone, a retry dropped it) tells the View the
      // call is over first, then asks it to tear down; a call that ended said so already, and the bridge says it once.
      if (latest.current.unfinished) bridge.toolCancelled(UNSHOWN_REASON);

      void bridge.teardown();
      bridgeRef.current = undefined;
    };
    // The bridge is the frame's: it is built again for another page, origin, call or Retry, never for a context change.
  }, [frameKey, page.origin, page.html, callId, clipboardWrite]);

  // What the View is told of its call, as the call goes on: the partial input, at most every 250 ms, while it streams; the
  // final input once it is committed; the result when the record comes; and the end of it when it did not finish. The bridge
  // holds all of it until the View is ready and sends each of the last three once. The throttle is the bridge's own: a new
  // bridge (Retry) starts a new one.
  const feeding = useRef<{ bridge: Bridge; partial: PartialFeed } | undefined>(undefined);
  const streamedArguments = running?.arguments;
  const streamFinal = running?.final === true;

  useEffect(() => {
    const bridge = bridgeRef.current;

    if (bridge === undefined) return;

    if (feeding.current?.bridge !== bridge) {
      feeding.current?.partial.stop();
      feeding.current = {
        bridge,
        partial: createPartialFeed((args) => {
          bridge.toolInputPartial(args);
        }),
      };
    }

    const { partial } = feeding.current;

    if (record !== undefined) {
      partial.stop();
      bridge.toolInput(record.arguments);
      // SAFETY: the record keeps the whole CallToolResult as JSON (`content`, `structuredContent`, `isError`, `_meta`), which is what `tool-result` carries.
      bridge.toolResult(record.result as McpUiToolResultNotification["params"]);

      return;
    }

    if (streamedArguments !== undefined) {
      if (streamFinal) {
        partial.stop();
        bridge.toolInput(streamedArguments);
      } else partial.push(streamedArguments);
    }

    if (cancelled !== undefined) {
      partial.stop();
      bridge.toolCancelled(cancelled);
    }
  }, [frameKey, page.origin, page.html, callId, record, streamedArguments, streamFinal, cancelled]);

  useEffect(
    () => () => {
      feeding.current?.partial.stop();
    },
    [],
  );

  // A place that ends its View keeps the frame until the View has torn down: the frame leaves only when `onClosed` is told.
  // A View that never came up (no bridge) has nothing to tear down.
  const latestClosed = useRef(onClosed);

  latestClosed.current = onClosed;

  const cancelReason = useRef(cancelled);

  cancelReason.current = cancelled;

  // Once per frame: a frame that has been told to close is dead (its bridge closes with the teardown), and its place makes
  // a new one, so a second ask (a Strict Mode double run, a `closing` that flips back and on, a guard that finds it already
  // closing) must not retire it, or say `onClosed`, again. It is the same promise.
  const retiring = useRef<Promise<void> | undefined>(undefined);

  const closeOnce = (): Promise<void> => {
    retiring.current ??=
      bridgeRef.current === undefined
        ? Promise.resolve()
        : // A View torn down before its call has a result is told the call is over first, whoever ends it.
          retire(
            bridgeRef.current,
            cancelReason.current ?? (latest.current.unfinished ? UNSHOWN_REASON : undefined),
          );

    return retiring.current;
  };

  // The place is told once that the frame has gone, and it makes the next one (or the note), however the closing began: its
  // own, or a guard's that found the frame already dead.
  const told = useRef(false);

  const tell = () => {
    if (told.current) return;

    told.current = true;
    latestClosed.current?.();
  };

  const ending = useRef({ closeOnce, tell });

  ending.current = { closeOnce, tell };

  useEffect(() => {
    if (closing) void ending.current.closeOnce().then(ending.current.tell);
  }, [closing]);

  // An unmount the page drives (leaving it, a subagent's card closed, a branch switched) removes the frame at once, which
  // ends its View without a word, so what is about to cause one asks first (`teardown.ts`): it finds this frame here.
  useEffect(
    () =>
      appViews.register({
        callId,
        element: () => frame.current,
        place,
        retire: () => ending.current.closeOnce(),
        // A frame that was retired and is wanted after all: the place is told, and makes a new one.
        restart: () => {
          void ending.current.closeOnce().then(ending.current.tell);
        },
      }),
    [callId, place],
  );

  // Whether the View has the keyboard focus: its frame is the document's active element (`focus.ts`, which also sees focus
  // pass from one frame to another).
  const latestFocused = useRef(onFocused);

  latestFocused.current = onFocused;

  useEffect(() => {
    const stop = focusWatch().subscribe((active) => {
      latestFocused.current?.(active !== null && active === frame.current);
    });

    return () => {
      stop();
      latestFocused.current?.(false);
    };
  }, []);

  if (failed?.key === frameKey) {
    return (
      <AppFailed
        reason={failed.reason}
        onRetry={() => {
          setAttempt((count) => count + 1);
        }}
      />
    );
  }

  const reported = size?.key === frameKey ? size.height : undefined;
  const height = inlineHeight(reported, scrollerHeight);
  const shownBadge = badge === "sign-in" || signIn !== null ? "sign-in" : badge;
  const signInLink = shownBadge === "sign-in" ? signInHref?.(signIn?.stepUp === true) : undefined;
  const frameClass = page.meta.prefersBorder === false ? "block w-full" : "block w-full border-t";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        // An App Pane is the View's whole container: both axes are fixed, and it fills the Pane.
        inPane ? "flex min-h-0 flex-1 flex-col" : "my-2",
      )}
      data-app-view={callId}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span className="text-foreground">App</span>
        <span>·</span>
        <span className="min-w-0 truncate">{server}</span>
        {shownBadge !== null && (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{BADGES[shownBadge]}</span>
        )}
        {readOnly && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">Read only</span>}
        {signInLink !== undefined && (
          <a
            href={signInLink}
            target="_blank"
            rel="noopener"
            aria-label={`Sign in to ${server}${signIn?.stepUp === true ? " for more access" : ""} (opens in a new tab)`}
            className="shrink-0 underline underline-offset-2 hover:text-foreground"
          >
            Sign in
          </a>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <AppControlButtons controls={controls} />
          <HeaderButton
            expanded={details}
            onClick={() => {
              setDetails((open) => !open);
            }}
          >
            Details
          </HeaderButton>
        </span>
      </div>
      {details && <AppDetails page={page} audit={auditLog(record?.audit ?? NO_AUDIT, audited)} />}
      <AppContextChip context={context} />
      {link !== null && (
        <LinkConfirmation link={link} server={server} canOpenInPane={onOpenInPane !== undefined} />
      )}
      <iframe
        ref={frame}
        key={frameKey}
        src={src}
        allow={clipboardWrite ? "clipboard-write" : undefined}
        title={`App: ${tool?.title ?? toolName} (${server})`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className={cn(frameClass, inPane && "min-h-0 flex-1")}
        style={inPane ? undefined : { height }}
      />
    </div>
  );
};

/**
 * What the card asks before a link its View wants opened is: the whole URL with its host emphasised, so a long one cannot
 * pass for another host, and the owner's choice. Open goes to a new tab with no opener or referrer; dismissing, or a newer
 * link, answers the View's request `-32000`.
 */
const LinkConfirmation = ({
  link,
  server,
  canOpenInPane,
}: {
  link: PendingLink;
  server: string;
  canOpenInPane: boolean;
}) => (
  <div
    role="group"
    aria-label="Open link?"
    className="space-y-1.5 border-t bg-muted/40 px-2 py-1.5 text-xs"
    onKeyDown={(event) => {
      if (event.key === "Escape") link.settle("dismiss");
    }}
  >
    <div>The {server} app wants to open a link:</div>
    <div className="font-mono break-all" data-link="">
      <span className="text-muted-foreground">{link.before}</span>
      <strong className="text-foreground">{link.host}</strong>
      <span className="text-muted-foreground">{link.after}</span>
    </div>
    <div className="flex flex-wrap items-center gap-1">
      <Button
        size="sm"
        onClick={() => {
          link.settle("open");
        }}
      >
        Open
      </Button>
      {canOpenInPane && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            link.settle("pane");
          }}
        >
          Open in Browser Pane
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          link.settle("dismiss");
        }}
      >
        Dismiss
      </Button>
    </div>
  </div>
);

/** One of the header's text buttons. */
const HeaderButton = ({
  onClick,
  expanded,
  children,
}: {
  onClick: () => void;
  expanded?: boolean;
  children: string;
}) => (
  <button
    type="button"
    className="rounded-sm px-1 hover:bg-accent hover:text-accent-foreground"
    aria-expanded={expanded}
    onClick={onClick}
  >
    {children}
  </button>
);

/** What the owner can do about a View from its header: collapse it, pop it out, or put it back in the chat. */
const AppControlButtons = ({ controls }: { controls: AppControls | undefined }) => (
  <>
    {controls?.onCollapse !== undefined && (
      <HeaderButton onClick={controls.onCollapse}>Collapse</HeaderButton>
    )}
    {controls?.onPopOut !== undefined && (
      <HeaderButton onClick={controls.onPopOut}>Pop out</HeaderButton>
    )}
    {controls?.onBack !== undefined && (
      <HeaderButton onClick={controls.onBack}>Back to chat</HeaderButton>
    )}
  </>
);
