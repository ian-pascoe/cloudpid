// @effect-diagnostics missingPipeableSignature:off -- plain factory functions.
// A Session's browser (`docs/spec.md` → Browser, ADR-0007): its host is a Durable Object of the `apps/browser` Worker, one
// per Session, named by the Session's ID and reached over a Durable Object binding, as the codemode sandbox is
// (`./codemode.ts`).
import { BrowserError, type BrowserHostService } from "@cloudpid/extensions/browser";
import type {
  BrowserHostRpc,
  ContainerPreviewWorkspace,
} from "@cloudpid/extensions/browser/contract";
import * as Effect from "effect/Effect";

/** The browser host Durable Object namespace, as a Session DO binds it from the browser Worker (`script_name`). */
export type BrowserHostNamespace = {
  getByName(name: string): BrowserHostRpc;
};

/**
 * The Session's browser host: the object of `namespace` named `name`, found anew at each call. The calls that can
 * acquire a browser (`run`, `ownerTabView`, `openOwnerTab`) name the Session's Workspace last (`workspace`), which that
 * browser routes its Container previews to (ADR-0023); when it cannot be told, they name none and the host keeps the one
 * it was last told. A failed call (the object is unreachable, or threw) fails with a `BrowserError` that says which call.
 */
export const remoteBrowserHost = (
  namespace: BrowserHostNamespace,
  name: string,
  workspace: () => Promise<ContainerPreviewWorkspace | undefined>,
): BrowserHostService => {
  const named = Effect.tryPromise(workspace).pipe(Effect.orElseSucceed(() => undefined));

  const call = <A>(operation: string, run: (host: BrowserHostRpc) => Promise<A>) =>
    Effect.tryPromise({
      try: () => run(namespace.getByName(name)),
      catch: (cause) => BrowserError.make({ message: `${operation}: ${String(cause)}` }),
    });

  /** A call that can acquire a browser: it names the Session's Workspace, or none. */
  const acquiring = <A>(
    operation: string,
    run: (host: BrowserHostRpc, workspace: ContainerPreviewWorkspace | undefined) => Promise<A>,
  ) => Effect.flatMap(named, (at) => call(operation, (host) => run(host, at)));

  return {
    describe: call("describe", (host) => host.describe()),
    run: ({ code, conversationId, ownerTabId }) =>
      acquiring("run", (host, at) => host.run(code, conversationId, ownerTabId, at)),
    close: call("close", (host) => host.close()),
    startHandoff: (input) => call("startHandoff", (host) => host.startHandoff(input)),
    liveView: (requestId) => call("liveView", (host) => host.liveView(requestId)),
    ownerTabView: (open) => acquiring("ownerTabView", (host, at) => host.ownerTabView(open, at)),
    ownerTabs: call("ownerTabs", (host) => host.ownerTabs()),
    openOwnerTab: acquiring("openOwnerTab", (host, at) => host.openOwnerTab(at)),
    showOwnerTab: (id) => call("showOwnerTab", (host) => host.showOwnerTab(id)),
    closeOwnerTab: (id) => call("closeOwnerTab", (host) => host.closeOwnerTab(id)),
    readOwnerTabPages: (ids) => call("readOwnerTabPages", (host) => host.readOwnerTabPages(ids)),
    waitHandoff: (requestId, maxMs) =>
      call("waitHandoff", (host) => host.waitHandoff(requestId, maxMs)),
    endHandoff: (requestId) => call("endHandoff", (host) => host.endHandoff(requestId)),
  };
};
