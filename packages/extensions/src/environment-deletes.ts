// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
// The cores of the deletes that wait for the owner's Approval, `environment_delete` and `environment_secret_delete`
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Approvals with no Session; #685 L2, #693
// S3b-1): `prepare`, `apply` and `render` over the Registry's Environments and the deletes (`EnvironmentRemovalService`),
// as `./approval-cores.ts` describes them. No revert can undo either, so each waits for the owner's Approval. The card
// shows what the delete takes, and the delete is made only while it takes no more than the owner saw (an Environment's
// Workspaces, Sessions, kept Secrets and Triggers) or while the Secret is still as they saw it (`updatedAt`).
//
// The Session's wrappers (`./approval-tools.ts`) run the reads and checks themselves (`check`, `read`), since a rerun
// after an eviction asks again for a target that is gone; the Registry-held Approvals run `prepare` and `apply` from the
// main Worker. Their words are a Session's, or on the endpoint (`surface`) the owner's, naming only the tools the
// endpoint serves.
import {
  type AgentChange,
  type ApprovalCardContent,
  DEFAULT_ENVIRONMENT,
  DELETED_FIELD,
} from "@cloudpid/protocol";
import { GLOBAL_ID, GLOBAL_NAME, type Surface, whoWords } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ApprovalCore, PlainText } from "./approval-cores.ts";
import { approvedAlready, changedSince, declinedAnswer } from "./approvals.ts";
import {
  type ChangeAuthor,
  type ChangedEnvironment,
  type EnvironmentsService,
  environmentTarget,
} from "./environment.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import { EnvironmentDeleteOutput, EnvironmentSecretDeleteOutput } from "./environment-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import { APPROVED, asOutput, scopeRef } from "./outputs.ts";

/** The tools' names, which their cards carry. */
export const DELETE_TOOL = "environment_delete";
export const SECRET_DELETE_TOOL = "environment_secret_delete";

/** What deleting an Environment takes with it, as the owner is asked about it. */
export const EnvironmentFootprint = Schema.Struct({
  /** Its Workspaces, but its spare. */
  workspaces: Schema.Int,
  /** The Sessions in them, archived ones too. */
  sessions: Schema.Int,
  /** The Secrets kept for it alone. */
  secrets: Schema.Int,
  /** Its Triggers; none in an Approval asked before they were counted. */
  triggers: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});

export type EnvironmentFootprint = typeof EnvironmentFootprint.Type;

/** A Secret kept in a scope, by name: whether it reaches the Build, and when its value or mark last changed. */
export type KeptSecretMark = {
  readonly name: string;
  readonly build: boolean;
  readonly updatedAt: number;
};

/** How the delete of a kept Secret went. */
export type SecretDeleted =
  | {
      readonly status: "deleted";
      /** The Environment, or Global (`GLOBAL_ID`), whose history records it. */
      readonly environment: ChangedEnvironment;
      readonly change: AgentChange;
    }
  /** No Secret of the name is kept there (any more): nothing was deleted. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  /** Its value or Build mark changed since the owner was asked: nothing was deleted. */
  | { readonly status: "changed-since"; readonly environment: ChangedEnvironment }
  | { readonly status: "missing" };

/**
 * What the caller of a long delete is told as it goes: `onStep` runs after each Workspace is removed, and after the spare
 * and the Build. The main Worker renews its lease there, and dies when another run holds it, which stops the delete
 * with what is left listed for the next run. One type for each layer it passes through: the core, the removal
 * (`apps/server/src/registry/removal.ts`) and an approved request's run.
 */
export type StepProgress = { readonly onStep?: Effect.Effect<void> | undefined };

/**
 * What the deletes that need the owner's Approval run over: the Registry and the objects. An Environment is deleted as
 * the owner's delete does, and a kept Secret as the owner's delete does, recorded.
 */
export type EnvironmentRemovalService = {
  /** What deleting `environment` takes with it; null when it is not registered. */
  readonly footprint: (
    environment: string,
  ) => Effect.Effect<EnvironmentFootprint | null, EnvironmentsError>;
  /**
   * Delete `environment` as the owner's delete does: its Workspaces with their Sessions, its spare Workspace, its Build
   * object, then its record, its kept Secrets and its Agent changes. Fails saying what is left when it cannot finish;
   * every step is safe to repeat, so a delete run again finishes what one cut off left.
   */
  readonly deleteEnvironment: (
    environment: string,
    progress?: StepProgress,
  ) => Effect.Effect<void, EnvironmentsError>;
  /**
   * What runs after an Environment's delete, run again for one found gone: a run cut after its record went may not have
   * run it (on the endpoint, the push of the hosts' MCP server sets, after the answer; nothing in a Session).
   */
  readonly afterGone: (environment: string) => Effect.Effect<void>;
  /** The Secrets kept in `scope` (an Environment's id, or `GLOBAL_ID`); null for an unknown Environment. */
  readonly keptSecrets: (
    scope: string,
  ) => Effect.Effect<ReadonlyArray<KeptSecretMark> | null, EnvironmentsError>;
  /**
   * Delete the Secret `name` kept in `environment`'s scope and record it, then run the Builds' upkeep it touches; with
   * `expected`, only while it was last changed then.
   */
  readonly deleteSecret: (input: {
    readonly environment: string;
    readonly name: string;
    readonly expected?: { readonly updatedAt: number } | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SecretDeleted, EnvironmentsError>;
};

/** What the cores read and write, and whose words they answer in (`surface`, a Session's when absent). */
export type DeleteServices = {
  readonly environments: Pick<EnvironmentsService, "current" | "get">;
  readonly removal: EnvironmentRemovalService;
  readonly plainText: PlainText;
  readonly surface?: Surface;
};

/** What a kept Secret was when the owner was asked to delete it: when its value or Build mark last changed. */
const SecretAsked = Schema.Struct({ updatedAt: Schema.Finite });

const decodeFootprint = Schema.decodeUnknownOption(EnvironmentFootprint);

const decodeSecretAsked = Schema.decodeUnknownOption(SecretAsked);

/** A name as a card's target quotes it (`JSON.stringify`). */
const decodeQuoted = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/** The refusal of a reason that holds a Secret, which both deletes make first. */
const plainReason = (plainText: PlainText, reason: string) =>
  plainText(reason, "the reason", "Say why without it.");

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "kept Global", or "kept for" the Environment, as a message says it. */
export const keptIn = (environment: ChangedEnvironment): string =>
  environment.id === GLOBAL_ID ? "kept Global" : `kept for ${named(environment)}`;

/** Whether `now` takes no more of anything than `approved`, what the owner was shown. */
export const within = (now: EnvironmentFootprint, approved: EnvironmentFootprint): boolean =>
  now.workspaces <= approved.workspaces &&
  now.sessions <= approved.sessions &&
  now.secrets <= approved.secrets &&
  now.triggers <= approved.triggers;

/** What deleting an Environment takes with it, as the card says it: what the owner approves. */
export const footprintWords = (footprint: EnvironmentFootprint): string =>
  `${count(footprint.workspaces, "Workspace")} with ${count(footprint.sessions, "Session")} (archived ones too), its spare Workspace and Build, ${count(footprint.secrets, "kept Secret")}, ${count(footprint.triggers, "Trigger")} and its Agent changes`;

// ─── environment_delete ──────────────────────────────────────────────────────

/** The arguments of `environment_delete`. */
export type DeleteArgs = { readonly id: string; readonly reason: string };

/**
 * What the delete knows of its target: the Environment as the owner was shown it, and what deleting it took then (null
 * for one gone before a rerun asked again).
 */
export type DeleteKnown = {
  readonly environment: ChangedEnvironment;
  readonly footprint: EnvironmentFootprint | null;
};

/** How the delete went. */
export type EnvironmentDeletion =
  /** Deleted, with what the owner approved; `environment` as it was when the delete began. */
  | {
      readonly status: "deleted";
      readonly environment: ChangedEnvironment;
      readonly footprint: EnvironmentFootprint;
    }
  /** Gone already (deleted by a run cut before it was told, or by the owner): nothing more needed deleting. */
  | { readonly status: "absent" }
  /** It takes more than the owner saw (a Workspace, Session, kept Secret or Trigger added since): nothing was deleted. */
  | { readonly status: "changed-since"; readonly footprint: EnvironmentFootprint };

/** The core of `environment_delete`, with the checks and the read its Session wrapper runs on their own. */
export type EnvironmentDeleteCore = ApprovalCore<
  DeleteArgs,
  DeleteKnown,
  EnvironmentDeletion,
  EnvironmentsError
> & {
  /** The refusals made before the Environment is read: a reason with a Secret, the default Environment, the Session's own. */
  readonly check: (args: DeleteArgs) => Effect.Effect<void, EnvironmentsError>;
  /** The Environment `id` and what deleting it takes, or null when it is gone. */
  readonly read: (
    id: string,
  ) => Effect.Effect<
    { readonly details: ChangedEnvironment; readonly footprint: EnvironmentFootprint } | null,
    EnvironmentsError
  >;
  /** The card the owner is shown, from what is known of the target. */
  readonly card: (known: DeleteKnown, reason: string) => ApprovalCardContent;
  /**
   * What the card the owner approved says of the target, for an apply that has only the stored request: the Environment
   * by the name the card quotes (by its id, should the card not say it), and the footprint approved.
   */
  readonly knownFromCard: (
    args: DeleteArgs,
    expected: Schema.Json | null,
    card: ApprovalCardContent,
  ) => DeleteKnown;
  /** `apply`, told of each step (`progress`): the main Worker renews its lease there. */
  readonly applyWith: (
    args: DeleteArgs,
    expected: Schema.Json | null,
    known: DeleteKnown | undefined,
    progress: StepProgress | undefined,
  ) => Effect.Effect<
    { readonly known: DeleteKnown; readonly result: EnvironmentDeletion },
    EnvironmentsError
  >;
};

/** The core of `environment_delete`. */
export const environmentDeleteCore = ({
  environments,
  removal,
  plainText,
  surface = "session",
}: DeleteServices): EnvironmentDeleteCore => {
  const target = environmentTarget(environments, surface);
  const who = whoWords(surface);

  const check = ({ id, reason }: DeleteArgs) =>
    Effect.gen(function* () {
      yield* plainReason(plainText, reason);

      if (id === DEFAULT_ENVIRONMENT) {
        return yield* EnvironmentsError.make({
          message:
            "Nothing was asked or deleted: the default Environment cannot be deleted, so that a new Session always has one to start in.",
          code: "invalid_argument",
        });
      }

      const { own } = yield* target(id);

      if (own) {
        return yield* EnvironmentsError.make({
          message:
            "Nothing was asked or deleted: this is this Session's own Environment, whose Workspace this Session runs in. The user can delete it from the Environments page.",
        });
      }
    });

  const read = (id: string) =>
    Effect.gen(function* () {
      const details = yield* environments.get(id);
      const footprint = yield* removal.footprint(id);

      return details === null || footprint === null
        ? null
        : { details: { id: details.id, name: details.name }, footprint };
    });

  const card = (known: DeleteKnown, reason: string): ApprovalCardContent => {
    const where = named(known.environment);

    return {
      tool: DELETE_TOOL,
      target: `Environment ${JSON.stringify(known.environment.name)}`,
      change: "Delete the Environment",
      before: known.footprint === null ? where : `${where}: ${footprintWords(known.footprint)}`,
      after: "Deleted, with no revert",
      reason,
    };
  };

  const knownFromCard = (
    { id }: DeleteArgs,
    expected: Schema.Json | null,
    { target }: ApprovalCardContent,
  ): DeleteKnown => {
    const prefix = "Environment ";

    const name = target.startsWith(prefix)
      ? Option.getOrElse(decodeQuoted(target.slice(prefix.length)), () => id)
      : id;

    return { environment: { id, name }, footprint: Option.getOrNull(decodeFootprint(expected)) };
  };

  const applyWith = (
    { id }: DeleteArgs,
    expected: Schema.Json | null,
    known: DeleteKnown | undefined,
    progress: StepProgress | undefined,
  ) =>
    Effect.gen(function* () {
      const now = yield* read(id);

      // Not known (a rerun in a Session that asked before): the Environment as it is now, or by its id once it is gone.
      const found: DeleteKnown = known ?? {
        environment: now?.details ?? { id, name: id },
        footprint: now?.footprint ?? null,
      };

      // Gone: a run cut after its record went, or the owner's own delete. What runs after a delete runs again.
      if (now === null) {
        yield* removal.afterGone(id);

        return { known: found, result: { status: "absent" as const } };
      }

      const approved = decodeFootprint(expected);

      // The approval covers what the card showed, or less of it: a delete cut off has taken some of it already. A
      // Workspace, Session or kept Secret added since is not covered.
      if (Option.isNone(approved) || !within(now.footprint, approved.value)) {
        return {
          known: found,
          result: { status: "changed-since" as const, footprint: now.footprint },
        };
      }

      yield* removal.deleteEnvironment(id, progress);

      return {
        known: found,
        result: {
          status: "deleted" as const,
          environment: now.details,
          footprint: approved.value,
        },
      };
    });

  return {
    tool: DELETE_TOOL,
    check,
    read,
    card,
    knownFromCard,
    applyWith,
    prepare: (args) =>
      Effect.gen(function* () {
        yield* check(args);

        const found = yield* read(args.id);

        if (found === null) return yield* notFound(args.id);

        const known = { environment: found.details, footprint: found.footprint };

        return { card: card(known, args.reason), expected: found.footprint, known };
      }),
    apply: (args, expected, _author, known) => applyWith(args, expected, known, undefined),
    render: (_args, _expected, { known, result }) => {
      const where = named(known.environment);

      switch (result.status) {
        case "absent":
          return Effect.succeed({
            text: approvedAlready(`${where} is gone`, surface),
            structured: asOutput(EnvironmentDeleteOutput, {
              environment: scopeRef(known.environment),
              deleted: true,
              footprint: null,
              approval: APPROVED,
            }),
            details: { approval: { approved: true } },
          });
        case "changed-since":
          return Effect.fail(
            EnvironmentsError.make({
              message: changedSince(
                `what deleting ${where} takes`,
                footprintWords(result.footprint),
                surface,
              ),
            }),
          );
        case "deleted": {
          const deleted = `${named(result.environment)}: ${footprintWords(result.footprint)}`;

          return Effect.succeed({
            text: `The ${who} approved: deleted ${deleted}. No revert brings it back.`,
            structured: asOutput(EnvironmentDeleteOutput, {
              environment: scopeRef(result.environment),
              deleted: true,
              footprint: result.footprint,
              approval: APPROVED,
            }),
            details: {
              approval: { approved: true },
              agentChange: {
                environment: { id: result.environment.id, name: result.environment.name },
                field: DELETED_FIELD,
                before: deleted,
                after: null,
              },
            },
          });
        }
      }
    },
    declined: (_args, known, answer) =>
      declinedAnswer(answer, `deleting ${named(known.environment)}`, (approval) =>
        asOutput(EnvironmentDeleteOutput, {
          environment: scopeRef(known.environment),
          deleted: false,
          footprint: null,
          approval,
        }),
      ),
  };
};

// ─── environment_secret_delete ───────────────────────────────────────────────

/** The arguments of `environment_secret_delete`. */
export type SecretDeleteArgs = {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
};

/**
 * What the Secret's delete knows of its target: the scope it is kept in (an Environment's id, or `GLOBAL_ID`), that
 * scope by id and name, and whether the Secret was marked for the Build when the owner was asked.
 */
export type SecretDeleteKnown = {
  readonly environment: string;
  readonly scope: ChangedEnvironment;
  readonly marked: boolean;
};

/** What the owner is asked to delete a kept Secret: the card, and what the Secret is now (`expected`). */
export type SecretAsk = {
  readonly card: ApprovalCardContent;
  readonly expected: Schema.Json | null;
};

/** The core of `environment_secret_delete`, with the read its Session wrapper runs on its own. */
export type SecretDeleteCore = ApprovalCore<
  SecretDeleteArgs,
  SecretDeleteKnown,
  SecretDeleted,
  EnvironmentsError
> & {
  /**
   * The checks, then the scope and the Secret kept there by the name, if any: the reason holds no Secret, the scope is
   * known.
   */
  readonly read: (
    args: SecretDeleteArgs,
  ) => Effect.Effect<
    { readonly known: SecretDeleteKnown; readonly secret: Option.Option<KeptSecretMark> },
    EnvironmentsError
  >;
  /** The refusal of a Secret not kept there: nothing is asked. */
  readonly notKept: (args: SecretDeleteArgs, known: SecretDeleteKnown) => EnvironmentsError;
  /** The card the owner is shown, and what the Secret is now (`expected`). */
  readonly card: (
    args: SecretDeleteArgs,
    known: SecretDeleteKnown,
    secret: Option.Option<KeptSecretMark>,
  ) => SecretAsk;
  /**
   * What a delete recorded under a request's claim says of its target: the scope from the record, and no Build mark,
   * which the record does not keep.
   */
  readonly knownFromClaim: (args: SecretDeleteArgs, scope: ChangedEnvironment) => SecretDeleteKnown;
};

/** The core of `environment_secret_delete`. */
export const secretDeleteCore = ({
  environments,
  removal,
  plainText,
  surface = "session",
}: DeleteServices): SecretDeleteCore => {
  const target = environmentTarget(environments, surface);
  const who = whoWords(surface);

  /** The Secret as the card and the answer name it: where it is kept, and its Build mark when the owner was asked. */
  const secretWords = (name: string, known: SecretDeleteKnown): string =>
    `${name}, ${keptIn(known.scope)}${known.marked ? ", marked for the Build" : ""}`;

  const read = ({ id, name, reason }: SecretDeleteArgs) =>
    Effect.gen(function* () {
      yield* plainReason(plainText, reason);

      const environment = id === GLOBAL_ID ? GLOBAL_ID : (yield* target(id)).environment;

      const scope: ChangedEnvironment =
        environment === GLOBAL_ID
          ? { id: GLOBAL_ID, name: GLOBAL_NAME }
          : yield* Effect.flatMap(environments.get(environment), (details) =>
              details === null
                ? notFound(environment)
                : Effect.succeed({ id: details.id, name: details.name }),
            );

      const kept = yield* removal.keptSecrets(environment);

      if (kept === null) return yield* notFound(environment);

      const secret = Arr.findFirst(kept, (each) => each.name === name);

      return {
        known: { environment, scope, marked: Option.isSome(secret) && secret.value.build },
        secret,
      };
    });

  const notKept = ({ name }: SecretDeleteArgs, known: SecretDeleteKnown) =>
    EnvironmentsError.make({
      message: `Nothing was asked or deleted: no Secret ${name} is ${keptIn(known.scope)}. environment_get with id ${known.environment} lists the Secrets kept (names only); a Secret kept Global is addressed with id "${GLOBAL_ID}".`,
      code: "not_found",
    });

  const card = (
    args: SecretDeleteArgs,
    known: SecretDeleteKnown,
    secret: Option.Option<KeptSecretMark>,
  ): SecretAsk => ({
    card: {
      tool: SECRET_DELETE_TOOL,
      target:
        known.scope.id === GLOBAL_ID ? "Global" : `Environment ${JSON.stringify(known.scope.name)}`,
      change: "Delete a kept Secret",
      before: secretWords(args.name, known),
      after: "Deleted, with no revert",
      reason: args.reason,
    },
    // The Secret as the owner saw it: deleted only while its value and Build mark are still those.
    expected: Option.match(secret, {
      onNone: () => null,
      onSome: ({ updatedAt }) => ({ updatedAt }),
    }),
  });

  /** What the answer of a deleted Secret says after "deleted …": when it stops reaching what used it, and the upkeep. */
  const afterDeleted =
    surface === "session"
      ? "Commands and Sessions stop getting it once they next ask for the kept Secrets (within a minute); this Session keeps taking its value out of output until it is evicted. The Builds' upkeep ran, as after the user's own delete. No revert brings it back: the user keeps it again with secret_ask's form or on the Environments page."
      : "Commands and Sessions stop getting it once they next ask for the kept Secrets (within a minute). The Builds' upkeep runs once the answer is sent, as after the owner's own delete. No revert brings it back: the owner keeps it again on the Secrets page.";

  return {
    tool: SECRET_DELETE_TOOL,
    read,
    notKept,
    card,
    knownFromClaim: ({ id }, scope) => ({ environment: id, scope, marked: false }),
    prepare: (args) =>
      Effect.gen(function* () {
        const { known, secret } = yield* read(args);

        if (Option.isNone(secret)) return yield* notKept(args, known);

        return { ...card(args, known, secret), known };
      }),
    apply: (args, expected, author, known) =>
      Effect.gen(function* () {
        const found = known ?? (yield* read(args)).known;

        const result = yield* removal.deleteSecret({
          environment: found.environment,
          name: args.name,
          expected: Option.getOrUndefined(decodeSecretAsked(expected)),
          author: { ...author, approved: true },
        });

        return { known: found, result };
      }),
    render: ({ name }, _expected, { known, result }) => {
      switch (result.status) {
        case "missing":
          return Effect.fail(notFound(known.environment));
        case "absent":
          return Effect.succeed({
            text: approvedAlready(`no Secret ${name} is ${keptIn(result.environment)}`, surface),
            structured: asOutput(EnvironmentSecretDeleteOutput, {
              scope: scopeRef(result.environment),
              name,
              deleted: true,
              approval: APPROVED,
            }),
            details: { approval: { approved: true } },
          });
        case "changed-since":
          return Effect.fail(
            EnvironmentsError.make({
              message: `The ${who} approved, but ${name}, ${keptIn(result.environment)}, changed since they were asked (its value or its Build mark): nothing was deleted. Ask again if it should still be deleted.`,
            }),
          );
        case "deleted":
          return Effect.succeed({
            text: `The ${who} approved: deleted ${secretWords(name, known)}. ${afterDeleted}`,
            structured: asOutput(EnvironmentSecretDeleteOutput, {
              scope: scopeRef(result.environment),
              name,
              deleted: true,
              approval: APPROVED,
            }),
            details: {
              approval: { approved: true },
              agentChange: {
                id: result.change.id,
                environment: result.environment,
                field: result.change.field,
                before: asJsonValue(result.change.before),
                after: asJsonValue(result.change.after),
              },
            },
          });
      }
    },
    declined: ({ name }, known, answer) =>
      declinedAnswer(answer, `deleting ${secretWords(name, known)}`, (approval) =>
        asOutput(EnvironmentSecretDeleteOutput, {
          scope: scopeRef(known.scope),
          name,
          deleted: false,
          approval,
        }),
      ),
  };
};
