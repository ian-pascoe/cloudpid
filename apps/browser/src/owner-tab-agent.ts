// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
// The agent in the owner's Owner tabs (`docs/spec.md` → Browser → Browser Pane): `browser` given an Owner tab runs the
// model's code in that tab's own `agents/browser` scope (`owner-tab:<id>`), whose active tab is the Owner tab, so
// `browserTool`'s per-scope machinery applies as is and the conversation's own tab and active tab are left alone. What
// the agent is told of the Owner tabs without a run is the Pane's listing (`OwnerTabs.tabs`).
//
// The owner keeps using the tab during a run, so three rules sit here. A run never changes the Owner tab's size (the
// Pane sets it) and stays in the Owner tab: the connection `browserTool` drives an Owner-tab scope through refuses the
// commands that would size the page or work in another tab (`confinedToOwnerTabs`), so the scope's active tab stays the
// Owner tab. A run is never started in an Owner tab that is gone: `browserTool` would open a blank tab in its place (or
// start a browser), so the tab is looked up first, from the stored records. And an Owner tab closed during the run makes
// the run an error that says so, whatever the code returned.
import type { BrowserRun } from "@cloudpid/extensions/browser/contract";
import type { BrowserConnection } from "agents/browser";
import type { BrowserSource } from "agents/browser/pi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type OwnerTabList, ownerTabScope } from "./owner-tabs.ts";
import type { Tab } from "./tab.ts";

const OWNER_TAB_SCOPE = ownerTabScope("");

/** Whether `scope` is an Owner tab's. */
export const isOwnerTabScope = (scope: string | undefined): boolean =>
  scope?.startsWith(OWNER_TAB_SCOPE) === true;

/**
 * Commands that would change a page's size or zoom: the owner's Browser Pane sets the Owner tab's, which every
 * connection to the page shares, and a run must leave it as it is.
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

const OTHER_TAB =
  'In an Owner tab you work in that tab alone, with sessionId: "active". For another Owner tab, run browser with its ID; for a page of your own, run browser without tab.';

/** The page a command names (`Target.attachToTarget`'s), if its params name one. */
const decodeTarget = Schema.decodeUnknownOption(Schema.Struct({ targetId: Schema.String }));

/**
 * Why a run in an Owner tab may not send `method`, which names page `targetId` (if any), or undefined when it may; `tab`
 * is the Owner tab's page.
 */
const refusal = (
  method: string,
  targetId: string | undefined,
  tab: string | undefined,
): string | undefined => {
  if (VIEWPORT_COMMANDS.has(method)) {
    return `${method} is not available in an Owner tab: the owner's Browser Pane sets its size.`;
  }

  if (method === "Target.createTarget") {
    return `Target.createTarget is not available in an Owner tab. ${OTHER_TAB}`;
  }

  if (method === "Target.attachToTarget" && targetId !== tab) return OTHER_TAB;

  return undefined;
};

/** Keep `connection`, an Owner-tab scope's, to its Owner tab: refuse what would size the page or work elsewhere. */
const confine = (connection: BrowserConnection): void => {
  const { cdp } = connection;
  // The scope's tab, as its record names it: the Owner tab, or none when that is gone (then nothing is sent to a page).
  const tab = connection.activeTargetId;
  const send = cdp.send.bind(cdp);
  const attach = cdp.attachToTarget.bind(cdp);

  cdp.send = (method, params, options) => {
    const targetId = Option.getOrUndefined(
      Option.map(decodeTarget(params, { onExcessProperty: "ignore" }), (named) => named.targetId),
    );

    const refused = refusal(method, targetId, tab);

    return refused === undefined
      ? send(method, params, options)
      : Promise.reject(new Error(refused));
  };

  cdp.attachToTarget = (targetId, options) =>
    targetId === tab ? attach(targetId, options) : Promise.reject(new Error(OTHER_TAB));
};

/**
 * `browser` as `browserTool` should drive it: as it is for a conversation's scope, and confined to the Owner tab for an
 * Owner tab's (`confine`).
 */
export const confinedToOwnerTabs = (browser: BrowserSource): BrowserSource => ({
  name: browser.name,
  connect: async (options) => {
    const connection = await browser.connect(options);

    if (isOwnerTabScope(options?.scope)) confine(connection);

    return connection;
  },
});

/** What a run in an Owner tab reads of the host's Owner tabs and browser. */
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
 * that is not open, fails without running anything; one that closes during the run makes the run an error that says so,
 * before what the run returned.
 */
export const runInOwnerTab = async (
  id: string,
  browser: OwnerTabRunBrowser,
  run: (scope: string) => Promise<BrowserRun>,
): Promise<BrowserRun> => {
  if (!browser.list().tabs.some((tab) => tab.id === id)) {
    return failed(`There is no Owner tab ${id}. The owner opens Owner tabs in the Browser Pane.`);
  }

  const scope = ownerTabScope(id);
  const before = await browser.tabOf(scope);

  if (before === undefined) {
    return failed(
      `The Owner tab ${id} is closed: the owner closed it, or its browser was closed or replaced. Nothing ran.`,
    );
  }

  const result = await run(scope);
  const after = await browser.tabOf(scope);

  if (after?.targetId === before.targetId) return result;

  return {
    ...result,
    isError: true,
    output: [
      {
        type: "text",
        text: `The Owner tab ${id} was closed during the run (by the owner, or with its browser), which ended the run: what it did before is below, and nothing after it happened.`,
      },
      ...result.output,
    ],
  };
};
