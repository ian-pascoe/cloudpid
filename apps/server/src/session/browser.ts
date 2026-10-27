// @effect-diagnostics missingPipeableSignature:off -- plain factory functions.
// A Session's browser (`docs/spec.md` → Browser, ADR-0007): its host is a Durable Object of the `apps/browser` Worker, one
// per Session, named by the Session's ID and reached over a Durable Object binding, as the codemode sandbox is
// (`./codemode.ts`).
import { BrowserError, type BrowserHostService } from "@cloudpid/extensions/browser";
import type { BrowserHostRpc, PreviewWorkspace } from "@cloudpid/extensions/browser/contract";
import * as Effect from "effect/Effect";

/** The browser host Durable Object namespace, as a Session DO binds it from the browser Worker (`script_name`). */
export type BrowserHostNamespace = {
  getByName(name: string): BrowserHostRpc;
};

/**
 * The Session's browser host: the object of `namespace` named `name`, found anew at each call. Every call names the
 * Session's Workspace (`workspace`), which the browsers the host acquires route their Container previews to (ADR-0023);
 * when it cannot be told, the call names none and the host keeps the one it was last told. A failed call (the object is
 * unreachable, or threw) fails with a `BrowserError` that says which call.
 */
export const remoteBrowserHost = (
  namespace: BrowserHostNamespace,
  name: string,
  workspace: () => Promise<PreviewWorkspace>,
): BrowserHostService => {
  const named = Effect.tryPromise(workspace).pipe(Effect.orElseSucceed(() => null));

  const call = <A>(
    operation: string,
    run: (host: BrowserHostRpc, workspace: PreviewWorkspace) => Promise<A>,
  ) =>
    Effect.flatMap(named, (at) =>
      Effect.tryPromise({
        try: () => run(namespace.getByName(name), at),
        catch: (cause) => BrowserError.make({ message: `${operation}: ${String(cause)}` }),
      }),
    );

  return {
    describe: call("describe", (host, at) => host.describe(at)),
    run: ({ code, conversationId, ownerTabId }) =>
      call("run", (host, at) => host.run(at, code, conversationId, ownerTabId)),
    close: call("close", (host, at) => host.close(at)),
    startHandoff: (input) => call("startHandoff", (host, at) => host.startHandoff(at, input)),
    liveView: (requestId) => call("liveView", (host, at) => host.liveView(at, requestId)),
    ownerTabView: (open) => call("ownerTabView", (host, at) => host.ownerTabView(at, open)),
    ownerTabs: call("ownerTabs", (host, at) => host.ownerTabs(at)),
    openOwnerTab: call("openOwnerTab", (host, at) => host.openOwnerTab(at)),
    showOwnerTab: (id) => call("showOwnerTab", (host, at) => host.showOwnerTab(at, id)),
    closeOwnerTab: (id) => call("closeOwnerTab", (host, at) => host.closeOwnerTab(at, id)),
    readOwnerTabPages: (ids) =>
      call("readOwnerTabPages", (host, at) => host.readOwnerTabPages(at, ids)),
    waitHandoff: (requestId, maxMs) =>
      call("waitHandoff", (host, at) => host.waitHandoff(at, requestId, maxMs)),
    endHandoff: (requestId) => call("endHandoff", (host, at) => host.endHandoff(at, requestId)),
  };
};
