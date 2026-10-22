// The Container's backend as the Workspace sees it, with each launch's Container-only paths (docs/spec.md → Container
// and Toolchains → Size and idle). computer's `ContainerBackend` takes its `ignore` list when it is built and passes it
// to every Container it launches (`MOUNT_IGNORE`), checking that computerd applies exactly that list, while the
// Workspace's own paths are a setting that can change between launches. So the backend is built again whenever the
// Container a connection reaches has other paths than the last one built: a new launch, or another Durable Object
// instance reaching the running Container.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";

/** computer's `ContainerBackend`, as this uses it. */
export type LaunchedBackend = WorkspaceBackend & {
  handleFetch(request: Request): Promise<Response>;
};

export type PerLaunchBackendOptions = {
  /** computer's backend for Containers launched with these Container-only paths (none where they have none). */
  readonly build: (ignore: readonly string[] | undefined) => LaunchedBackend;
  /** The paths of the Container the next connection reaches (`ContainerLaunch.ignore`). */
  readonly ignore: () => Promise<readonly string[] | undefined>;
};

/** A list of paths as a key: their order matters (the last match wins). */
const keyOf = (ignore: readonly string[] | undefined): string =>
  ignore === undefined ? "" : `[${ignore.join(",")}]`;

export class PerLaunchContainerBackend implements WorkspaceBackend {
  readonly #options: PerLaunchBackendOptions;
  /** The backend built last: what connects, and what the Container's requests go to. */
  #current: LaunchedBackend;
  /** The paths it was built with; undefined until a connection decided them. */
  #key: string | undefined;

  constructor(options: PerLaunchBackendOptions) {
    this.#options = options;
    // One with no paths answers for the backend (its id, type and description) until a connection decides them.
    this.#current = options.build(undefined);
  }

  get id() {
    return this.#current.id;
  }

  get type() {
    return this.#current.type;
  }

  get description() {
    return this.#current.description ?? "";
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    const ignore = await this.#options.ignore();
    const key = keyOf(ignore);

    if (key !== this.#key) {
      this.#current = this.#options.build(ignore);
      this.#key = key;
    }

    return this.#current.connect(host);
  }

  /** The Container's egress: computerd dials back to the backend that launched it. */
  handleFetch(request: Request): Promise<Response> {
    return this.#current.handleFetch(request);
  }
}
