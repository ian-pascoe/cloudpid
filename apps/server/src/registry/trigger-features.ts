// Whether the Registry keeps a GitHub-managed hook (`docs/development/workers.md` → GitHub-managed hooks' edges,
// `docs/architecture/triggers.md` → GitHub-managed hooks): the callee lists its features, and a caller offers a
// webhook source's `repo` and `events` only once `triggerFeatures` lists `githubHooks`, since an older Registry would
// drop them and keep a Trigger with no hook. The owner's `createTrigger` (`rpc.ts`) and the Session's `trigger_create`
// (`session/triggers.ts`) both ask here.
// @effect-diagnostics missingPipeableSignature:off -- a check over a Registry, not a combinator.
import { githubHookOf, type TriggerSourceInput } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { triggerGitHubHooksUnavailable, triggerGitHubHooksUnknown } from "./messages.ts";
import type { RegistryMethods } from "./Registry.ts";

/**
 * What Workers RPC says of `triggerFeatures` when the Registry does not have it: one from before it. Only that: any other
 * failure is one this caller can't read as an answer.
 */
const NO_SUCH_METHOD = /The RPC receiver does not implement the method "triggerFeatures"/u;

/**
 * Why `source` can't be made now, or undefined when it can: a source that names no GitHub-managed hook always can; one
 * that does is refused while the Registry answers `githubHooks: false` or has no `triggerFeatures`
 * (`triggerGitHubHooksUnavailable`), and while the call fails otherwise (`triggerGitHubHooksUnknown`, logged), which is
 * no answer at all.
 */
export const githubHookRefusal = (
  registry: Pick<RegistryMethods, "triggerFeatures">,
  source: TriggerSourceInput,
): Effect.Effect<string | undefined> =>
  githubHookOf({ source }) === undefined
    ? Effect.undefined
    : registry.triggerFeatures().pipe(
        Effect.map(({ githubHooks }) => (githubHooks ? undefined : triggerGitHubHooksUnavailable)),
        Effect.catchCause((cause) =>
          NO_SUCH_METHOD.test(Cause.pretty(cause))
            ? Effect.succeed(triggerGitHubHooksUnavailable)
            : Effect.logWarning("The Registry's triggerFeatures failed", cause).pipe(
                Effect.as(triggerGitHubHooksUnknown),
              ),
        ),
      );
