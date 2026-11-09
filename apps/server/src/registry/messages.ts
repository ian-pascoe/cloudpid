// What the main Worker's Registry endpoint and its upkeeps tell the owner when something is missing or failed.
// @effect-diagnostics missingPipeableSignature:off
import * as Cause from "effect/Cause";

/** What went wrong in `cause`, in a line. */
export const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return error instanceof Error ? error.message : String(error);
};

/** That no Environment is registered under `id`. */
export const noEnvironment = (id: string): string => `Environment "${id}" does not exist`;

/** That no Workspace is registered under `id`. */
export const noWorkspace = (id: string): string => `There is no Workspace ${id}`;

/** That the Trigger asked for is gone: never made, or removed. */
export const triggerRemoved = "This trigger was removed";

/** That a Trigger's object didn't answer a read or a Fire now, which may be asked again. */
export const triggerUnreachable = "The trigger's object didn't answer: try again";

/** That Fire now was asked of a paused Trigger. */
export const triggerPaused = "The trigger is paused: resume it to fire it";

/**
 * That a Trigger with a GitHub-managed hook was asked of a Registry that doesn't list `githubHooks` yet (one older than
 * its caller, for the minutes after a deploy), which would keep the Trigger with no hook.
 */
export const triggerGitHubHooksUnavailable =
  "The server is being updated and can't make a GitHub-managed hook yet: try again in a few minutes";

/** That a Trigger's URL or Signing secret was asked of one that has none: only a webhook Trigger does. */
export const triggerNoWebhook =
  "This trigger has no URL or signing secret: only a webhook trigger does";

/** That a Trigger's kept URL and Signing secret no longer read: the owner makes new ones. */
export const triggerSecretsUnreadable =
  "This trigger's URL and signing secret can't be read: make new ones with New URL or New signing secret";

/** That the revert of a removal could not wipe the Trigger's object, which may still hold the old URL and secret. */
export const triggerRevertNotWiped =
  "The change is reverted, but the trigger's object didn't answer, so it isn't scheduled and may still have its old URL and signing secret: pause and resume it, then make new ones with New URL and New signing secret";

/** That Fire again was asked of a Trigger that has accepted no delivery yet. */
export const triggerNoDelivery =
  "No delivery has been accepted yet: there is nothing to send again";

/** That a Trigger was made under an id another Trigger has, or had, with other values. */
export const triggerIdTaken = "A trigger was already saved under this id with other values";

/** That a Trigger can't be kept for a Subagent Workspace, which lasts as long as its subagent. */
export const subagentWorkspaceHoldsNoTrigger =
  "A subagent's Workspace can't hold a Trigger: it lasts only as long as its subagent";

/** That the Trigger an edit was opened on has changed since. */
export const triggerChangedSince = "The trigger changed since you opened it: reopen the form";

/** That what `done` saved left a Trigger whose object never answered, so nothing schedules it yet. */
export const triggerUnscheduled = (done: string): string =>
  `${done}, but the trigger's object didn't answer, so it isn't scheduled yet: pause and resume it to schedule it.`;

/** That another Environment has the name, whatever the case. */
export const nameTaken = (name: string): string => `Another environment is already named "${name}"`;

/** That the Environment has a Repo in the directory already. */
export const repoTaken = (directory: string): string =>
  `The environment already has a repo in ${directory}: name this one`;

/** That the Environment has no Repo in the directory. */
export const noRepo = (directory: string): string => `The environment has no repo "${directory}"`;

/** `first`, then `then` as a sentence of its own: one full stop between them, whether or not `first` ends in one. */
export const thenSaying = (first: string, then: string): string =>
  `${first.endsWith(".") ? first : `${first}.`} ${then}`;
