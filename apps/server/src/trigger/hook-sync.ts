// A Trigger object's GitHub-managed hook kept in line with its definition (`docs/architecture/triggers.md` →
// GitHub-managed hooks): made on the repo once the Trigger has its secrets, the repo swept of orphans first; updated when
// its URL or Signing secret was replaced (the kept fingerprint no longer matches); a failure kept with its problem and
// tried again with backoff; and the hooks to delete tried until a day after the first try. A definition that names no
// hook leaves a kept one where it is, logged: only a definition that names another repo moves it, since a definition
// read from an older Registry (after a rollback) has no `repo` and must not wipe working hooks. Over the object's store
// and its GitHub port; the object (`object.ts`) calls it at each adopt, rotation, wipe and alarm.
// @effect-diagnostics missingPipeableSignature:off -- the object's own operations, not combinators.
import {
  type GitHubHookSource,
  githubHookOf,
  type GitHubHookStatus,
  type TriggerDefinition,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  annotateHookFailure,
  GitHubHookFailed,
  hookTriggers,
  orphanHooks,
  type RepoHooks,
} from "./github-hook.ts";
import type { TriggerUnreachable } from "./object.ts";
import type { KeptSecrets, TriggerStore } from "./store.ts";

/**
 * What a GitHub-managed hook needs: the repos' hooks as the App, the stage's origin its Trigger URLs start with
 * (undefined where it has none, as under `alchemy dev`: no hook can reach it), and the Registry's `knownTriggers`,
 * which the orphan sweep asks.
 */
export type HookGitHub = {
  readonly hooks: RepoHooks;
  readonly origin: string | undefined;
  readonly known: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, TriggerUnreachable>;
};

/** How long a hook's delete at GitHub is tried before it is given up, with a warning. */
export const HOOK_DELETE_MS = 24 * 60 * 60_000;

/** A Trigger object's hook sync: what the object asks of it. */
export type HookSync = {
  /** Where `definition`'s hook is, or null for a Trigger that names none. */
  readonly status: (definition: TriggerDefinition | undefined) => GitHubHookStatus | null;
  /**
   * Bring the hook in line with `definition` at `at`. `force` tries at once whatever the backoff, and asks GitHub
   * for a token again (a sync after a change, a rotation: the owner may have accepted the permission). Never fails.
   */
  readonly reconcile: (
    definition: TriggerDefinition,
    at: number,
    force: boolean,
  ) => Effect.Effect<void>;
  /** Try each hook due to be deleted by `at` once more. Never fails. */
  readonly deleteDue: (at: number) => Effect.Effect<void>;
  /** The Trigger goes: its hook, if one was made, is to be deleted, and is forgotten. */
  readonly drop: (at: number) => void;
  /**
   * When the hook sync wants the alarm for `definition` (none when undefined), `at` being now: a hook's next try, a
   * delete's, or `at` for a hook named and never tried (as one left by an object older than its definition).
   */
  readonly nextTryAt: (definition: TriggerDefinition | undefined, at: number) => number | undefined;
};

/**
 * The hook sync of Trigger `id` over its store (`store`, opened; `existing`, when there is one), its GitHub port, and
 * `opened`, which reads the Trigger URL's token and the Signing secret the kept secrets seal. Failures back off as
 * `backoff` says for a number of tries.
 */
export const hookSync = (options: {
  readonly id: string;
  readonly store: () => TriggerStore;
  readonly existing: () => TriggerStore | undefined;
  readonly github: HookGitHub;
  readonly opened: (
    secrets: KeptSecrets,
  ) => Effect.Effect<{ readonly token: string; readonly secret: string }, TriggerUnreachable>;
  readonly backoff: (attempts: number) => number;
}): HookSync => {
  const { id, store, existing, github, opened, backoff } = options;

  /** What a hook is set with now: the stage's origin, the token's keyed hash and the sealed secret. */
  const fingerprint = (secrets: KeptSecrets): string =>
    JSON.stringify([github.origin ?? "", secrets.tokenHash, secrets.secret.ciphertext]);

  /** The kept secrets when they read. */
  const readable = (): KeptSecrets | undefined => {
    const secrets = existing()?.secrets();

    return secrets === "unreadable" ? undefined : secrets;
  };

  const status = (definition: TriggerDefinition | undefined): GitHubHookStatus | null => {
    const wanted = githubHookOf(definition);

    if (wanted === undefined) return null;

    const kept = existing()?.githubHook();

    if (kept === undefined || kept.repo !== wanted.repo)
      return { repo: wanted.repo, state: "pending" };

    if (kept.problem !== undefined) {
      return { repo: wanted.repo, state: "failed", problem: kept.problem };
    }

    const secrets = readable();

    const current =
      kept.hookId !== undefined && secrets !== undefined && kept.synced === fingerprint(secrets);

    return { repo: wanted.repo, state: current ? "ready" : "pending" };
  };

  const deleteDue = (at: number) =>
    Effect.gen(function* () {
      const kept = existing();

      if (kept === undefined) return;

      for (const hookDelete of kept.hookDeletes()) {
        if (hookDelete.nextTryAt > at) continue;

        const deleted = yield* Effect.result(
          github.hooks.delete(hookDelete.repo, hookDelete.hookId),
        );

        if (Result.isSuccess(deleted)) {
          kept.hookDeleted(hookDelete.repo, hookDelete.hookId);

          continue;
        }

        const annotated = Effect.annotateLogs({
          "trigger.id": id,
          "github.repo": hookDelete.repo,
          "github.hook": hookDelete.hookId,
        });

        if (at - hookDelete.since >= HOOK_DELETE_MS) {
          kept.hookDeleted(hookDelete.repo, hookDelete.hookId);
          yield* Effect.logWarning(
            "A Trigger gave up deleting its GitHub hook after a day: delete it in the repo's settings",
            deleted.failure.message,
          ).pipe(annotated);

          continue;
        }

        kept.deleteLater({
          ...hookDelete,
          attempts: hookDelete.attempts + 1,
          nextTryAt: at + backoff(hookDelete.attempts),
        });
        yield* Effect.logInfo(
          "A Trigger's GitHub hook could not be deleted yet",
          deleted.failure.message,
        ).pipe(annotated);
      }
    });

  /**
   * The orphan sweep before a hook is made on `repo`: its hooks that send to this stage's `/hooks/<id>/` for a Trigger
   * the Registry doesn't know (`knownTriggers`), or for this one (a hook it made and lost), are deleted. Without the
   * Registry's answer no other Trigger's hook is deleted.
   */
  const sweep = (repo: string, origin: string): Effect.Effect<void, GitHubHookFailed> =>
    Effect.gen(function* () {
      const listed = yield* github.hooks.list(repo);
      const others = Arr.filter(hookTriggers(listed, origin), (trigger) => trigger !== id);

      const known = yield* github
        .known(others)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "The orphan sweep could not ask the Registry which Triggers it knows",
              error.message,
            ).pipe(Effect.as(others)),
          ),
        );

      let deleted = 0;

      for (const orphan of orphanHooks(listed, { origin, own: id, known: new Set(known) })) {
        const gone = yield* Effect.result(github.hooks.delete(repo, orphan.id));

        if (Result.isSuccess(gone)) deleted++;
        else
          yield* Effect.logInfo("An orphan GitHub hook could not be deleted", gone.failure.message);
      }

      yield* Effect.annotateCurrentSpan({
        "trigger.outcome": "ok",
        "trigger.hooks_deleted": deleted,
      });
    }).pipe(
      Effect.tapError(annotateHookFailure),
      Effect.withSpan("trigger.github_hook", {
        attributes: { "trigger.id": id, "trigger.github_hook.op": "sweep" },
      }),
    );

  /**
   * Point the hook at `wanted`'s repo at the Trigger URL and Signing secret `secrets` hold: update hook `hookId`, or,
   * for none (or one GitHub no longer has), sweep the repo's orphans and make one. Answers the hook's id.
   */
  const place = (
    wanted: GitHubHookSource,
    hookId: number | undefined,
    secrets: KeptSecrets,
  ): Effect.Effect<number, GitHubHookFailed | TriggerUnreachable> =>
    Effect.gen(function* () {
      const { origin } = github;

      if (origin === undefined) {
        return yield* GitHubHookFailed.make({
          code: "no_origin",
          message:
            "This stage has no public origin (it runs under alchemy dev), so GitHub can't reach its Trigger URLs: no hook is made",
        });
      }

      const { token, secret } = yield* opened(secrets);
      const config = { url: `${origin}/hooks/${id}/${token}`, secret, events: wanted.events };

      if (hookId !== undefined) {
        const updated = yield* github.hooks.update(wanted.repo, hookId, config);

        if (updated === "updated") return hookId;
      }

      yield* sweep(wanted.repo, origin);

      return yield* github.hooks.create(wanted.repo, config);
    });

  const reconcile = (definition: TriggerDefinition, at: number, force: boolean) =>
    Effect.gen(function* () {
      const wanted = githubHookOf(definition);
      let kept = store().githubHook();

      // A definition that names no hook (one an older Registry answers, after a rollback) leaves a working one be.
      if (wanted === undefined) {
        if (kept !== undefined) {
          yield* Effect.logWarning(
            "A Trigger's definition names no GitHub hook, but its object keeps one: left as it is",
          ).pipe(Effect.annotateLogs({ "trigger.id": id, "github.repo": kept.repo }));
        }

        return;
      }

      // A hook of another repo goes: a Trigger's source is fixed, so only a definition read wrong ever moves it.
      if (kept !== undefined && kept.repo !== wanted.repo) {
        if (kept.hookId !== undefined) store().deleteHook(kept.repo, kept.hookId, at);

        store().dropGitHubHook();
        kept = undefined;
      }

      const secrets = store().secrets();

      if (secrets === undefined || secrets === "unreadable") return;

      const synced = fingerprint(secrets);

      if (kept?.hookId !== undefined && kept.synced === synced && kept.problem === undefined)
        return;

      if (!force && kept?.nextTryAt !== undefined && kept.nextTryAt > at) return;

      // The owner may have just accepted the permission: the App's last failure to mint is not told again.
      if (force) yield* github.hooks.forgetFailure(wanted.repo);

      const placed = yield* Effect.result(place(wanted, kept?.hookId, secrets));

      if (Result.isSuccess(placed)) {
        store().keepGitHubHook({
          repo: wanted.repo,
          hookId: placed.success,
          synced,
          problem: undefined,
          attempts: 0,
          nextTryAt: undefined,
        });

        return;
      }

      const { failure } = placed;
      const attempts = kept?.attempts ?? 0;

      store().keepGitHubHook({
        repo: wanted.repo,
        hookId: kept?.hookId,
        synced: kept?.synced,
        problem: {
          code: Schema.is(GitHubHookFailed)(failure) ? failure.code : "unreachable",
          message: failure.message,
        },
        attempts: attempts + 1,
        nextTryAt: at + backoff(attempts),
      });
      yield* Effect.logWarning(
        "A Trigger's GitHub hook could not be made or updated",
        failure.message,
      ).pipe(Effect.annotateLogs({ "trigger.id": id, "github.repo": wanted.repo }));
    });

  const drop = (at: number) => {
    const kept = existing();
    const hook = kept?.githubHook();

    if (kept === undefined || hook === undefined) return;

    if (hook.hookId !== undefined) kept.deleteHook(hook.repo, hook.hookId, at);

    kept.dropGitHubHook();
  };

  const nextTryAt = (definition: TriggerDefinition | undefined, at: number): number | undefined => {
    const kept = existing();
    const times = Arr.map(kept?.hookDeletes() ?? [], (hookDelete) => hookDelete.nextTryAt);
    const wanted = githubHookOf(definition);
    const hook = kept?.githubHook();

    if (wanted !== undefined && hook === undefined && readable() !== undefined) times.push(at);
    else if (wanted !== undefined && hook?.nextTryAt !== undefined) times.push(hook.nextTryAt);

    return times.length === 0 ? undefined : Math.min(...times);
  };

  return { status, reconcile, deleteDue, drop, nextTryAt };
};
