// What a test of an App View's frame in happy-dom needs: happy-dom makes no window for a frame page it was told not to
// load, so each frame gets a stand-in that records what is posted to it, and a way to say what the View would.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- recorded messages in native lists.
import { act } from "react";

export const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

export type Sent = { readonly data: Record<string, unknown>; readonly target: string };

/** A frame's window: a stand-in that records what is posted to it. */
interface FakeWindow {
  readonly sent: Sent[];
  readonly postMessage: (data: Record<string, unknown>, target: string) => void;
}

const windows = new WeakMap<HTMLIFrameElement, FakeWindow>();

/** Give every iframe of this test file a stand-in window. */
export const installFakeFrames = (): void => {
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const found = windows.get(this);

      if (found !== undefined) return found;

      const sent: Sent[] = [];

      const made: FakeWindow = {
        sent,
        postMessage: (data, target) => {
          sent.push({ data, target });
        },
      };

      windows.set(this, made);

      return made;
    },
  });
};

/** A frame, with what the page posts to it recorded, and a way to answer as the View would. */
export const viewOf = (element: HTMLIFrameElement | null) => {
  const win = element === null ? undefined : windows.get(element);

  if (element === null || win === undefined) throw new Error("no frame");

  const { sent } = win;

  const say = (data: Record<string, unknown>, origin = ORIGIN) => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: win as unknown as MessageEventSource }),
      );
    });
  };

  const handshake = () => {
    say({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "v", version: "1" } },
    });
    say({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  };

  // The answers carry no method: only what the page says on its own.
  const methods = () =>
    sent.flatMap((each) => (each.data["method"] === undefined ? [] : [each.data["method"]]));

  /** Answer the page's last request (a teardown) as the View does. */
  const answerTeardown = () => {
    const request = sent.findLast((each) => each.data["method"] === "ui/resource-teardown");

    say({ jsonrpc: "2.0", id: request?.data["id"], result: {} });
  };

  return { element, sent, say, handshake, methods, answerTeardown };
};
