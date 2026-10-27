// The Changes on the Session socket (docs/spec.md → Diffs and review → Changes): a Workspace lists them
// (`Workspace.changes`), and the Session sends each list to every client that watches them. The Session's own
// Workspace's are one broadcast, and each Subagent Workspace's another (ADR-0024): the conversations that work in one
// Workspace share its listing. One listing serves every client: a refresh asked for while one runs is folded into one
// more after it, and an agent's writes are refreshed once, a second after the last. Only the owner's Refresh may start
// a stopped Container; every other refresh shows a repo that needs it as it was last listed, "may be out of date".
// @effect-diagnostics asyncFunction:off globalTimers:off missingPipeableSignature:off preferEffectArray:off
import type { ChangeFile, ServerMessage, WorkspaceChanges } from "@cloudpid/protocol";
import {
  type AgentWorkspace,
  conversationWorkspace,
  SubagentsDoc,
} from "@cloudpid/extensions/subagents";
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

/** Where the Changes come from: a Workspace, in the directory its conversations work in. */
export type ChangesSource = {
  /** The Changes, the Container started for a repo that needs it only with `startContainer`; null with no Workspace. */
  readonly list: (startContainer: boolean) => Promise<WorkspaceChanges | null>;
  readonly file: (query: ChangeFileRequest) => Promise<ChangeFile>;
};

/**
 * Whose Changes: a Subagent Workspace's, or the Session's own Workspace's when undefined. A conversation's are those of
 * the Workspace it works in (`SessionHost.workspaceOf`).
 */
export type ChangesWorkspace = AgentWorkspace | undefined;

/** Where the Changes of each Workspace come from. */
export type ChangesSources = {
  /** The Session's own Workspace, in the directory the Session works in. */
  readonly session: ChangesSource;
  /** A Subagent Workspace, in its directory. */
  readonly subagent: (workspace: AgentWorkspace) => ChangesSource;
};

/** The key of the Session's own Workspace among the broadcasts. */
const SESSION_WORKSPACE = "";

/** The key of `workspace`'s broadcast: one per Workspace and directory. */
const keyOf = (workspace: ChangesWorkspace): string =>
  workspace === undefined ? SESSION_WORKSPACE : `${workspace.object}\n${workspace.directory}`;

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
  /** `workspace`'s Changes for one watcher: the last list if there is one, then each listing; it starts one. */
  readonly updates: (workspace: ChangesWorkspace) => Stream.Stream<ChangesUpdate>;
  /** List `workspace`'s Changes again for its watchers (`manual`: the owner's Refresh, which may start the Container). */
  readonly refresh: (workspace: ChangesWorkspace, manual: boolean) => Effect.Effect<void>;
  /** Whether any client watches any Changes. Plain, for the tools' Promise code, as `written` is. */
  readonly watched: () => boolean;
  /** An agent may have changed `workspace`'s files: list them again shortly, if anyone watches them. */
  readonly written: (workspace: ChangesWorkspace) => void;
  /** An agent may have changed files, in a Workspace not known: list every watched Workspace's again shortly. */
  readonly writtenInUnknownWorkspace: () => void;
  /** One changed file's two sides, in `workspace`; it never starts the Container. */
  readonly file: (
    workspace: ChangesWorkspace,
    query: ChangeFileRequest,
  ) => Effect.Effect<ChangeFile, SessionError>;
  /**
   * List the Session's own Changes now, never starting the Container, and answer the list; the last one when the
   * listing failed. Drafts are made on these Changes only (`docs/spec.md` → Annotations and Reviews).
   */
  readonly fresh: Effect.Effect<ChangesMessage | undefined>;
  /**
   * Tell `observer` each list of the Session's own Changes as it is made; it starts no listing, and is not a watcher.
   * The result stops it.
   */
  readonly observe: (observer: (list: ChangesMessage) => void) => () => void;
};

/** The Session's Changes, each Workspace's shared by every client that watches them. */
export class SessionChanges extends Context.Service<SessionChanges, SessionChangesService>()(
  "@cloudpid/server/session/changes/SessionChanges",
) {}

/** The Session's Changes over `sources`: one broadcast per Workspace, made when it is first asked for. */
export const sessionChangesLayer = (
  sources: ChangesSources,
  options: { readonly debounceMs?: number } = {},
): Layer.Layer<SessionChanges> =>
  Layer.effect(
    SessionChanges,
    Effect.gen(function* () {
      const run = Effect.runForkWith(yield* Effect.context<never>());
      const broadcasts = new Map<string, ChangesBroadcast>();

      const sourceOf = (workspace: ChangesWorkspace): ChangesSource =>
        workspace === undefined ? sources.session : sources.subagent(workspace);

      /**
       * `workspace`'s broadcast, made if it has none. Only a watch makes one for a Subagent Workspace, and its release
       * forgets it once nobody watches; the Session's own is kept.
       */
      const broadcastOf = (workspace: ChangesWorkspace): ChangesBroadcast => {
        const key = keyOf(workspace);
        const known = broadcasts.get(key);

        if (known !== undefined) return known;

        const made = new ChangesBroadcast(sourceOf(workspace), {
          ...options,
          warn: (message, cause) => {
            run(Effect.logWarning(message, cause));
          },
        });

        broadcasts.set(key, made);

        return made;
      };

      const updates = (workspace: ChangesWorkspace) =>
        Stream.callback<ChangesUpdate>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const broadcast = broadcastOf(workspace);

              const stop = broadcast.subscribe((update) => {
                Queue.offerUnsafe(queue, update);
              });

              // A watcher that starts (a client that connects, or a socket woken from hibernation) sees the files now.
              void broadcast.refresh(false);

              return { broadcast, stop };
            }),
            ({ broadcast, stop }) =>
              Effect.sync(() => {
                stop();

                // A Subagent Workspace nobody watches is listed afresh when it is watched again; the Session's own
                // keeps its last list, as it always did.
                const key = keyOf(workspace);

                if (key !== SESSION_WORKSPACE && !broadcast.watched) {
                  if (broadcasts.get(key) === broadcast) broadcasts.delete(key);
                }
              }),
          ),
        );

      return {
        updates,
        refresh: (workspace, manual) =>
          Effect.promise(() => {
            // A Subagent Workspace nobody watches has nobody to send a list to: its first watch lists it.
            const broadcast =
              workspace === undefined ? broadcastOf(workspace) : broadcasts.get(keyOf(workspace));

            return broadcast?.refresh(manual) ?? Promise.resolve();
          }),
        watched: () => Arr.some([...broadcasts.values()], (broadcast) => broadcast.watched),
        written: (workspace) => broadcasts.get(keyOf(workspace))?.soon(),
        writtenInUnknownWorkspace: () => {
          for (const broadcast of broadcasts.values()) broadcast.soon();
        },
        // The Session's own broadcast is kept once made, so the observer outlives every watch.
        fresh: Effect.suspend(() => {
          const broadcast = broadcastOf(undefined);

          return Effect.promise(() => broadcast.refresh(false)).pipe(
            Effect.map(() => broadcast.latest),
          );
        }),
        observe: (observer) => broadcastOf(undefined).observe(observer),
        file: (workspace, query) =>
          Effect.tryPromise({
            // Straight from the source: a file needs no broadcast, and one made for it would outlive every watch.
            try: () => sourceOf(workspace).file(query),
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
 * An extension that lists the Changes again after each call of `tools`' writing tools (`WRITING_TOOLS`): those of the
 * Workspace the calling conversation works in, its Subagent Workspace's (its own or its nearest ancestor's) if it has
 * one, else the Session's own. Nothing is read while no client watches any Changes. Install it after the extensions
 * that bring the tools.
 */
export const changesRefreshingTools = (
  tools: ReadonlyArray<ToolRegistration>,
  changes: Pick<SessionChangesService, "watched" | "written" | "writtenInUnknownWorkspace">,
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
                    changes.written(
                      state === undefined
                        ? undefined
                        : conversationWorkspace(state, api.conversationId),
                    );
                  },
                  // Unknown: list every watched Workspace's again, which costs one listing each at most.
                  () => changes.writtenInUnknownWorkspace(),
                );
              }
            }
          },
        })),
    ),
  });
