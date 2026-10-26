// @effect-diagnostics missingPipeableSignature:off -- plain factory functions.
// A Session's browser (`docs/spec.md` → Browser, ADR-0007): its host is a Durable Object of the `apps/browser` Worker, one
// per Session, named by the Session's ID and reached over a Durable Object binding, as the codemode sandbox is
// (`./codemode.ts`).
import { BrowserError, type BrowserHostService } from "@cloudpid/extensions/browser";
import type { BrowserHostRpc } from "@cloudpid/extensions/browser/contract";
import * as Effect from "effect/Effect";

/** The browser host Durable Object namespace, as a Session DO binds it from the browser Worker (`script_name`). */
export type BrowserHostNamespace = {
  getByName(name: string): BrowserHostRpc;
};

/**
 * The Session's browser host: the object of `namespace` named `name`, found anew at each call. A failed call (the object
 * is unreachable, or threw) fails with a `BrowserError` that says which call.
 */
export const remoteBrowserHost = (
  namespace: BrowserHostNamespace,
  name: string,
): BrowserHostService => {
  const call = <A>(operation: string, run: (host: BrowserHostRpc) => Promise<A>) =>
    Effect.tryPromise({
      try: () => run(namespace.getByName(name)),
      catch: (cause) => BrowserError.make({ message: `${operation}: ${String(cause)}` }),
    });

  return {
    describe: call("describe", (host) => host.describe()),
    run: ({ code, conversationId, ownerTabId }) =>
      call("run", (host) => host.run(code, conversationId, ownerTabId)),
    close: call("close", (host) => host.close()),
    startHandoff: (input) => call("startHandoff", (host) => host.startHandoff(input)),
    liveView: (requestId) => call("liveView", (host) => host.liveView(requestId)),
    ownerTabView: (open) => call("ownerTabView", (host) => host.ownerTabView(open)),
    ownerTabs: call("ownerTabs", (host) => host.ownerTabs()),
    openOwnerTab: call("openOwnerTab", (host) => host.openOwnerTab()),
    showOwnerTab: (id) => call("showOwnerTab", (host) => host.showOwnerTab(id)),
    closeOwnerTab: (id) => call("closeOwnerTab", (host) => host.closeOwnerTab(id)),
    waitHandoff: (requestId, maxMs) =>
      call("waitHandoff", (host) => host.waitHandoff(requestId, maxMs)),
    endHandoff: (requestId) => call("endHandoff", (host) => host.endHandoff(requestId)),
  };
};
