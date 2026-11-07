// The agent's Trigger changes (`docs/architecture/triggers.md` → Agent tools and Approval, ADR-0019, ADR-0047): each
// made as the owner's edit is (`./triggers.ts`) and recorded in the same transaction as an Agent change of the field
// `triggers.<id>` under the Trigger's Environment, with the Trigger before and after (`TriggerChangeValue`; null before
// its creation and after its removal), so the owner sees each one and can revert it. A change the owner approved is
// made only while the Trigger is still as they saw it. The agent's removal keeps the Trigger's row, out of every read,
// while a change in the history refers to it (`dropRemovedTriggers`), so its revert brings it back. The caller wakes
// the Trigger's object after each (`Trigger.sync`): the Registry never calls out.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over SQLite.
import {
  type AgentChange,
  triggerChangeJson,
  type TriggerChanged,
  triggerChangeValue,
  TriggerChangeValue,
  type TriggerDefinition,
  triggerField,
  type TriggerInput,
  type TriggerPatch,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { AgentChangeAuthor, AgentChanges } from "./agent-changes.ts";
import type { RegistryStorage, RegistryStore } from "./store.ts";
import type { Triggers, TriggerWrite } from "./triggers.ts";

/** How the owner's revert of a Trigger's Agent change went. */
export type TriggerRevert =
  | {
      readonly status: "reverted";
      readonly change: AgentChange;
      /** The Trigger after the revert; null once removed. */
      readonly definition: TriggerDefinition | null;
    }
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    }
  | { readonly status: "refused"; readonly message: string };

const sameValue = Schema.toEquivalence(Schema.NullOr(Schema.Json));

const sameTrigger = Schema.toEquivalence(TriggerChangeValue);

const decodeValue = Schema.decodeUnknownOption(TriggerChangeValue);

const valueOf = triggerChangeJson;

/** What a write that wrote nothing answers the agent: why not. */
const refused = (
  written: Extract<TriggerWrite, { status: "invalid" | "missing" }>,
): TriggerChanged =>
  written.status === "invalid"
    ? { status: "invalid", problem: written.problem }
    : { status: "missing" };

/** The agent's changes of the Registry's Triggers. */
export const openTriggerChanges = (
  storage: RegistryStorage,
  store: Pick<RegistryStore, "getEnvironment">,
  triggers: Triggers,
  changes: AgentChanges,
) => {
  /** Record `author`'s change of Trigger `definition` (null after a removal) from `before`. */
  const record = (
    author: AgentChangeAuthor,
    id: string,
    environment: string,
    before: TriggerDefinition | null,
    definition: TriggerDefinition | null,
    now: number,
  ): TriggerChanged => {
    const change = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: triggerField(id),
      before: valueOf(before),
      after: valueOf(definition),
      reverts: null,
      approved: author.approved,
    });

    const known = store.getEnvironment(environment);

    return {
      status: "changed",
      definition,
      environment: { id: environment, name: known?.name ?? environment },
      change,
    };
  };

  /**
   * Make a change of Trigger `id` with `write` and record it, provided the Trigger is still `expected` (as the owner
   * saw it, when they approved the change).
   */
  const changed = (
    id: string,
    expected: TriggerChangeValue | undefined,
    author: AgentChangeAuthor,
    now: number,
    write: (holds?: (current: TriggerDefinition) => boolean) => TriggerWrite,
  ): TriggerChanged =>
    storage.transactionSync((): TriggerChanged => {
      const before = triggers.get(id);

      if (before === null) return { status: "missing" };

      // A Trigger that already has the values is unchanged, whatever the owner saw: the rerun of a call that made the
      // change before an eviction.
      const written = write(
        expected === undefined
          ? undefined
          : (current) => sameTrigger(triggerChangeValue(current), expected),
      );

      switch (written.status) {
        case "ok":
          return record(author, id, before.environment, before, written.definition, now);
        case "unchanged":
          return { status: "unchanged", definition: written.definition };
        case "changed-since":
          return { status: "changed-since", current: written.definition };
        case "invalid":
        case "missing":
          return refused(written);
      }
    });

  return {
    /**
     * Make Trigger `id` and record it. A Trigger of that id is answered as it is, so the rerun of an approved call
     * (whose id the Approval keeps) makes no second one.
     */
    create: (
      id: string,
      input: TriggerInput,
      author: AgentChangeAuthor,
      now: number,
    ): TriggerChanged =>
      storage.transactionSync((): TriggerChanged => {
        const held = triggers.stored(id);

        if (held !== null) {
          return held.removedAt === null
            ? { status: "unchanged", definition: held.definition }
            : { status: "changed-since", current: null };
        }

        if (input.kind === "environment" && store.getEnvironment(input.environment) === null) {
          return { status: "missing" };
        }

        const made = triggers.create(id, input, now);

        switch (made.status) {
          case "ok":
          case "unchanged":
          case "changed-since":
            return record(author, id, made.definition.environment, null, made.definition, now);
          case "invalid":
          case "missing":
            return refused(made);
        }
      }),

    /** Change Trigger `id`'s fields and record it, while it is still `expected`. */
    update: (
      id: string,
      patch: TriggerPatch,
      expected: TriggerChangeValue | undefined,
      author: AgentChangeAuthor,
      now: number,
    ): TriggerChanged =>
      changed(id, expected, author, now, (holds) => triggers.update(id, patch, now, holds)),

    /** Pause or resume Trigger `id` and record it, while it is still `expected`. */
    setPaused: (
      id: string,
      paused: boolean,
      expected: TriggerChangeValue | undefined,
      author: AgentChangeAuthor,
      now: number,
    ): TriggerChanged =>
      changed(id, expected, author, now, (holds) => triggers.setPaused(id, paused, now, holds)),

    /** Take Trigger `id` out of every read and Fire, and record it; its row stays for a revert. */
    remove: (id: string, author: AgentChangeAuthor, now: number): TriggerChanged =>
      storage.transactionSync((): TriggerChanged => {
        const before = triggers.get(id);

        if (before === null || !triggers.retire(id, now)) return { status: "missing" };

        return record(author, id, before.environment, before, null, now);
      }),
  };
};

/** The agent's changes of the Registry's Triggers. */
export type TriggerChanges = ReturnType<typeof openTriggerChanges>;

/**
 * Revert `change` (the agent's, not reverted yet, of Trigger `id`: the caller checked) of `environment`: a Trigger made
 * is removed, one removed is brought back, and a change's values are put back, at the Trigger's next revision, recorded
 * as the owner's change. Refused, saying what the Trigger is now, once it no longer is as the change left it.
 */
export const revertTriggerChange = (
  triggers: Triggers,
  changes: AgentChanges,
  environment: string,
  id: string,
  change: AgentChange,
  now: number,
): TriggerRevert => {
  const held = triggers.stored(id);
  const active = held !== null && held.removedAt === null ? held.definition : null;
  const current = valueOf(active);

  if (!sameValue(current, change.after)) {
    return { status: "changed-since", field: change.field, current };
  }

  let definition: TriggerDefinition | null = null;

  if (change.before === null) {
    // A Trigger made: out it goes, kept for a revert of this revert's own record.
    triggers.retire(id, now);
  } else {
    const before = decodeValue(change.before);

    if (Option.isNone(before)) {
      return { status: "refused", message: `Change ${change.id} has no Trigger to put back` };
    }

    definition = triggers.restore(id, before.value, now);

    if (definition === null) {
      return { status: "refused", message: "The Trigger was deleted for good" };
    }
  }

  const record = changes.record({
    scope: environment,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`,
    field: change.field,
    before: current,
    after: valueOf(definition),
    reverts: change.id,
  });

  return { status: "reverted", change: record, definition };
};
