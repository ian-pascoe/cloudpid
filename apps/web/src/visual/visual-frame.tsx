// docs/architecture/visuals.md → The frame, Network and isolation. One Visual's frame: the App sandbox's proxy at the Session's
// Visual origin, sent the fixed policy through `?csp=`, its inner frame `allow-scripts allow-same-origin` with no referrer and
// no permission delegated; the page handed to it is the kept copy with the shim first in its `<head>`, injected here and
// never stored. The frame protocol is the one App Views speak (`sandbox-frame/frame-protocol.ts`), with only what display
// needs: the host context (the style variables and theme, live), the page's size, a link it opens (asked of the owner
// first) and an Escape it did not handle while it had the focus, which returns the focus to the card. There is no teardown: a Visual is a fixed copy
// with nothing to save, so the frame goes when its card says.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off -- DOM effects: a native debounce timer and observers.
import {
  VISUAL_CSP,
  VISUAL_ESCAPE,
  VISUAL_MIN_HEIGHT,
  withVisualShim,
  type VisualRecord,
} from "@cloudpid/protocol";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { focusWatch } from "../sandbox-frame/focus.ts";
import { createFrameProtocol } from "../sandbox-frame/frame-protocol.ts";
import { frameUrl } from "../sandbox-frame/frame-url.ts";
import { changedContext, hostStyleVariables } from "../sandbox-frame/host-context.ts";
import { openLinkHandler, type PendingLink } from "../sandbox-frame/open-link.ts";
import { GUARD_START, guardReport } from "./height.ts";

/** The host's name and version, as `ui/initialize` answers them. */
const HOST_INFO = { name: "cloudpid", version: "1" } as const;

/** How long a change of the page's theme settles before the page is told. */
const CONTEXT_DEBOUNCE_MS = 150;

/** The policy as the proxy is sent it: the list of resource hosts, and nothing else. */
const CSP = { resourceDomains: [...VISUAL_CSP.resourceDomains] };

/**
 * The inner frame's `sandbox` flags, sent with the page rather than left to the proxy's default (which adds `allow-forms`
 * for App Views): scripts and the origin's own storage, and nothing else.
 */
export const VISUAL_SANDBOX = "allow-scripts allow-same-origin";

/** What the page tells a Visual's host context of itself. */
export interface VisualEnvironment {
  readonly dark: boolean;
  /** A custom property's value on the page's root element, or an empty string. */
  readonly readProperty: (property: string) => string;
}

/**
 * A Visual's host context: the theme and the style variables (the same table as App Views'), and nothing else. Nothing of a
 * tool, since a Visual is no tool's View; nor the owner's locale, time zone, device or card size, which a page needs
 * no more than it is told by its own window.
 */
export const visualHostContext = (env: VisualEnvironment): McpUiHostContext => ({
  theme: env.dark ? "dark" : "light",
  styles: { variables: hostStyleVariables(env.readProperty) },
});

/** The page's environment: its theme and style variables, as they are now. */
const readEnvironment = (): VisualEnvironment => {
  const root = getComputedStyle(document.documentElement);

  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    readProperty: (property) => root.getPropertyValue(property),
  };
};

/** What a card says when its Visual could not come up. */
export const VisualFailed = ({ reason, onRetry }: { reason: string; onRetry: () => void }) => (
  <div role="alert" className="flex items-center gap-2 border-t px-3 py-2 text-xs text-destructive">
    <span className="min-w-0 flex-1 break-words">Visual couldn't start: {reason}</span>
    <Button variant="ghost" size="sm" onClick={onRetry}>
      Retry
    </Button>
  </div>
);

export interface VisualFrameProps {
  readonly record: VisualRecord;
  /** The Session's Visual origin, which the loader checked is an App sandbox's. */
  readonly origin: string;
  /** The height this device remembers for it: the frame starts at it, so the transcript does not move as it loads. */
  readonly initialHeight?: number | undefined;
  /** The height the frame was given, to be remembered. */
  readonly onHeight?: (height: number) => void;
  /** The page posted an Escape it did not handle while its frame had the focus: the card takes the focus back. */
  readonly onEscape?: () => void;
  /** The frame has, or no longer has, the keyboard focus: a frame in use is not unmounted. */
  readonly onFocused?: (focused: boolean) => void;
}

/**
 * A Visual's frame and the frame protocol to its page, built and closed with the frame: a page that does not finish its
 * handshake in 10 s shows "Visual couldn't start" with Retry, which builds both again. Its height is the page's, fitted and
 * guarded (`height.ts`); it never takes focus as it mounts, and Tab moves in and out of it as the browser does.
 */
export const VisualFrame = ({
  record,
  origin,
  initialHeight,
  onHeight,
  onEscape,
  onFocused,
}: VisualFrameProps) => {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<{ key: string; reason: string } | null>(null);
  const [height, setHeight] = useState(initialHeight ?? VISUAL_MIN_HEIGHT);
  // The link the page asked to open, waiting for the owner (`sandbox-frame/open-link.ts`).
  const [link, setLink] = useState<PendingLink | null>(null);

  const src = frameUrl(origin, CSP, window.location.origin);
  const frameKey = `${src}\0${attempt}`;
  const latest = useRef({ onHeight, onEscape });

  latest.current = { onHeight, onEscape };

  useLayoutEffect(() => {
    const element = frame.current;
    const target = element?.contentWindow;

    if (element === null || target === null || target === undefined) return;

    const contextNow = () => visualHostContext(readEnvironment());

    let sent = contextNow();
    let guard = GUARD_START;

    const protocol = createFrameProtocol({
      frame: target,
      origin,
      listen: (handler) => {
        const onMessage = (event: MessageEvent) => {
          handler({ source: event.source, origin: event.origin, data: event.data });
        };

        window.addEventListener("message", onMessage);

        return () => {
          window.removeEventListener("message", onMessage);
        };
      },
      page: { html: withVisualShim(record.html), csp: CSP, sandbox: VISUAL_SANDBOX },
      hostContext: () => {
        sent = contextNow();

        return sent;
      },
      capabilities: { openLinks: {} },
      hostInfo: HOST_INFO,
      subject: "Visual",
      handlers: {
        "ui/open-link": openLinkHandler({
          show: setLink,
          open: (url) => {
            window.open(url, "_blank", "noopener,noreferrer");
          },
          // A Visual's links open in a new tab: the Browser Pane is an App View's choice.
          openInPane: (url) => {
            window.open(url, "_blank", "noopener,noreferrer");
          },
        }),
      },
      notifications: {
        // Only while the frame has the focus: a page cannot take the focus from wherever the owner is.
        [VISUAL_ESCAPE]: () => {
          if (document.activeElement === element) latest.current.onEscape?.();
        },
      },
      onEvent: (event) => {
        if (event.type === "failed") setFailed({ key: frameKey, reason: event.reason });

        if (event.type === "size" && event.height !== undefined) {
          const next = guardReport(guard, event.height, performance.now());

          guard = next.guard;

          if (next.height !== undefined) {
            setHeight(next.height);
            latest.current.onHeight?.(next.height);
          }
        }
      },
    });

    protocol.start();

    // The theme, as it changes: the page is told what differs, once it settles.
    let timer: ReturnType<typeof setTimeout> | undefined;

    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = contextNow();
        const difference = changedContext(sent, next);

        sent = next;

        if (difference !== undefined) protocol.hostContextChanged(difference);
      }, CONTEXT_DEBOUNCE_MS);
    };

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");

    scheme.addEventListener("change", changed);

    return () => {
      clearTimeout(timer);
      scheme.removeEventListener("change", changed);
      protocol.close();
    };
    // The protocol is the frame's: it is built again for another page, origin or Retry, never for a context change.
  }, [frameKey, origin, record.html]);

  // Whether the page has the keyboard focus: its frame is the document's active element (`sandbox-frame/focus.ts`).
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
      <VisualFailed
        reason={failed.reason}
        onRetry={() => {
          setAttempt((count) => count + 1);
        }}
      />
    );
  }

  return (
    <>
      {link !== null && <LinkConfirmation link={link} />}
      <iframe
        ref={frame}
        key={frameKey}
        src={src}
        title={`Visual: ${record.title}`}
        aria-description={record.summary}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="block w-full border-t"
        style={{ height }}
      />
    </>
  );
};

/**
 * What the card asks before a link its page wants opened is: the whole URL with its host emphasised, so a long one cannot
 * pass for another host, and the owner's choice. Open goes to a new tab with no opener or referrer; dismissing, or a newer
 * link, answers the page's request `-32000`.
 */
const LinkConfirmation = ({ link }: { link: PendingLink }) => (
  <div
    role="group"
    aria-label="Open link?"
    className="space-y-1.5 border-t bg-muted/40 px-2 py-1.5 text-xs"
    onKeyDown={(event) => {
      if (event.key === "Escape") link.settle("dismiss");
    }}
  >
    <div>The Visual wants to open a link:</div>
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
