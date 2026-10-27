// The Changes on the Session socket (docs/spec.md → Diffs and review → Changes): the Session's Workspace lists them
// (`Workspace.changes`), and the Session sends each list to every client that watches them. One listing serves every
// client: a refresh asked for while one runs is folded into one more after it, and an agent's writes are refreshed
// once, a second after the last. Only the owner's Refresh may start a stopped Container; every other refresh shows a repo
// that needs it as it was last listed, "may be out of date".
// @effect-diagnostics asyncFunction:off globalTimers:off missingPipeableSignature:off preferEffectArray:off
import type { ChangeFile, ServerMessage, WorkspaceChanges } from "@cloudpid/protocol";
import { conversationWorkspace, SubagentsDoc } from "@cloudpid/extensions/subagents";
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ChangeFileRequest } from "../workspace/changes.ts";
import { SessionError } from "./errors.ts";

export type ChangesMessage = Extract<ServerMessage, { type: "changes" }>;

/** How long after an agent's last write the Changes are listed again. */
export const CHANGES_DEBOUNCE_MS = 1_000;

/** The tools whose calls may change the Workspace's files, so the Changes are listed again after them. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash", "codemode"]);

/** Where the Changes come from: the Session's Workspace, in the directory the Session works in. */
export type ChangesSource = {
  /** The Changes, the Container started for a repo that needs it only with `startContainer`; null with no Workspace. */
  readonly list: (startContainer: boolean) => Promise<WorkspaceChanges | null>;
  readonly file: (query: ChangeFileRequest) => Promise<ChangeFile>;
};

/** What a watcher is sent: a list, or why a listing failed (the last list stands). */
export type ChangesUpdate =
  | { readonly kind: "changes"; readonly message: ChangesMessage }
  | { readonly kind: "failed"; readonly message: string };

export type ChangesBroadcastOptions = {
  readonly debounceMs?: number;
  readonly warn: (message: string, cause: unknown) => void;
};

/** The Changes and their watchers, in memory: an object woken from hibernation lists them again for the sockets. */
export class ChangesBroadcast {
  readonly #source: ChangesSource;
  readonly #options: ChangesBroadcastOptions;
  readonly #listeners = new Set<(update: ChangesUpdate) => void>();
  /** Told each list as it is made, without watching: they neither start listings nor count as watchers. */
  readonly #observers = new Set<(list: ChangesMessage) => void>();
  #latest: ChangesMessage | undefined;
  #running: Promise<void> | undefined;
  /** A refresh asked for while one runs: one more after it, manual if any of those asks was. */
  #again: { readonly manual: boolean } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: ChangesSource, options: ChangesBroadcastOptions) {
    this.#source = source;
    this.#options = options;
  }

  /** Whether anyone watches the Changes. */
  get watched(): boolean {
    return this.#listeners.size > 0;
  }

  /** Send `listener` each update from now, the last list first if there is one; the result stops it. */
  subscribe(listener: (update: ChangesUpdate) => void): () => void {
    this.#listeners.add(listener);

    if (this.#latest !== undefined) listener({ kind: "changes", message: this.#latest });

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Tell `observer` each list made from now; the result stops it. */
  observe(observer: (list: ChangesMessage) => void): () => void {
    this.#observers.add(observer);

    return () => {
      this.#observers.delete(observer);
    };
  }

  /** The last list made, if any. */
  get latest(): ChangesMessage | undefined {
    return this.#latest;
  }

  /** List the Changes again for every watcher; resolves once the list, and any asked for meanwhile, is sent. */
  refresh(manual: boolean): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = { manual: manual || this.#again?.manual === true };

      return this.#running;
    }

    this.#running = this.#loop(manual).finally(() => {
      this.#running = undefined;
    });

    return this.#running;
  }

  /** The files may have changed: list them again `debounceMs` after the last such call, if anyone watches. */
  soon(): void {
    if (this.#listeners.size === 0) return;

    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = setTimeout(() => {
      this.#timer = undefined;

      if (this.#listeners.size > 0) void this.refresh(false);
    }, this.#options.debounceMs ?? CHANGES_DEBOUNCE_MS);
  }

  file(query: ChangeFileRequest): Promise<ChangeFile> {
    return this.#source.file(query);
  }

  async #loop(manual: boolean): Promise<void> {
    let next: { readonly manual: boolean } | undefined = { manual };

    while (next !== undefined) {
      this.#again = undefined;
      await this.#listOnce(next.manual);
      next = this.#again;
    }
  }

  async #listOnce(manual: boolean): Promise<void> {
    const last = this.#latest;
    // Only the owner's Refresh starts the Container, for the repos it last left "may be out of date".
    const starting = manual && last !== undefined && last.repos.some((repo) => repo.stale);

    if (starting) this.#send({ kind: "changes", message: { ...last, startingContainer: true } });

    try {
      const listed = await this.#source.list(manual);

      const latest: ChangesMessage = {
        type: "changes",
        repos: listed?.repos ?? [],
        startingContainer: false,
      };

      this.#latest = latest;
      this.#send({ kind: "changes", message: latest });

      for (const observer of this.#observers) observer(latest);
    } catch (cause) {
      this.#options.warn("Listing the Changes failed", cause);

      if (starting) this.#send({ kind: "changes", message: last });

      this.#send({
        kind: "failed",
        message: `Listing the Changes failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  #send(update: ChangesUpdate): void {
    for (const listener of this.#listeners) listener(update);
  }
}

export type SessionChangesService = {
  /** The Changes for one watcher: the last list if there is one, then each listing; it starts one. */
  readonly updates: Stream.Stream<ChangesUpdate>;
  /** List the Changes again for every watcher (`manual`: the owner's Refresh, which may start the Container). */
  readonly refresh: (manual: boolean) => Effect.Effect<void>;
  /** Whether any client watches the Changes. Plain, for the tools' Promise code, as `written` is. */
  readonly watched: () => boolean;
  /** An agent may have changed the files: list them again shortly. */
  readonly written: () => void;
  /** One changed file's two sides; it never starts the Container. */
  readonly file: (query: ChangeFileRequest) => Effect.Effect<ChangeFile, SessionError>;
  /** List the Changes now, never starting the Container, and answer the list; the last one when the listing failed. */
  readonly fresh: Effect.Effect<ChangesMessage | undefined>;
  /** Tell `observer` each list as it is made; it starts no listing, and is not a watcher. The result stops it. */
  readonly observe: (observer: (list: ChangesMessage) => void) => () => void;
};

/** The Session's Changes, which every client that watches them shares. */
export class SessionChanges extends Context.Service<SessionChanges, SessionChangesService>()(
  "@cloudpid/server/session/changes/SessionChanges",
) {}

/** The Session's Changes over `source`. */
export const sessionChangesLayer = (
  source: ChangesSource,
  options: { readonly debounceMs?: number } = {},
): Layer.Layer<SessionChanges> =>
  Layer.effect(
    SessionChanges,
    Effect.gen(function* () {
      const run = Effect.runForkWith(yield* Effect.context<never>());

      const broadcast = new ChangesBroadcast(source, {
        ...options,
        warn: (message, cause) => {
          run(Effect.logWarning(message, cause));
        },
      });

      const updates = Stream.callback<ChangesUpdate>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const stop = broadcast.subscribe((update) => {
              Queue.offerUnsafe(queue, update);
            });

            // A watcher that starts (a client that connects, or a socket woken from hibernation) sees the files now.
            void broadcast.refresh(false);

            return stop;
          }),
          (stop) => Effect.sync(stop),
        ),
      );

      return {
        updates,
        refresh: (manual) => Effect.promise(() => broadcast.refresh(manual)),
        watched: () => broadcast.watched,
        written: () => broadcast.soon(),
        fresh: Effect.promise(() => broadcast.refresh(false)).pipe(
          Effect.map(() => broadcast.latest),
        ),
        observe: (observer) => broadcast.observe(observer),
        file: (query) =>
          Effect.tryPromise({
            try: () => broadcast.file(query),
            catch: (cause) =>
              SessionError.make({
                operation: "changeFile",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
      } satisfies SessionChangesService;
    }),
  );

/**
 * An extension that lists the Changes again after each call of `tools`' writing tools (`WRITING_TOOLS`) by a
 * conversation that works in the Session's own Workspace: a subagent's in a Subagent Workspace of its own changes files
 * the Session's Changes do not show. Nothing is read while no client watches them. Install it after the extensions that
 * bring the tools.
 */
export const changesRefreshingTools = (
  tools: ReadonlyArray<ToolRegistration>,
  changes: Pick<SessionChangesService, "watched" | "written">,
): Extension =>
  defineExtension({
    name: "changes",
    wraps: Arr.map(
      Arr.filter(tools, (tool) => WRITING_TOOLS.has(tool.name)),
      (tool) =>
        wrapTool(tool, (wrapped) => ({
          ...wrapped,
          execute: async (args, api, context) => {
            try {
              return await wrapped.execute(args, api, context);
            } finally {
              if (changes.watched()) {
                void api.snapshot(SubagentsDoc, context).then(
                  (state) => {
                    if (
                      state === undefined ||
                      conversationWorkspace(state, api.conversationId) === undefined
                    ) {
                      changes.written();
                    }
                  },
                  // Unknown: list them again, which costs one listing at most.
                  () => changes.written(),
                );
              }
            }
          },
        })),
    ),
  });
