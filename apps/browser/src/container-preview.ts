// The Container previews' routes (ADR-0023, `docs/architecture/browser.md` → Container preview): Browser Run sends a browser's
// requests for the hosts of `outboundByHost`, fixed when the browser is acquired, to a Worker of ours instead of the
// network. Each of the eight Container preview hosts (`http://<port>.cloudpid.internal/`) goes to the `ContainerPreviews`
// entrypoint this Worker exports, made for the Session's Workspace, which hands the request to the Workspaces Worker's
// Container previews entrypoint. `agents/browser`'s `browserRun` takes no `outboundByHost`, so the host hands it a
// binding whose `acquire` adds it.
// @effect-diagnostics preferEffectRecord:off asyncFunction:off globalConsole:off
import {
  CONTAINER_PREVIEW_PORTS,
  type ContainerPreviewWorkspace,
  containerPreviewHost,
  isContainerPreviewWorkspace,
} from "@cloudpid/extensions/browser/contract";
import type { BrowserBinding } from "agents/browser";
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Arr from "effect/Array";
import { CONTAINER_PREVIEWS_BINDING } from "./binding.ts";

/** The Workspaces Worker's Container previews entrypoint, as the browser Worker binds it: the Container preview alone. */
export type WorkspaceContainerPreviews = {
  /** Answer `request` from Workspace DO `workspace`'s Container `port` (`apps/server/src/workspace/worker.ts`). */
  containerPreview(workspace: string, request: Request, port: number): Promise<Response>;
};

export type ContainerPreviewsEnv = {
  readonly [CONTAINER_PREVIEWS_BINDING]: WorkspaceContainerPreviews;
};

/** What the browser host makes a `ContainerPreviews` entrypoint with: the Session's Workspace, by its DO's name. */
export type ContainerPreviewProps = { readonly workspace: ContainerPreviewWorkspace };

const CONTAINER_PREVIEW_HOST = /^(\d+)\.cloudpid\.internal$/;

/** The Container port a Container preview's URL is for, from its host; undefined for a host that is none of the eight. */
export const containerPreviewPortOf = (url: URL): number | undefined => {
  const port = Number(CONTAINER_PREVIEW_HOST.exec(url.hostname)?.[1]);

  return CONTAINER_PREVIEW_PORTS.includes(port) && url.port === "" ? port : undefined;
};

/**
 * Where Browser Run sends the browser's requests for the Container preview hosts (`outboundByHost`): the request goes to
 * the Workspace the props name, with the port its host is for. The route outlives the call that made it, and keeps the
 * code it was made with until the browser is acquired again.
 */
export class ContainerPreviews extends WorkerEntrypoint<
  ContainerPreviewsEnv,
  ContainerPreviewProps
> {
  override async fetch(request: Request): Promise<Response> {
    const port = containerPreviewPortOf(new URL(request.url));

    if (port === undefined) return new Response("Not found", { status: 404 });

    const { workspace } = this.ctx.props;

    try {
      return await this.env[CONTAINER_PREVIEWS_BINDING].containerPreview(workspace, request, port);
    } catch (cause) {
      console.warn(`Container preview of ${workspace} on port ${port} failed: ${String(cause)}`);

      return new Response("The Workspace could not be reached. Reload to try again.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }
}

/** What Browser Run's `acquire` takes beyond what `agents/browser` passes it. */
type AcquireOptions = NonNullable<Parameters<NonNullable<BrowserBinding["acquire"]>>[0]> & {
  readonly outboundByHost?: Readonly<Record<string, Fetcher>>;
};

/**
 * The routes of the Session's Container previews, for every browser the host acquires: made by `entry` for the latest
 * Workspace a call named (`given`), which is held in memory only. A browser acquired before any call named one has no
 * routes, and a browser keeps the routes it was acquired with until it is acquired again.
 */
export class ContainerPreviewRoutes {
  readonly #entry: (workspace: ContainerPreviewWorkspace) => Fetcher;
  #workspace: ContainerPreviewWorkspace | undefined;

  /** `entry` makes the `ContainerPreviews` entrypoint for a Workspace DO's name. */
  constructor(entry: (workspace: ContainerPreviewWorkspace) => Fetcher) {
    this.#entry = entry;
  }

  /**
   * A call named the Session's Workspace: the latest wins. Anything but a Workspace DO's name (`ws:<id>`) is ignored: a
   * call that named none, or one from a Session whose arguments are laid out otherwise, leaves the routes as they were.
   */
  given(workspace: ContainerPreviewWorkspace | undefined): void {
    if (isContainerPreviewWorkspace(workspace)) this.#workspace = workspace;
  }

  /** `binding`, with every `acquire` routing the Container preview hosts to the Workspace known then. */
  binding(binding: BrowserBinding): BrowserBinding {
    // The binding's methods are only ever called, as `binding.method(...)`: reading anything else off a method of an RPC
    // stub (`binding.acquire.bind`) is itself a call to the binding. A plain binding with only the HTTP API (fully local
    // dev) has no `acquire`, and its browsers no routes.
    const wrapped: BrowserBinding = { fetch: (input, init) => binding.fetch(input, init) };

    if (binding.acquire !== undefined) {
      wrapped.acquire = (options) => {
        if (binding.acquire === undefined) throw new TypeError("The binding has no acquire");

        return binding.acquire({ ...options, ...this.#routes() });
      };
    }

    if (binding.closeSession !== undefined) {
      wrapped.closeSession = (sessionId) => {
        if (binding.closeSession === undefined)
          throw new TypeError("The binding has no closeSession");

        return binding.closeSession(sessionId);
      };
    }

    return wrapped;
  }

  #routes(): Pick<AcquireOptions, "outboundByHost"> {
    if (this.#workspace === undefined) return {};

    const entry = this.#entry(this.#workspace);

    return {
      outboundByHost: Object.fromEntries(
        Arr.map(CONTAINER_PREVIEW_PORTS, (port) => [containerPreviewHost(port), entry] as const),
      ),
    };
  }
}
