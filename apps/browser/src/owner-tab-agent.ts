// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
// The agent in the owner's Owner tabs (`docs/spec.md` → Browser → Browser Pane): `browser` given an Owner tab runs the
// model's code in that tab's own `agents/browser` scope (`owner-tab:<id>`), whose active tab is the Owner tab, so
// `browserTool`'s per-scope machinery applies as is and the conversation's own tab and active tab are left alone. What
// the agent is told of the Owner tabs without a call is the Pane's listing (`OwnerTabs.tabs`).
//
// The owner keeps using the tab during a call, so the host holds a call there to a few rules. They keep a well-meaning
// agent from getting in the owner's way; they are not a security boundary, since the code can still make the page do
// what a page can (below).
//
// - The call works in the Owner tab alone and leaves its size: the connection `browserTool` drives an Owner-tab scope
//   through refuses, by name, the CDP commands that would size the page (a full-page screenshot included), open a tab,
//   or attach to, show, close or auto-attach to another page (`confinedToOwnerTabs`), so the scope's active tab stays the
//   Owner tab. What the page does itself is not refused: a `window.open`, a link with `target=_blank` or a middle click
//   the code dispatches still opens a page, which joins the Owner tabs as the owner's own clicks do.
// - A call never starts in an Owner tab that is gone, where `browserTool` would open a blank tab (or start a browser)
//   under a scope whose record was just deleted. Calls in one Owner tab go one at a time, and each looks the tab up from
//   the stored records when its turn comes (`OwnerTabCalls`); so does every connection to the scope, in case the tab
//   goes while the call works.
// - An Owner tab closed during the call makes the call an error that says so, whatever the code returned.
import type { BrowserRun } from "@cloudpid/extensions/browser/contract";
import type { BrowserConnection } from "agents/browser";
import type { BrowserSource } from "agents/browser/pi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type OwnerTabList, ownerTabScope } from "./owner-tabs.ts";
import type { Tab } from "./tab.ts";

const OWNER_TAB_SCOPE = ownerTabScope("");

/** The Owner tab whose scope `scope` is, or undefined for another scope (a conversation's). */
const ownerTabOf = (scope: string | undefined): string | undefined =>
  scope?.startsWith(OWNER_TAB_SCOPE) === true ? scope.slice(OWNER_TAB_SCOPE.length) : undefined;

/** What the agent is told of a call in Owner tab `id` that found it closed: nothing ran. */
const closedText = (id: string): string =>
  `The Owner tab ${id} is closed: the owner closed it, or its browser was closed or replaced. Nothing ran.`;

/**
 * Commands that would change a page's size or zoom: the owner's Browser Pane sets the Owner tab's, which every
 * connection to the page shares, and a call must leave it as it is.
 */
const VIEWPORT_COMMANDS: ReadonlySet<string> = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setVisibleSize",
  "Emulation.setPageScaleFactor",
  "Emulation.resetPageScaleFactor",
  "Browser.setWindowBounds",
  "Browser.setContentsSize",
]);

/** Commands that reach pages other than the one they are sent to, whatever their params. */
const BROWSER_WIDE_COMMANDS: ReadonlySet<string> = new Set([
  "Target.createTarget",
  "Target.attachToBrowserTarget",
  "Target.autoAttachRelated",
  "Target.sendMessageToTarget",
]);

/** Commands that work on the page their `targetId` names: allowed on the Owner tab only. */
const TARGET_COMMANDS: ReadonlySet<string> = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.exposeDevToolsProtocol",
]);

const OTHER_TAB =
  'In an Owner tab you work in that tab alone, with sessionId: "active". For another Owner tab, call browser with its ID; for a page of your own, call browser without tab.';

/** The params of a command that a refusal reads, each on its own, so a stray field elsewhere hides none of them. */
type RefusalParams = {
  /** The page the command names, if `targetId` is a string. */
  readonly targetId?: string;
  /** Whether `captureBeyondViewport` is `true`. */
  readonly beyondViewport: boolean;
};

const decodeTargetId = Schema.decodeUnknownOption(Schema.Struct({ targetId: Schema.String }));

const decodeBeyondViewport = Schema.decodeUnknownOption(
  Schema.Struct({ captureBeyondViewport: Schema.Literal(true) }),
);

const IGNORE_EXCESS = { onExcessProperty: "ignore" } as const;

/**
 * Why a call in an Owner tab may not send `method` with `named` (what it reads of the params) on the page session
 * `sessionId` (the browser when none), or undefined when it may; `tab` is the Owner tab's page.
 */
const refusal = (
  method: string,
  named: RefusalParams,
  sessionId: string | undefined,
  tab: string,
): string | undefined => {
  if (VIEWPORT_COMMANDS.has(method)) {
    return `${method} is not available in an Owner tab: the owner's Browser Pane sets its size.`;
  }

  if (method === "Page.captureScreenshot" && named.beyondViewport) {
    return "captureBeyondViewport is not available in an Owner tab: it resizes the page while it captures, under the owner's eyes. Capture the viewport, or a clip of it.";
  }

  if (BROWSER_WIDE_COMMANDS.has(method))
    return `${method} is not available in an Owner tab. ${OTHER_TAB}`;

  if (TARGET_COMMANDS.has(method) && named.targetId !== tab) return OTHER_TAB;

  // On the browser it attaches to every page; on the Owner tab's session, to its frames and workers only.
  if (method === "Target.setAutoAttach" && sessionId === undefined) {
    return `Target.setAutoAttach is not available on the browser in an Owner tab: send it with sessionId: "active". ${OTHER_TAB}`;
  }

  return undefined;
};

/** Keep `connection`, an Owner-tab scope's, to its Owner tab `tab`: refuse what would size the page or work elsewhere. */
const confine = (connection: BrowserConnection, tab: string): void => {
  const { cdp } = connection;
  const send = cdp.send.bind(cdp);
  const attach = cdp.attachToTarget.bind(cdp);

  cdp.send = (method, params, options) => {
    // Each field on its own: any other field, or one of another type, is ignored.
    const targetId = Option.getOrUndefined(decodeTargetId(params, IGNORE_EXCESS))?.targetId;
    const beyondViewport = Option.isSome(decodeBeyondViewport(params, IGNORE_EXCESS));
    const named = targetId === undefined ? { beyondViewport } : { targetId, beyondViewport };
    const refused = refusal(method, named, options?.sessionId, tab);

    return refused === undefined
      ? send(method, params, options)
      : Promise.reject(new Error(refused));
  };

  cdp.attachToTarget = (targetId, options) =>
    targetId === tab ? attach(targetId, options) : Promise.reject(new Error(OTHER_TAB));
};

/**
 * `browser` as `browserTool` should drive it: as it is for a conversation's scope, and confined to the Owner tab for an
 * Owner tab's (`confine`). An Owner-tab scope is connected only while `tabOf` (read from the stored records, starting
 * nothing) says its tab is open, so a connection never starts a browser or opens a blank tab in place of one that is
 * gone; it fails with the closed-tab error instead.
 */
export const confinedToOwnerTabs = (
  browser: BrowserSource,
  tabOf: (scope: string) => Promise<Tab | undefined>,
): BrowserSource => ({
  name: browser.name,
  connect: async (options) => {
    const scope = options?.scope;
    const id = ownerTabOf(scope);

    if (scope === undefined || id === undefined) return browser.connect(options);

    const tab = await tabOf(scope);

    if (tab === undefined) throw new Error(closedText(id));

    const connection = await browser.connect(options);

    confine(connection, tab.targetId);

    return connection;
  },
});

/** What a call in an Owner tab reads of the host's Owner tabs and browser. */
export type OwnerTabRunBrowser = {
  /** The Owner tabs, as kept (`OwnerTabs.list`). */
  readonly list: () => OwnerTabList;
  /** The tab scope `scope` works in, if its browser is current and the tab open; read from the stored records. */
  readonly tabOf: (scope: string) => Promise<Tab | undefined>;
};

const failed = (text: string): BrowserRun => ({
  output: [{ type: "text", text }],
  isError: true,
});

/**
 * Run code in Owner tab `id` with `run`, which runs it in the scope it is given. An Owner tab the host does not have, or
 * that is not open, fails without running anything; one that closes during the call makes the call an error that says
 * so, before what the code returned.
 */
const runChecked = async (
  id: string,
  browser: OwnerTabRunBrowser,
  run: (scope: string) => Promise<BrowserRun>,
): Promise<BrowserRun> => {
  if (!browser.list().tabs.some((tab) => tab.id === id)) {
    return failed(`There is no Owner tab ${id}. The owner opens Owner tabs in the Browser Pane.`);
  }

  const scope = ownerTabScope(id);
  const before = await browser.tabOf(scope);

  if (before === undefined) return failed(closedText(id));

  const result = await run(scope);
  const after = await browser.tabOf(scope);

  if (after?.targetId === before.targetId) return result;

  return {
    ...result,
    isError: true,
    output: [
      {
        type: "text",
        text: `The Owner tab ${id} was closed during the call (by the owner, or with its browser), which ended it: what the code did before is below, and nothing after it happened.`,
      },
      ...result.output,
    ],
  };
};

/**
 * The calls in the host's Owner tabs, one at a time per Owner tab: a call waits for the one before it in the same tab
 * (as `browserTool` queues a scope's), and looks the tab up only when its turn comes (`runChecked`), so one queued
 * behind a long call fails, running nothing, when the tab closed meanwhile. Calls in different tabs go in parallel.
 */
export class OwnerTabCalls {
  readonly #browser: OwnerTabRunBrowser;
  /** The last call queued in each Owner tab, settled whatever came of it. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(browser: OwnerTabRunBrowser) {
    this.#browser = browser;
  }

  /** Run code in Owner tab `id` with `run`, after the calls queued there before it. */
  run(id: string, run: (scope: string) => Promise<BrowserRun>): Promise<BrowserRun> {
    const next = (this.#queues.get(id) ?? Promise.resolve()).then(() =>
      runChecked(id, this.#browser, run),
    );

    const settled = next.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });

    return next;
  }
}
