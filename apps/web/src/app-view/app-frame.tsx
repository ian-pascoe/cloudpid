// docs/architecture/mcp-apps.md → App Views in the transcript, The bridge. One App View in its card: the sandbox's proxy
// frame, the bridge to the View inside it, and the card's own chrome (what it is, whose, where it is served, its CSP).
// The frame never takes focus and is given no permission of the browser's: those are what later tickets turn on.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off -- DOM effects: a native debounce timer and observers.
import type { McpAppRecord, McpAppTool } from "@cloudpid/protocol";
import type { McpUiToolResultNotification } from "@modelcontextprotocol/ext-apps";
import { Check, Copy } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { copyToClipboard } from "../lib/clipboard.ts";
import { createBridge, retire, type Bridge } from "./bridge.ts";
import { declaredCsp, frameUrl } from "./frame-url.ts";
import {
  changedContext,
  hostCapabilities,
  hostContextOf,
  HOST_INFO,
  inlineHeight,
} from "./host-context.ts";
import type { AppPage } from "./load.ts";
import { readEnvironment, scrollerOf } from "./page-environment.ts";

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

/** The card's details: where the View is served, what its CSP lets it reach, and the origin it asked for. */
const AppDetails = ({ page }: { page: AppPage }) => {
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
    </div>
  );
};

export interface AppFrameProps {
  readonly record: McpAppRecord;
  readonly page: AppPage;
  /** The tool as the inventory lists it, for `toolInfo` (its title and input schema) and the frame's title. */
  readonly tool: McpAppTool | undefined;
  /** The server's state as a badge: shown beside the App's name. */
  readonly badge: "offline" | "sign-in" | null;
  /**
   * The card is ending this View (its call was evicted, its server is gone or shadowed, or the owner collapsed it): the frame
   * stays until its View has been told to tear down and has answered (at most 2 s), then `onClosed` says it may go.
   */
  readonly closing?: boolean;
  /** For a call that did not finish: the `tool-cancelled` reason sent before the teardown (the streaming mount's, #496). */
  readonly cancelled?: string;
  readonly onClosed?: () => void;
  /** The View's frame is in the card: what ends it must wait for its teardown. */
  readonly onFramed?: () => void;
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
  const [shown, setShown] = useState({ record: props.record, page: props.page, epoch: 0 });
  const differs = shown.page !== props.page || shown.record.callId !== props.record.callId;

  return (
    <LiveFrame
      {...props}
      key={shown.epoch}
      record={shown.record}
      page={shown.page}
      closing={props.closing === true || differs}
      onClosed={() => {
        if (props.closing === true) props.onClosed?.();
        else setShown((was) => ({ record: props.record, page: props.page, epoch: was.epoch + 1 }));
      }}
    />
  );
};

const LiveFrame = ({
  record,
  page,
  tool,
  badge,
  closing = false,
  cancelled,
  onClosed,
  onFramed,
}: AppFrameProps) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<Bridge | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  // What the frame reported, by the frame it reported it: a new frame (Retry, another page) starts again.
  const [failed, setFailed] = useState<{ key: string; reason: string } | null>(null);
  const [size, setSize] = useState<{ key: string; height: number } | null>(null);
  const [scrollerHeight, setScrollerHeight] = useState(0);
  const [details, setDetails] = useState(false);

  const csp = declaredCsp(page.meta.csp);
  const src = frameUrl(page.origin, csp, window.location.origin);
  const frameKey = `${src}\0${attempt}`;

  // The page's latest context, which a bridge reads when it answers `ui/initialize`, read again whenever it is needed.
  const latest = useRef({ record, tool, csp });

  latest.current = { record, tool, csp };

  useLayoutEffect(() => {
    const element = frame.current;
    const target = element?.contentWindow;

    if (element === null || target === null || target === undefined) return;

    const scroller = scrollerOf(element);

    const contextNow = () => {
      const now = latest.current;

      return hostContextOf(readEnvironment(element.clientWidth, scroller.clientHeight), {
        callId: now.record.callId,
        name: now.record.tool,
        title: now.tool?.title,
        inputSchema: now.tool?.inputSchema,
      });
    };

    let sent = contextNow();

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
      page: csp === undefined ? { html: page.html } : { html: page.html, csp },
      hostContext: () => {
        sent = contextNow();

        return sent;
      },
      capabilities: hostCapabilities(csp),
      hostInfo: HOST_INFO,
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
    bridge.toolInput(record.arguments);
    // SAFETY: the record keeps the whole CallToolResult as JSON (`content`, `structuredContent`, `isError`, `_meta`), which is what `tool-result` carries.
    bridge.toolResult(record.result as McpUiToolResultNotification["params"]);

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
      void bridge.teardown();
      bridgeRef.current = undefined;
    };
    // The bridge is the frame's: it is built again for another page, origin, call or Retry, never for a context change.
  }, [frameKey, page.origin, page.html, record.callId]);

  // A card that ends its View keeps the frame until the View has torn down: the frame leaves only when `onClosed` is told.
  // A View that never came up (no bridge) has nothing to tear down.
  const latestClosed = useRef(onClosed);

  latestClosed.current = onClosed;

  const cancelReason = useRef(cancelled);

  cancelReason.current = cancelled;

  useEffect(() => {
    if (!closing) return;

    const bridge = bridgeRef.current;

    void (bridge === undefined ? Promise.resolve() : retire(bridge, cancelReason.current)).then(
      () => {
        latestClosed.current?.();
      },
    );
  }, [closing]);

  useEffect(() => {
    onFramed?.();
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

  return (
    <div className="my-2 overflow-hidden rounded-md border" data-app-view={record.callId}>
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span className="text-foreground">App</span>
        <span>·</span>
        <span className="min-w-0 truncate">{record.server}</span>
        {badge !== null && (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{BADGES[badge]}</span>
        )}
        <button
          type="button"
          className="ml-auto shrink-0 rounded-sm px-1 hover:bg-accent hover:text-accent-foreground"
          aria-expanded={details}
          onClick={() => {
            setDetails((open) => !open);
          }}
        >
          Details
        </button>
      </div>
      {details && <AppDetails page={page} />}
      <iframe
        ref={frame}
        key={frameKey}
        src={src}
        title={`App: ${tool?.title ?? record.tool} (${record.server})`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className={page.meta.prefersBorder === false ? "block w-full" : "block w-full border-t"}
        style={{ height }}
      />
    </div>
  );
};
