// The Session's `TriggerAccess` as the tests of the `trigger_*` tools fake it: Triggers in memory, each change made as
// the Registry makes the agent's (`apps/server/src/registry/trigger-changes.ts`): recorded as an Agent change of
// `triggers.<id>`, made only while the Trigger is as the owner saw it, and nothing for a change of nothing.
// @effect-diagnostics missingPipeableSignature:off
import {
  type AgentChange,
  asChangeJson,
  type GitHubHookStatus,
  githubHookOf,
  triggerChangeJson,
  type TriggerChanged,
  type TriggerChangeValue,
  type TriggerDefinition,
  triggerField,
  type TriggerPatch,
  defaultWhenBusy,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { ChangeAuthor } from "./environment.ts";
import { EnvironmentsError } from "./environment.ts";
import type { OwnTriggerInput, TriggerAccessService, TriggerWorkspace } from "./triggers.ts";

/** The Environment and the Session the fake's Session triggers belong to: the Session that calls the tools. */
const OWN_ENVIRONMENT = "default";

const OWN_SESSION = "s-1";

const sameValue = Schema.toEquivalence(Schema.NullOr(Schema.Json));

const valueOf = triggerChangeJson;

/** What the fake was asked to do, and holds. */
export type FakeTriggers = {
  readonly access: TriggerAccessService;
  /** The Triggers, by id: removed ones are gone. */
  readonly held: Map<string, TriggerDefinition>;
  /** The Agent changes recorded, oldest first, with who made them. */
  readonly changes: Array<AgentChange & { readonly author: ChangeAuthor }>;
  /** The ids `newId` draws, in turn. */
  readonly ids: Array<string>;
  /** The changing methods called, in turn: a call answered `unchanged` too. */
  readonly reached: Array<string>;
  /** Where a Trigger made with a GitHub-managed hook has it, by id: `ready` for one not set. */
  readonly hookAnswers: Map<string, GitHubHookStatus>;
};

/** A fake `TriggerAccess` over `environments` (id → name), its Triggers made at `now`. */
export const fakeTriggers = (
  environments: Readonly<Record<string, string>>,
  now = 1_000,
  /** The Workspace the fake's Session works in; none: it has no Workspace the Registry lists. */
  here?: TriggerWorkspace,
): FakeTriggers => {
  const held = new Map<string, TriggerDefinition>();
  const changes: Array<AgentChange & { readonly author: ChangeAuthor }> = [];
  const ids = ["0190-a", "0190-b", "0190-c"];
  const reached: Array<string> = [];
  const hookAnswers = new Map<string, GitHubHookStatus>();
  let drawn = 0;

  const record = (
    author: ChangeAuthor,
    id: string,
    before: TriggerDefinition | null,
    after: TriggerDefinition | null,
  ): TriggerChanged => {
    const environment = (before ?? after)?.environment ?? "";

    const change = {
      id: changes.length + 1,
      scope: environment,
      at: now,
      actor: "agent" as const,
      session: "s-1",
      conversation: author.conversation ?? null,
      tool: author.tool,
      reason: author.reason,
      field: triggerField(id),
      before: valueOf(before),
      after: valueOf(after),
      reverts: null,
      revertedBy: null,
      author,
    };

    const recorded = author.approved === true ? { ...change, approved: true as const } : change;

    changes.push(recorded);

    return {
      status: "changed",
      definition: after,
      environment: { id: environment, name: environments[environment] ?? environment },
      change: recorded,
    };
  };

  /** Change Trigger `id` to `next`, while it is `expected`. */
  const change = (
    id: string,
    expected: TriggerChangeValue | undefined,
    author: ChangeAuthor,
    next: (held: TriggerDefinition) => TriggerDefinition,
  ): TriggerChanged => {
    const before = held.get(id);

    if (before === undefined) return { status: "missing" };

    const after = next(before);

    if (sameValue(valueOf(before), valueOf(after))) {
      return { status: "unchanged", definition: before };
    }

    if (expected !== undefined && !sameValue(valueOf(before), asChangeJson(expected))) {
      return { status: "changed-since", current: before };
    }

    const revised = { ...after, revision: before.revision + 1 };

    held.set(id, revised);

    return record(author, id, before, revised);
  };

  /** `definition` with `patch` applied: an option set to null goes back to its default. */
  const patched = (definition: TriggerDefinition, patch: TriggerPatch): TriggerDefinition => {
    const { base: _base, model: _model, thinking: _thinking, ...rest } = definition;

    // A `match` patch changes a webhook source's filter alone (null: none).
    const held = patch.source ?? definition.source;

    const source =
      patch.match === undefined || held.type !== "webhook"
        ? held
        : patch.match === null
          ? { type: held.type, format: held.format }
          : { ...held, match: patch.match };

    const next: Types.Mutable<TriggerDefinition> = {
      ...rest,
      name: patch.name ?? definition.name,
      message: patch.message ?? definition.message,
      source,
      whenBusy: patch.whenBusy ?? definition.whenBusy,
    };

    const base = patch.base === undefined ? definition.base : patch.base;
    const model = patch.model === undefined ? definition.model : patch.model;
    const thinking = patch.thinking === undefined ? definition.thinking : patch.thinking;

    if (base !== undefined && base !== null) next.base = base;

    if (model !== undefined && model !== null) next.model = model;

    if (thinking !== undefined && thinking !== null) next.thinking = thinking;

    return next;
  };

  /** The Environment a Trigger made here belongs to: the one it names, its Workspace's, or this Session's own. */
  const ownEnvironmentOf = (input: OwnTriggerInput): string | undefined => {
    if (input.kind === "environment") return input.environment;

    return input.kind === "workspace" ? here?.environment : OWN_ENVIRONMENT;
  };

  const create = (id: string, input: OwnTriggerInput, author: ChangeAuthor): TriggerChanged => {
    const known = held.get(id);

    if (known !== undefined) return { status: "unchanged", definition: known };

    const environment = ownEnvironmentOf(input);

    if (environment === undefined || environments[environment] === undefined) {
      return { status: "missing" };
    }

    if (input.kind === "workspace" && input.workspace !== here?.id) {
      return { status: "invalid", problem: `There is no Workspace ${input.workspace}` };
    }

    const { kind, name, message, source, whenBusy } = input;

    const definition: Types.Mutable<TriggerDefinition> = {
      id,
      revision: 1,
      kind,
      environment,
      name,
      message,
      source,
      whenBusy: whenBusy ?? defaultWhenBusy(kind, source),
      paused: false,
      createdAt: now,
      updatedAt: now,
    };

    if (input.kind === "workspace" && here !== undefined) {
      definition.workspace = { id: here.id, branch: here.branch };
    }

    if (input.kind === "session") {
      definition.session = OWN_SESSION;
    } else {
      if (input.kind === "environment" && input.base !== undefined) definition.base = input.base;

      if (input.model !== undefined) definition.model = input.model;

      if (input.thinking !== undefined) definition.thinking = input.thinking;
    }

    held.set(id, definition);

    return record(author, id, null, definition);
  };

  const access: TriggerAccessService = {
    list: (environment) =>
      Effect.sync(() =>
        Arr.filter(
          [...held.values()],
          (definition) => environment === undefined || definition.environment === environment,
        ),
      ),
    get: (id) => Effect.sync(() => held.get(id) ?? null),
    newId: Effect.sync(() => ids[drawn++] ?? `0190-${String(drawn)}`),
    workspace:
      here === undefined
        ? Effect.fail(EnvironmentsError.make({ message: "This Session has no Workspace" }))
        : Effect.succeed(here),
    create: ({ id, trigger, author }) =>
      Effect.sync(() => {
        reached.push("create");

        const applied = create(id, trigger, author);
        const hook = githubHookOf(trigger);

        return hook === undefined
          ? { applied }
          : {
              applied,
              github: hookAnswers.get(id) ?? { repo: hook.repo, state: "ready" as const },
            };
      }),
    update: ({ id, patch, expected, author }) =>
      Effect.sync(() => {
        reached.push("update");

        return change(id, expected, author, (known) => patched(known, patch));
      }),
    setPaused: ({ id, paused, expected, author }) =>
      Effect.sync(() => {
        reached.push("setPaused");

        return change(id, expected, author, (known) => ({ ...known, paused }));
      }),
    remove: ({ id, author }) =>
      Effect.sync(() => {
        reached.push("remove");

        const before = held.get(id);

        if (before === undefined) return { status: "missing" as const };

        held.delete(id);

        return record(author, id, before, null);
      }),
  };

  return { access, held, changes, ids, reached, hookAnswers };
};
