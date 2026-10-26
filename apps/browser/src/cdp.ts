// @effect-diagnostics asyncFunction:off preferEffectArray:off schemaSync:off preferTypedSchemaDecoder:off extendsNativeError:off missingPipeableSignature:off
// What the browser host says to Browser Run over CDP for the owner's Live Views (ADR-0013), a Browser Handoff's
// (`./handoff.ts`) and the Browser Pane's (`./owner-tabs.ts`) alike: the connection it speaks over, the pages a tab
// opened, and the 60-second links that open them. Nothing here keeps or logs a link.
import type { LiveViewLinks, LiveViewWindow } from "@cloudpid/extensions/browser/contract";
import * as Schema from "effect/Schema";

/** What a CDP command takes: JSON. */
export type CdpParams = { readonly [key: string]: Schema.Json };

/** A CDP event, as the connection hands it over. */
export type CdpEvent = {
  readonly method: string;
  readonly params?: Schema.Json | undefined;
  readonly sessionId?: string | undefined;
};

/** One CDP connection to a Browser Run session. */
export type CdpTransport = {
  /** Send a command, in the CDP session `sessionId` when given; resolves with its result, rejects on an error or a timeout. */
  send(method: string, params?: CdpParams, sessionId?: string): Promise<Schema.Json>;
  /** Called for every event; one listener. */
  onEvent(listener: (event: CdpEvent) => void): void;
  /** Called once when the connection ends. */
  onClose(listener: () => void): void;
  close(): void;
};

/** Browser Run no longer has the browser or the tab: what needed it cannot go on. */
export class BrowserGoneError extends Error {
  override readonly name = "BrowserGoneError";
}

/** Whether `error` is Browser Run saying the page is not there. */
export const isNoTarget = (error: unknown): error is Error =>
  error instanceof Error && /no target|not found/i.test(error.message);

/** How long a Live View link may start a connection: Browser Run's minimum. */
export const LIVE_VIEW_MS = 60_000;

const LiveView = Schema.Struct({ webSocketDebuggerUrl: Schema.String });

/** A page target of the browser, as `Target.getTargets` lists it. */
export type PageTarget = {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly openerId?: string;
  /**
   * Whether the page can still reach the page that opened it (`window.opener`). False for a link that opens a new tab
   * (`target=_blank` is `noopener` by default) and for `window.open(..., "noopener")`; true for a pop-up. Absent when
   * the browser does not say.
   */
  readonly canAccessOpener?: boolean;
};

/** A page a tab opened, as `windowsOf` finds it. */
export type OpenedWindow = PageTarget & { readonly openerId: string };

const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      type: Schema.String,
      title: Schema.String,
      url: Schema.String,
      openerId: Schema.optionalKey(Schema.String),
      canAccessOpener: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

/** The pages of the browser, as `Target.getTargets` on a browser-level connection lists them. */
export const pagesOf = async (transport: CdpTransport): Promise<PageTarget[]> => {
  const { targetInfos } = await ask(
    { transport, cdpSessionId: undefined },
    "Target.getTargets",
    {},
    Targets,
  );

  return targetInfos.filter((target) => target.type === "page");
};

/**
 * Send `method` and read the fields `reply` names of its answer: an answer without them fails, and any other field is
 * ignored. It goes in CDP session `cdpSessionId`, or to the browser itself when that is undefined.
 */
export const ask = async <A>(
  live: { readonly transport: CdpTransport; readonly cdpSessionId: string | undefined },
  method: string,
  params: CdpParams,
  reply: Schema.Decoder<A>,
): Promise<A> =>
  Schema.decodeUnknownSync(reply)(await live.transport.send(method, params, live.cdpSessionId), {
    onExcessProperty: "ignore",
  });

/**
 * A fresh Live View link to page `targetId` (`Cloudflare.getLiveView`, `mode: "tab"`): good for 60 s and named by its
 * target, since without one Browser Run picks the newest page of the browser. Sent in CDP session `cdpSessionId`, or to
 * the browser when that is undefined.
 */
export const mintLink = async (
  transport: CdpTransport,
  targetId: string,
  cdpSessionId?: string,
): Promise<string> =>
  (
    await ask(
      { transport, cdpSessionId },
      "Cloudflare.getLiveView",
      { mode: "tab", expiresInMs: LIVE_VIEW_MS, targetId },
      LiveView,
    )
  ).webSocketDebuggerUrl;

/**
 * The pages tab `tabId` opened, directly or through a page it opened, from Browser Run's targets on the browser: pop-ups
 * and new tabs, `noopener` ones included, all name their opener (`openerId`, the spike, #152). A page with no opener (a
 * tab the agent made with `Target.createTarget`, another conversation's) is not one of them. A page `except` names is
 * left out, and so is what it opened: it is not a window of this tab (an Owner tab a link opened has windows of its own).
 */
export const windowsAmong = (
  pages: ReadonlyArray<PageTarget>,
  tabId: string,
  except: (target: PageTarget) => boolean = () => false,
): OpenedWindow[] => {
  const found: OpenedWindow[] = [];
  const openers = [tabId];

  // Breadth first, so a window comes after the one that opened it; a page is taken once, whatever its opener says.
  for (let next = openers.shift(); next !== undefined; next = openers.shift()) {
    for (const target of pages) {
      if (
        target.openerId === next &&
        target.targetId !== tabId &&
        !except(target) &&
        !found.some((window) => window.targetId === target.targetId)
      ) {
        found.push({ ...target, openerId: next });
        openers.push(target.targetId);
      }
    }
  }

  return found;
};

/** `windowsAmong` the browser's pages now. */
export const windowsOf = async (
  transport: CdpTransport,
  tabId: string,
  except?: (target: PageTarget) => boolean,
): Promise<OpenedWindow[]> => windowsAmong(await pagesOf(transport), tabId, except);

export type ViewLinkOptions = {
  /** Sees the windows found before their links are minted. */
  readonly noting?: (windows: ReadonlyArray<OpenedWindow>) => Promise<void>;
  /** Pages that are not windows (`windowsAmong`). */
  readonly except?: (target: PageTarget) => boolean;
};

/**
 * Fresh links to tab `tab.targetId` (sent in CDP session `tab.cdpSessionId`, or to the browser) and to every window it
 * opened (`windowsOf`), each minted on the browser. `options.noting` sees the windows found before their links are minted. A
 * window that closes before its link is minted is left out, as one that closed before the listing is; Browser Run saying
 * the tab itself is not there fails the call (`isNoTarget`), for the caller to say what is gone. `options.except` names pages
 * that are not windows (`windowsAmong`).
 */
export const mintViewLinks = async (
  transport: CdpTransport,
  tab: { readonly targetId: string; readonly cdpSessionId?: string | undefined },
  { noting, except }: ViewLinkOptions = {},
): Promise<LiveViewLinks> => {
  const [link, found] = await Promise.all([
    mintLink(transport, tab.targetId, tab.cdpSessionId),
    windowsOf(transport, tab.targetId, except),
  ]);

  await noting?.(found);

  const minted = await Promise.all(
    found.map(async ({ targetId, openerId, title }): Promise<LiveViewWindow | undefined> => {
      try {
        return { targetId, openerId, title, link: await mintLink(transport, targetId) };
      } catch (error) {
        if (isNoTarget(error)) return undefined;

        throw error;
      }
    }),
  );

  return {
    tab: { targetId: tab.targetId, link },
    windows: minted.filter((window) => window !== undefined),
  };
};
