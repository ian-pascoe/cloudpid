// A scripted CDP connection to a fake Browser Run, and in-memory records, for the browser host's tests: a Browser
// Handoff's (`./handoff.test.ts`) and the Browser Pane's Owner tabs' (`./owner-tabs.test.ts`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off
import type { Schema } from "effect";
import * as Predicate from "effect/Predicate";
import type * as Types from "effect/Types";
import type { CdpEvent, CdpParams, CdpTransport } from "./cdp.ts";

/** The credential part of every Live View link the fake mints, to look for where it must not be. */
export const TOKEN = "SECRET-TOKEN";

/** The link the fake Browser Run mints for page `targetId`. */
export const linkTo = (targetId: string) =>
  `wss://live.browser.run/api/devtools/browser/browser-1/page/${targetId}?jwt=${TOKEN}`;

/** The tab's viewport as a page reads it. */
export type Viewport = { width: number; height: number; deviceScaleFactor: number };

/** The object's synchronous key-value storage, in memory, each value copied as workerd's is. */
export const records = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the host reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { readonly prefix: string }) =>
      // SAFETY: the host reads back only what it wrote under each prefix.
      [...map].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
};

export type Sent = {
  readonly method: string;
  readonly params?: CdpParams;
  readonly sessionId?: string;
};

/** A reply: as it is, or made from the command's params and the session it was sent in. */
export type Reply =
  | Schema.Json
  | ((params: CdpParams | undefined, sessionId: string | undefined) => Schema.Json);

/** A window's size when nothing has set one: a pop-up's, in the spike. */
export const WINDOW_SIZE: Viewport = { width: 400, height: 565, deviceScaleFactor: 1 };

/** A page target as `Target.getTargets` lists it. */
export const page = (targetId: string, rest: { [key: string]: Schema.Json } = {}) => ({
  targetId,
  type: "page",
  title: `Title of ${targetId}`,
  url: `https://example.com/${targetId}`,
  attached: false,
  canAccessOpener: false,
  browserContextId: "context-1",
  ...rest,
});

/**
 * A scripted connection: it records what it is sent, answers from `replies`, and lets a test emit events. It keeps each
 * page's viewport as Browser Run does, one for every connection: the tab's (`viewport`, session `cdp-1`) and each
 * window's (`windows`, by session `cdp-<targetId>`, `WINDOW_SIZE` unless set). `Emulation.setDeviceMetricsOverride` sets
 * it (unless `ignoreOverrides` says to drop that many first), `Emulation.clearDeviceMetricsOverride` puts the page's own
 * size back (unless `ignoreClears` says to drop that many), and `Runtime.evaluate` reads it.
 */
export const fakeTransport = (replies: Partial<Record<string, Reply>> = {}) => {
  const sent: Sent[] = [];
  let listener: (event: CdpEvent) => void = () => undefined;
  let closing: () => void = () => undefined;
  const viewport: Viewport = { width: 780, height: 493, deviceScaleFactor: 1 };

  const state = {
    closed: false,
    viewport,
    windows: new Map<string, Viewport>(),
    ignoreOverrides: 0,
    ignoreClears: 0,
  };

  const isTab = (sessionId: string | undefined) => sessionId === undefined || sessionId === "cdp-1";

  const defaults = {
    "Target.attachToTarget": (params) => {
      const targetId = params?.["targetId"];

      return {
        sessionId:
          targetId === "tab-1" || !Predicate.isString(targetId) ? "cdp-1" : `cdp-${targetId}`,
      };
    },
    "Target.getTargets": { targetInfos: [page("tab-1", { attached: true })] },
    "Cloudflare.getLiveView": (params) => {
      const asked = params?.["targetId"];
      const targetId = Predicate.isString(asked) ? asked : "newest";

      return {
        webSocketDebuggerUrl: linkTo(targetId),
        devtoolsFrontendUrl: `https://live.browser.run/ui/view?mode=tab&wss=${linkTo(targetId).slice(6)}`,
        id: targetId,
        options: { mode: "tab" },
      };
    },
    "Cloudflare.handoff": { targetId: "tab-1", handoffId: "handoff-1" },
    "Cloudflare.getHandoffState": { active: true, handoffId: "handoff-1" },
    "Cloudflare.handoffComplete": {},
    "Emulation.setDeviceMetricsOverride": (params, sessionId) => {
      if (state.ignoreOverrides > 0) {
        state.ignoreOverrides -= 1;

        return {};
      }

      const size = {
        width: Number(params?.["width"]),
        height: Number(params?.["height"]),
        deviceScaleFactor: Number(params?.["deviceScaleFactor"]),
      };

      if (isTab(sessionId)) state.viewport = size;
      else state.windows.set(sessionId ?? "", size);

      return {};
    },
    "Emulation.clearDeviceMetricsOverride": (_params, sessionId) => {
      if (state.ignoreClears > 0) {
        state.ignoreClears -= 1;

        return {};
      }

      if (isTab(sessionId)) state.viewport = { width: 780, height: 493, deviceScaleFactor: 1 };
      else state.windows.delete(sessionId ?? "");

      return {};
    },
    "Runtime.evaluate": (_params, sessionId) => ({
      result: {
        type: "object",
        value: {
          ...(isTab(sessionId)
            ? state.viewport
            : (state.windows.get(sessionId ?? "") ?? WINDOW_SIZE)),
        },
      },
    }),
  } satisfies Record<string, Reply>;

  const transport: CdpTransport = {
    send: (method, params, sessionId) => {
      const command: Types.Mutable<Sent> = { method };

      if (params !== undefined) command.params = params;

      if (sessionId !== undefined) command.sessionId = sessionId;

      sent.push(command);

      if (state.closed) return Promise.reject(new Error("closed"));

      // SAFETY: `method in defaults` says it is one of the defaults' keys.
      const reply: Reply =
        replies[method] ?? (method in defaults ? defaults[method as keyof typeof defaults] : null);

      return Promise.resolve(Predicate.isFunction(reply) ? reply(params, sessionId) : reply);
    },
    onEvent: (next) => {
      listener = next;
    },
    onClose: (next) => {
      closing = next;
    },
    close: () => {
      state.closed = true;
      closing();
    },
  };

  return {
    transport,
    sent,
    state,
    emit: (event: CdpEvent) => listener(event),
    methods: () => sent.map((command) => command.method),
  };
};
