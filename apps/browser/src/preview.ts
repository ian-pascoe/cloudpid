// The Container previews' routes (ADR-0023, `docs/spec.md` → Browser → Container preview): Browser Run sends a browser's
// requests for the hosts of `outboundByHost`, fixed when the browser is acquired, to a Worker of ours instead of the
// network. Each of the eight preview hosts (`http://<port>.cloudpid.internal/`) goes to the `ContainerPreviews`
// entrypoint this Worker exports, made for the Session's Workspace, which hands the request to its Workspace DO.
// `agents/browser`'s `browserRun` takes no `outboundByHost`, so the host hands it a binding whose `acquire` adds it.
// @effect-diagnostics preferEffectRecord:off asyncFunction:off globalConsole:off
import {
  CONTAINER_PREVIEW_PORTS,
  containerPreviewHost,
  type PreviewWorkspace,
} from "@cloudpid/extensions/browser/contract";
import type { BrowserBinding } from "agents/browser";
import { WorkerEntrypoint } from "cloudflare:workers";
import { PREVIEW_WORKSPACES_BINDING } from "./binding.ts";

/** The Workspace DO, as the browser Worker binds it from the Workspaces Worker: its Container preview alone. */
export type PreviewWorkspaces = {
  getByName(name: string): {
    /** Answer `request` from the Container's `port` (`apps/server/src/workspace/preview.ts`). */
    preview(request: Request, port: number): Promise<Response>;
  };
};

export type ContainerPreviewsEnv = { readonly [PREVIEW_WORKSPACES_BINDING]: PreviewWorkspaces };

/** What the browser host makes a `ContainerPreviews` entrypoint with: the Session's Workspace, by its DO's name. */
export type ContainerPreviewProps = { readonly workspace: string };

const PREVIEW_HOST = /^(\d+)\.cloudpid\.internal$/;

/** The Container port a preview's URL is for, from its host; undefined for a host that is none of the eight. */
export const previewPortOf = (url: URL): number | undefined => {
  const port = Number(PREVIEW_HOST.exec(url.hostname)?.[1]);

  return CONTAINER_PREVIEW_PORTS.includes(port) && url.port === "" ? port : undefined;
};

/**
 * Where Browser Run sends the browser's requests for the preview hosts (`outboundByHost`): the request goes to the
 * Workspace DO the props name, with the port its host is for. The route outlives the call that made it, and keeps the
 * code it was made with until the browser is acquired again.
 */
export class ContainerPreviews extends WorkerEntrypoint<
  ContainerPreviewsEnv,
  ContainerPreviewProps
> {
  override async fetch(request: Request): Promise<Response> {
    const port = previewPortOf(new URL(request.url));

    if (port === undefined) return new Response("Not found", { status: 404 });

    const { workspace } = this.ctx.props;

    try {
      return await this.env[PREVIEW_WORKSPACES_BINDING].getByName(workspace).preview(request, port);
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
  readonly #entry: (workspace: string) => Fetcher;
  #workspace: string | undefined;

  /** `entry` makes the `ContainerPreviews` entrypoint for a Workspace DO's name. */
  constructor(entry: (workspace: string) => Fetcher) {
    this.#entry = entry;
  }

  /** A call named the Session's Workspace: the latest wins, and a call that could not name one (null) leaves it. */
  given(workspace: PreviewWorkspace): void {
    if (workspace !== null) this.#workspace = workspace;
  }

  /** `binding`, with every `acquire` routing the preview hosts to the Workspace known then. */
  binding(binding: BrowserBinding): BrowserBinding {
    // The binding's methods are only ever called on it: a method of an RPC stub is a stub too, and anything else asked
    // of it (`bind`) is a call to the binding. A plain binding with only the HTTP API (fully local dev) has no
    // `acquire`, and its browsers no routes.
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
        CONTAINER_PREVIEW_PORTS.map((port) => [containerPreviewHost(port), entry]),
      ),
    };
  }
}
