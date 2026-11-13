// The cores of the tools for an Environment's own record and Build (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Shared definitions and the core/wrapper split, Names and surfaces, Retries: `request_id`;
// `docs/architecture/agent-changes.md`): `environment_create`, `environment_rename`, `environment_repo_add`,
// `environment_repo_remove` and `environment_rebuild` (a Build of the saved settings: a Test Build of `proposed` is the
// Session's own, `./environment-lifecycle.ts`). Each core makes the tool's checks (a text it keeps that holds a credential)
// and its one `Environments` call, and answers the text, the structured value of its surface and the card's `details`,
// with the Agent change the Session's wrapper tells the Run's Notification of. The Session's wrappers call them with the
// session surface, whose words and values are byte-identical to the tools' before the split, and keep what is a Session's
// own (the memo that makes a rerun after an eviction ask for one Build only); the endpoint's dispatcher calls them with
// `surface: "endpoint"`, whose words name the owner and no Session. `LIFECYCLE_REPLAYED` builds each tool's answer from the
// Agent changes an earlier call with the same `request_id` recorded, for a repeat that finds the claim with no answer kept
// (#687 L17): `environment_create`'s id, name and Repos come from its change's `after`.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import {
  type AgentChange,
  BUILD_FIELD,
  CreatedValue,
  type EnvironmentRepo,
  fieldRepo,
  NAME_FIELD,
  parseRepoSource,
  repoField,
} from "@cloudpid/protocol";
import {
  EnvironmentCreateEndpointOutput,
  type HARNESS_TOOLS,
  RebuildEndpointOutput,
  RecordChangeEndpointOutput,
  type SessionHarnessToolName,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord/json";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ChangedEnvironment, EnvironmentsService } from "./environment.ts";
import { environmentTarget, refuseSecretsIn } from "./environment-change-parts.ts";
import {
  authorOf,
  endpointText,
  fittedChanges,
  type RecordedChange,
  type Replayed,
  replayedChanges,
  replayedScope,
  replayedText,
  type TextCheck,
} from "./environment-changes.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import {
  createdOutput,
  RecordChangeOutput,
  rebuildOutput,
  recordOutput,
} from "./environment-lifecycle-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import { type HarnessWrite, type HarnessWriteAnswer, INVALID_ARGUMENT } from "./harness.ts";
import { asOutput, boundItems, changesOutput, scopeRef } from "./outputs.ts";
import type {
  EnvironmentMade,
  RecordMade,
  RecordOutcome,
  RecordUnchanged,
} from "./environment-lifecycle.ts";

/** What the cores use: the Registry's Environments, as the Session or the endpoint reaches them, and the text check. */
export type LifecycleChangeServices = {
  readonly environments: Pick<
    EnvironmentsService,
    "current" | "create" | "rename" | "addRepo" | "removeRepo" | "rebuild"
  >;
  readonly holdsSecret: TextCheck;
};

/** The arguments of tool `Name`, as a Session's call decodes them (the endpoint's add only `request_id`). */
type ArgsOf<Name extends SessionHarnessToolName> =
  (typeof HARNESS_TOOLS)[Name]["session"]["input"]["Type"];

/** A name or address a change holds before or after, as text; none for a change that had none. */
const shown = (value: AgentChange["before"]): string => (Predicate.isString(value) ? value : "");

/** What a Session's call says of the Workspaces a change to the record leaves alone. */
const WORKSPACES_UNTOUCHED = {
  session:
    "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets a clone or loses one, this Session's included.",
  endpoint:
    "Only the Environment's record and its spare Workspace change: no Workspace that has started a Session gets a clone or loses one.",
} as const;

/** What the endpoint adds after a change to the Repos: the upkeep that runs once the answer is sent. */
const REPOS_UPKEEP =
  "The spare Workspace, the Build and the MCP servers' set are brought up to date once this answer is sent, as after the owner's own change.";

/**
 * The cores of the lifecycle tools over `services`, by tool name. A change is refused when a text it keeps holds a
 * credential (`holdsSecret`), then made by the Registry; the Environment `id` names must be one (never `*`).
 */
export const lifecycleCores = ({ environments, holdsSecret }: LifecycleChangeServices) => {
  /** Fails, saving nothing, when a text holds a Secret the Session holds or a deploy-time credential. */
  const refuseSecrets = refuseSecretsIn(holdsSecret);

  /** The Registry's refusal of a change, as the owner's save says it: nothing was saved. On the endpoint, `invalid_argument`. */
  const refused = (surface: Surface, message: string) =>
    EnvironmentsError.make(
      surface === "session"
        ? { message: `Nothing was saved: ${message}` }
        : { message: `Nothing was saved: ${message}`, code: INVALID_ARGUMENT },
    );

  /** Apply `change` to the Environment `id` names; what it answers for each outcome but a recorded change. */
  const applied = <A extends RecordMade | RecordUnchanged>(
    surface: Surface,
    id: string,
    change: (environment: string) => Effect.Effect<RecordOutcome<A>, EnvironmentsError>,
  ) =>
    Effect.gen(function* () {
      const { environment } = yield* environmentTarget(environments, surface)(id);
      const answer = yield* change(environment);

      switch (answer.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* refused(surface, answer.message);
        default:
          return answer;
      }
    });

  /** A change to the record that was made: the answer of its surface, and what the Run's Notification is told of. */
  const recorded = ({
    surface,
    tool,
    environment,
    change,
    text,
    session,
    endpoint,
  }: {
    readonly surface: Surface;
    readonly tool: string;
    readonly environment: ChangedEnvironment;
    readonly change: AgentChange;
    readonly text: string;
    /** The Session's value, as its tool has always given it. */
    readonly session: JsonValue;
    /** The endpoint's value, built only on the endpoint. */
    readonly endpoint: () => JsonValue;
  }): HarnessWriteAnswer => ({
    text: surface === "session" ? text : endpointText(text),
    structured: surface === "session" ? session : endpoint(),
    details: {
      agentChange: {
        id: change.id,
        environment,
        field: change.field,
        before: asJsonValue(change.before),
        after: asJsonValue(change.after),
      },
    },
    logged: { tool, environmentName: environment.name, field: change.field },
  });

  /** A change that found the record as asked already: nothing was saved or recorded. */
  const unchangedAnswer = ({
    surface,
    text,
    environment,
    session,
    endpoint,
  }: {
    readonly surface: Surface;
    readonly text: string;
    readonly environment: ChangedEnvironment;
    /** The Session's value, as its tool has always given it. */
    readonly session: JsonValue;
    /** The endpoint's value, built only on the endpoint. */
    readonly endpoint: () => JsonValue;
  }): HarnessWriteAnswer => ({
    text: surface === "session" ? text : endpointText(text),
    structured: surface === "session" ? session : endpoint(),
    details: { unchanged: { environment } },
    logged: undefined,
  });

  /** `unchangedAnswer` for a tool that answers a change to the record, with `field` the one found as asked. */
  const unchangedRecord = (
    surface: Surface,
    text: string,
    environment: ChangedEnvironment,
    field: string,
  ) =>
    unchangedAnswer({
      surface,
      text,
      environment,
      session: asOutput(
        RecordChangeOutput,
        recordOutput({ environment, change: null, unchanged: [field] }),
      ),
      endpoint: () =>
        asOutput(RecordChangeEndpointOutput, recordEndpoint({ environment, unchanged: [field] })),
    });

  const create: HarnessWrite<ArgsOf<"environment_create">, EnvironmentsError> = (
    { name, repos, reason },
    surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      const sources = repos ?? [];

      yield* refuseSecrets(surface, [
        { what: "the name", text: name },
        { what: "a repo", text: Arr.join(sources, " ") },
        { what: "the reason", text: reason },
      ]);

      const made: EnvironmentMade = yield* environments.create({
        name,
        repos: sources,
        author: authorOf("environment_create", reason, conversation),
      });

      if (made.status === "rejected") return yield* refused(surface, made.message);

      const { environment, repos: held, change } = made;

      const text = Arr.join(
        surface === "session"
          ? [
              `Made ${named(environment)} with ${reposWords(held)} and the default Container settings. Its id is ${environment.id}: pass it as id to the other environment_* tools to set it up.`,
              "It is not this Session's Environment, and you cannot start a Session in it: the user can, from the Environments page. Its spare Workspace and its Build are made as for an Environment the user makes (environment_get shows the Build).",
            ]
          : [
              `Made ${named(environment)} with ${reposWords(held)} and the default Container settings. Its id is ${environment.id}: start a Session in it with session_start and this id, or set it up by passing the id as id to the tools that change an Environment's settings.`,
              "Its spare Workspace and its Build are made as for an Environment the owner makes, once this answer is sent (environment_get shows the Build).",
            ],
        " ",
      );

      return recorded({
        surface,
        tool: "environment_create",
        environment,
        change,
        text,
        session: createdOutput({ environment, repos: held, change }),
        endpoint: () => createdEndpoint({ environment, repos: held, changes: [change] }),
      });
    });

  const rename: HarnessWrite<ArgsOf<"environment_rename">, EnvironmentsError> = (
    { id, name, reason },
    surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets(surface, [
        { what: "the name", text: name },
        { what: "the reason", text: reason },
      ]);

      const answer = yield* applied(surface, id, (environment) =>
        environments.rename({
          environment,
          name,
          author: authorOf("environment_rename", reason, conversation),
        }),
      );

      if (answer.status === "unchanged") {
        return unchangedRecord(
          surface,
          `${named(answer.environment)} already has that name: nothing changed, and nothing was recorded.`,
          answer.environment,
          NAME_FIELD,
        );
      }

      const { environment, change } = answer;

      return recorded({
        surface,
        tool: "environment_rename",
        environment,
        change,
        text: `Renamed "${shown(change.before)}" to "${shown(change.after)}": ${named(environment)}. Its id is the same.`,
        session: recordValue(environment, change),
        endpoint: () =>
          asOutput(RecordChangeEndpointOutput, recordEndpoint({ environment, changes: [change] })),
      });
    });

  const repoAdd: HarnessWrite<ArgsOf<"environment_repo_add">, EnvironmentsError> = (
    { id, url, name, reason },
    surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets(surface, [
        { what: "the repo", text: url },
        { what: "the directory", text: name ?? "" },
        { what: "the reason", text: reason },
      ]);

      const answer = yield* applied(surface, id, (environment) =>
        environments.addRepo({
          environment,
          source: url,
          name,
          author: authorOf("environment_repo_add", reason, conversation),
        }),
      );

      if (answer.status === "unchanged") {
        return unchangedRecord(
          surface,
          `${named(answer.environment)} has that repo already: nothing changed, and nothing was recorded.`,
          answer.environment,
          // The directory it is cloned into: the one named, else the Repo's own name.
          repoField(
            name ??
              Result.match(parseRepoSource(url), {
                onSuccess: (repo) => repo.name,
                onFailure: () => url,
              }),
          ),
        );
      }

      const { environment, change } = answer;

      return recorded({
        surface,
        tool: "environment_repo_add",
        environment,
        change,
        text: `Added the repo ${fieldRepo(change.field) ?? ""} (${shown(change.after)}) to ${named(environment)}. ${WORKSPACES_UNTOUCHED[surface]} A new Workspace made from the Environment gets the clone.${surface === "session" ? "" : ` ${REPOS_UPKEEP}`}`,
        session: recordValue(environment, change),
        endpoint: () =>
          asOutput(RecordChangeEndpointOutput, recordEndpoint({ environment, changes: [change] })),
      });
    });

  const repoRemove: HarnessWrite<ArgsOf<"environment_repo_remove">, EnvironmentsError> = (
    { id, name, reason },
    surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      yield* refuseSecrets(surface, [
        { what: "the name", text: name },
        { what: "the reason", text: reason },
      ]);

      const answer = yield* applied(surface, id, (environment) =>
        environments.removeRepo({
          environment,
          name,
          author: authorOf("environment_repo_remove", reason, conversation),
        }),
      );

      const { environment, change } = answer;

      return recorded({
        surface,
        tool: "environment_repo_remove",
        environment,
        change,
        text: `Took the repo ${name} (${shown(change.before)}) out of ${named(environment)}. ${WORKSPACES_UNTOUCHED[surface]} A new Workspace made from the Environment does not get the clone.${surface === "session" ? "" : ` ${REPOS_UPKEEP}`}`,
        session: recordValue(environment, change),
        endpoint: () =>
          asOutput(RecordChangeEndpointOutput, recordEndpoint({ environment, changes: [change] })),
      });
    });

  /**
   * Ask for a Build of the saved settings and record it. The Session's wrapper keeps the memo that makes a call run again
   * after an eviction ask for nothing; on the endpoint a repeat with the same `request_id` finds the claim, and a repeat
   * cut between the Build's request and its record finds the Build under way.
   */
  const rebuild: HarnessWrite<
    Pick<ArgsOf<"environment_rebuild">, "id" | "reason">,
    EnvironmentsError
  > = ({ id, reason }, surface, conversation) =>
    Effect.gen(function* () {
      yield* refuseSecrets(surface, [{ what: "the reason", text: reason }]);

      const answer = yield* applied(surface, id, (environment) =>
        environments.rebuild({
          environment,
          author: authorOf("environment_rebuild", reason, conversation),
        }),
      );

      if (answer.status === "unchanged") {
        return unchangedAnswer({
          surface,
          text: `A Build of ${named(answer.environment)} for its current Repos and settings is already under way: nothing was asked for, and nothing was recorded. environment_get with id ${answer.environment.id} shows how it goes.`,
          environment: answer.environment,
          session: rebuildOutput({
            environment: answer.environment,
            change: null,
            unchanged: [BUILD_FIELD],
          }),
          endpoint: () =>
            asOutput(
              RebuildEndpointOutput,
              rebuildEndpoint({ environment: answer.environment, unchanged: [BUILD_FIELD] }),
            ),
        });
      }

      const { environment, change } = answer;

      return recorded({
        surface,
        tool: "environment_rebuild",
        environment,
        change,
        text: `Asked for a new Build of ${named(environment)}: the Build is under way. environment_get with id ${environment.id} shows its state and, when it fails, the end of its reason.`,
        session: rebuildOutput({ environment, change, unchanged: [] }),
        endpoint: () =>
          asOutput(RebuildEndpointOutput, rebuildEndpoint({ environment, changes: [change] })),
      });
    });

  return {
    environment_create: create,
    environment_rename: rename,
    environment_repo_add: repoAdd,
    environment_repo_remove: repoRemove,
    environment_rebuild: rebuild,
  };
};

export type LifecycleCores = ReturnType<typeof lifecycleCores>;

/** The tools these cores serve, by name. */
export type LifecycleToolName = keyof LifecycleCores;

/** An Environment's Repos as a result says them. */
const reposWords = (repos: ReadonlyArray<EnvironmentRepo>): string =>
  repos.length === 0
    ? "no repos"
    : `the repos ${Arr.join(
        Arr.map(repos, (repo) => `${repo.name} (${repo.url})`),
        ", ",
      )}`;

/** A change to the record as the Session's value gives it. */
const recordValue = (environment: ChangedEnvironment, change: AgentChange) =>
  asOutput(RecordChangeOutput, recordOutput({ environment, change, unchanged: [] }));

// ─── The endpoint's values ───────────────────────────────────────────────────

/** A change to the record on the endpoint: no Session, so no Approval; `changed` says whether any was recorded. */
const recordEndpoint = ({
  environment,
  changes = [],
  unchanged = [],
}: {
  readonly environment: ChangedEnvironment;
  readonly changes?: ReadonlyArray<AgentChange>;
  readonly unchanged?: ReadonlyArray<string>;
}): typeof RecordChangeEndpointOutput.Type =>
  fittedChanges({
    scope: scopeRef(environment),
    ...changesOutput(changes),
    unchanged,
    changed: changes.length > 0,
  });

/** The Environment made, on the endpoint: as `recordEndpoint`, with its Repos. */
const createdEndpoint = ({
  environment,
  repos,
  changes,
}: {
  readonly environment: ChangedEnvironment;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly changes: ReadonlyArray<AgentChange>;
}): JsonValue => {
  const kept = boundItems(Arr.map(repos, ({ name, url }) => ({ name, url })));

  return asOutput(EnvironmentCreateEndpointOutput, {
    ...recordEndpoint({ environment, changes }),
    repos: kept.items,
    repos_truncated: kept.truncated,
  });
};

/** A Build asked for (a change recorded), or found under way (none), on the endpoint. */
const rebuildEndpoint = ({
  environment,
  changes = [],
  unchanged = [],
}: {
  readonly environment: ChangedEnvironment;
  readonly changes?: ReadonlyArray<AgentChange>;
  readonly unchanged?: ReadonlyArray<string>;
}): typeof RebuildEndpointOutput.Type => ({
  ...recordEndpoint({ environment, changes, unchanged }),
  new_build: changes.length > 0,
});

// ─── Replayed answers ────────────────────────────────────────────────────────

/** A replayed record's answer: from the recorded changes, the rest neutral. */
const replayedBase = (changes: ReadonlyArray<RecordedChange>, id: string) =>
  fittedChanges({
    scope: replayedScope(changes, id),
    ...replayedChanges(changes),
    unchanged: [],
    changed: changes.length > 0,
    replayed: true as const,
  });

const replayedRecord: Replayed = (changes, id) => ({
  text: replayedText(changes),
  structured: asOutput(RecordChangeEndpointOutput, replayedBase(changes, id)),
  details: null,
});

/** `environment_create`'s replayed answer: the Environment's id, name and Repos are the change's `after`. */
const replayedCreate: Replayed = (changes, id) => {
  const base = replayedBase(changes, id);
  const [first] = changes;

  const held = Option.fromNullishOr(first).pipe(
    Option.flatMap((change) => Schema.decodeUnknownOption(CreatedValue)(change.after)),
  );

  const repos = boundItems(
    Option.getOrElse(
      Option.map(held, (value) => value.repos),
      () => [],
    ),
  );

  return {
    text: replayedText(changes),
    structured: asOutput(EnvironmentCreateEndpointOutput, {
      ...base,
      scope: Option.match(held, {
        onNone: () => base.scope,
        onSome: (value) => ({ id: base.scope.id, name: value.name }),
      }),
      repos: Arr.map(repos.items, ({ name, url }) => ({ name, url })),
      repos_truncated: repos.truncated,
    }),
    details: null,
  };
};

/** `environment_rebuild`'s replayed answer: its change was recorded once the Build was asked for. */
const replayedRebuild: Replayed = (changes, id) => ({
  text: replayedText(changes),
  structured: asOutput(RebuildEndpointOutput, {
    ...replayedBase(changes, id),
    new_build: changes.length > 0,
  }),
  details: null,
});

/** Each lifecycle tool's replayed answer, by name (#687 L17): the shared fields from the records, the rest neutral. */
export const LIFECYCLE_REPLAYED: Readonly<Record<LifecycleToolName, Replayed>> = {
  environment_create: replayedCreate,
  environment_rename: replayedRecord,
  environment_repo_add: replayedRecord,
  environment_repo_remove: replayedRecord,
  environment_rebuild: replayedRebuild,
};
