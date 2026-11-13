// The cores of the tools that change one Container setting, and of `environment_secret_build`
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split,
// Names and surfaces, Retries: `request_id`; `docs/architecture/agent-changes.md`): `environment_variable_set`,
// `_variable_unset`, `_container_resize`, `_idle_time_set`, `_setup_script_set`, `_start_script_set`, `_toolchains_set`,
// `_ignore_set`, `_spare_workspace_set` and `_secret_build`. Each core makes the tool's checks (a text it keeps that holds
// a credential, a Secret Reference, a size above the limit) and its one `Environments` call, and answers the text, the
// structured value of its surface and the card's `details`, with the Agent change the Session's wrapper tells the Run's
// Notification of. The Session's wrappers (`./environment.ts`, `./environment-secret-marks.ts`) call them with the
// session surface, whose words and values are byte-identical to the tools' before the split; the endpoint's dispatcher
// calls them with `surface: "endpoint"`, whose words name no Session, no tool the endpoint does not serve, and the owner
// where a Session's say the user. `REPLAYED` builds a family's answer from the Agent changes an earlier call with the
// same `request_id` recorded, for a repeat that finds the claim with no answer kept (#687 L17).
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import { compareInstances, INSTANCE_DESCRIPTIONS, SPARE_WORKSPACE_FIELD } from "@cloudpid/config";
import { type AgentChange, secretBuildField, variableField } from "@cloudpid/protocol";
import {
  ChangeEndpointOutput,
  ChangeOutput,
  type ContainerSettingToolName,
  EnvironmentChangeEndpointOutput,
  EnvironmentChangeOutput,
  GLOBAL_ID,
  GLOBAL_NAME,
  type HARNESS_TOOLS,
  type Surface,
  whoWords,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord/json";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type {
  ChangeAuthor,
  ChangedEnvironment,
  EnvironmentsService,
  GlobalChanged,
} from "./environment.ts";
import {
  credentialCheck,
  type DeployCredentials,
  describeApplied,
  describeAppliedGlobal,
  describeIdleCost,
  environmentTarget,
  pathsLine,
  plainValue,
  textSize,
} from "./environment-change-parts.ts";
import { EnvironmentsError, namedEnvironment, notFound } from "./environment-describe.ts";
import { globalReach, unchangedOutput, changeOutput } from "./environment-outputs.ts";
import {
  cutNote,
  cutText,
  fitted,
  type HarnessAnswer,
  type HarnessWrite,
  type HarnessWriteAnswer,
  INVALID_ARGUMENT,
} from "./harness.ts";
import { asOutput, changesOutput, scopeRef } from "./outputs.ts";
import { holdsPlaceholder, secretEnvName } from "./secrets/references.ts";

/**
 * Whether a text a change keeps holds what no plain value may hold: on a Session's surface a Secret it holds, and on
 * both a deploy-time credential or anything shaped like a GitHub token. It fails, refusing the call, for a Secret
 * Reference, which these tools do not resolve.
 */
export type TextCheck = (text: string) => Effect.Effect<boolean, EnvironmentsError>;

/** What the cores use: the Registry's Environments, as the Session or the endpoint reaches them, and the text check. */
export type EnvironmentChangeServices = {
  readonly environments: Pick<
    EnvironmentsService,
    "current" | "get" | "global" | "change" | "markSecret"
  >;
  readonly holdsSecret: TextCheck;
};

/** The arguments of tool `Name`, as a Session's call decodes them (the endpoint's add only `request_id`). */
type ArgsOf<Name extends ContainerSettingToolName | "environment_secret_build"> =
  (typeof HARNESS_TOOLS)[Name]["session"]["input"]["Type"];

/** A refusal the caller reads: on the endpoint, `invalid_argument` with the core's own words. */
const refused = (message: string) => EnvironmentsError.make({ message, code: INVALID_ARGUMENT });

/** What the endpoint's check of a text refuses a Secret Reference with: these tools resolve none. */
const ENDPOINT_PLACEHOLDER_REFUSAL =
  "Nothing was saved: a text of the call holds a Secret Reference, which these tools do not resolve, so what they save would hold the reference's text, not the Secret. A credential belongs in a Secret the owner keeps for the Environment on the Secrets page: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.";

/**
 * The endpoint's check of a text a change keeps: no Session holds a Secret there, so it catches the deploy-time
 * credentials and the GitHub token shapes, and refuses a Secret Reference; the Registry checks the kept Secrets in the
 * write's own transaction (`docs/architecture/mcp-endpoint.md` → Secret checks).
 */
export const endpointTextCheck: Effect.Effect<TextCheck, never, DeployCredentials> = Effect.map(
  credentialCheck,
  (holdsCredential): TextCheck =>
    (text) =>
      holdsPlaceholder(text)
        ? Effect.fail(refused(ENDPOINT_PLACEHOLDER_REFUSAL))
        : Effect.succeed(holdsCredential(text)),
);

/** What a text that holds a credential is said to hold, on each surface. */
const holdsWords = (surface: Surface): string =>
  surface === "session"
    ? "holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key"
    : "holds a GitHub token or the GitHub App's key";

/** A variable's value as the result shows it: plain, in full. */
const shownValue = (value: Schema.Json | null): string =>
  value === null ? "not set" : JSON.stringify(value);

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue | null => value as JsonValue | null;

/** The author of a change: the calling conversation in a Session; none on the endpoint, whose service knows the caller. */
export const authorOf = (
  tool: string,
  reason: string,
  conversation: number | undefined,
): Pick<ChangeAuthor, "conversation" | "tool" | "reason"> =>
  conversation === undefined ? { tool, reason } : { conversation, tool, reason };

/** The most each list of the Environments a change at Global reached weighs in an endpoint answer. */
const ENDPOINT_REACHED_BYTES = 8 * 1024;

type EndpointChange = typeof EnvironmentChangeEndpointOutput.Type;

type EndpointMark = typeof ChangeEndpointOutput.Type;

/**
 * A value whose Agent changes leave out their values, `before` first and then `after`, until it fits the endpoint's
 * `ENDPOINT_STRUCTURED_BYTES`: a script or the Toolchains can be 64 KiB on each side. `environment_get` with `field`
 * reads a value whole.
 */
export const fittedChanges = <A extends { readonly changes: EndpointChange["changes"] }>(
  value: A,
): A =>
  fitted(value, [
    (each) => ({
      ...each,
      changes: Arr.map(each.changes, (change) => ({
        ...change,
        before: null,
        before_truncated: true,
      })),
    }),
    (each) => ({
      ...each,
      changes: Arr.map(each.changes, (change) => ({
        ...change,
        after: null,
        after_truncated: true,
      })),
    }),
  ]);

/** A Container setting's change on the endpoint: no Session, so nothing is its own, and it waits for no Approval. */
export const endpointChangeOutput = ({
  environment,
  change,
  unchanged = [],
  newBuild = false,
  global,
}: {
  readonly environment: ChangedEnvironment;
  readonly change?: AgentChange | undefined;
  readonly unchanged?: ReadonlyArray<string>;
  readonly newBuild?: boolean;
  readonly global?: GlobalChanged | undefined;
}): EndpointChange =>
  fittedChanges({
    scope: scopeRef(environment),
    ...changesOutput(change === undefined ? [] : [change]),
    unchanged,
    new_build: newBuild,
    global: global === undefined ? null : globalReach(global, ENDPOINT_REACHED_BYTES),
  });

/** The endpoint's text, cut to what its answers hold; `environment_get` shows the setting itself. */
export const endpointText = (text: string): string =>
  cutText(text, cutNote("environment_get shows the setting as it is now"));

/** The text of an answer on `surface`: a Session's as it is, the endpoint's cut. */
export const textOn = (surface: Surface, text: string): string =>
  surface === "session" ? text : endpointText(text);

/** One change of a Container setting, as a core describes it to `settingWrite`. */
type SettingChangeSpec<Prepared> = {
  readonly tool: ContainerSettingToolName;
  readonly id: string;
  readonly field: string;
  readonly value: Schema.Json | null;
  /** The text the value is made of, kept as written: none holds a Secret's value or a credential. */
  readonly texts?: ReadonlyArray<string>;
  /** What a refusal for a text that holds one says. */
  readonly refusal?: string;
  readonly reason: string;
  readonly prepare: (environment: string) => Effect.Effect<Prepared, EnvironmentsError>;
  /** The result for a field that already has the value, given the Environment named. */
  readonly unchanged: (where: string) => string;
  /** The result for a change made, given the Environment named. */
  readonly changed: (made: {
    readonly where: string;
    readonly change: AgentChange;
    readonly own: boolean;
    readonly newBuild: boolean;
    /** Set for a change at Global. */
    readonly global: GlobalChanged | undefined;
    /** When the change applies, whom it reaches, and whose Build was asked for. */
    readonly applies: string;
    readonly prepared: Prepared;
  }) => string;
};

/**
 * The cores of the Container setting tools and of `environment_secret_build` over `services`, by tool name. A change is
 * refused when a text it keeps holds a credential (`holdsSecret`) or the reason does, then `prepare`d with the
 * Environment found, then made by the Registry; `id` may be `*`, Global's.
 */
export const environmentChangeCores = ({
  environments,
  holdsSecret,
}: EnvironmentChangeServices) => {
  /** Make the change `spec` describes on `surface`, and say how it went. */
  const settingWrite = <Prepared>(
    surface: Surface,
    conversation: number | undefined,
    {
      tool,
      id,
      field,
      value,
      texts = [],
      refusal = "",
      reason,
      prepare,
      unchanged,
      changed,
    }: SettingChangeSpec<Prepared>,
  ): Effect.Effect<HarnessWriteAnswer, EnvironmentsError> =>
    Effect.gen(function* () {
      if (texts.length > 0 && (yield* holdsSecret(Arr.join(texts, "\n")))) {
        return yield* refused(refusal);
      }

      // The reason is kept with the change as written, for the owner to read.
      if (yield* holdsSecret(reason)) {
        return yield* refused(
          `Nothing was saved: the reason ${holdsWords(surface)}. Say why without it.`,
        );
      }

      const { environment, own } =
        id === GLOBAL_ID
          ? { environment: GLOBAL_ID, own: false }
          : yield* environmentTarget(environments, surface)(id);

      const prepared = yield* prepare(environment);

      const applied = yield* environments.change({
        environment,
        change: { field, value },
        author: authorOf(tool, reason, conversation),
      });

      switch (applied.status) {
        case "missing":
          return yield* notFound(environment);
        // The Registry's refusals of a write over the endpoint say "Nothing was saved" themselves.
        case "rejected":
          return yield* refused(
            applied.message.startsWith("Nothing was saved")
              ? applied.message
              : `Nothing was saved: ${applied.message}`,
          );
        // Only a change made against an expected value, which these tools never give.
        case "changed-since":
          return yield* refused(
            `Nothing was saved: ${field} changed meanwhile, to ${shownValue(applied.current)}`,
          );
        case "unchanged":
          return {
            text: textOn(surface, unchanged(namedEnvironment(applied.environment))),
            structured:
              surface === "session"
                ? asOutput(EnvironmentChangeOutput, unchangedOutput(applied.environment, field))
                : asOutput(
                    EnvironmentChangeEndpointOutput,
                    endpointChangeOutput({ environment: applied.environment, unchanged: [field] }),
                  ),
            details: { unchanged: { environment: applied.environment, field } },
            logged: undefined,
          };
        case "changed": {
          const { change } = applied;
          // A change at Global reaches the Session's own Workspace unless its Environment overrides it.
          const reaches = applied.global?.own ?? own;

          const text = changed({
            where: namedEnvironment(applied.environment),
            change,
            own: reaches,
            newBuild: applied.newBuild,
            global: applied.global,
            applies:
              applied.global === undefined
                ? describeApplied(own, applied.newBuild, surface)
                : describeAppliedGlobal(field, applied.global),
            prepared,
          });

          return {
            text: textOn(surface, text),
            structured:
              surface === "session"
                ? asOutput(EnvironmentChangeOutput, changeOutput(applied, own))
                : asOutput(
                    EnvironmentChangeEndpointOutput,
                    endpointChangeOutput({
                      environment: applied.environment,
                      change,
                      newBuild: applied.newBuild,
                      global: applied.global,
                    }),
                  ),
            details: {
              agentChange: {
                id: change.id,
                environment: applied.environment,
                field,
                before: asJsonValue(change.before),
                after: asJsonValue(change.after),
              },
              own: reaches,
              newBuild: applied.newBuild,
            },
            logged: { tool, environmentName: applied.environment.name, field },
          };
        }
      }
    });

  /**
   * The Container settings in force where a change is made, with how a result names the place: Environment
   * `environment`'s, or Global's (`GLOBAL_ID`).
   */
  const settingsAt = (environment: string) =>
    Effect.gen(function* () {
      if (environment === GLOBAL_ID) {
        return { where: GLOBAL_NAME, settings: (yield* environments.global).settings };
      }

      const details = yield* environments.get(environment);

      if (details === null) return yield* notFound(environment);

      return { where: namedEnvironment(details), settings: details.settings };
    });

  /** What a value holding a credential is refused with: a Session's names the Secret it holds and its fix. */
  const variableRefusal = (surface: Surface, atGlobal: boolean): string =>
    surface === "session"
      ? `Nothing was saved: the value holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Variables are plain, so every command and the agent read them. Ask the user to keep the value as a Secret for the Environment on the Environments page instead: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.${atGlobal ? ` If the value is not secret (an email, a URL) and is kept as a Secret only so it is kept Global, ask the user to delete that Secret first (environment_secret_delete asks for their Approval, or they delete it on the Environments page): then this call saves it as a variable at Global.` : ""}`
      : "Nothing was saved: the value holds a GitHub token or the GitHub App's key. Variables are plain, so every command and the agent read them. A credential belongs in a Secret the owner keeps for the Environment on the Secrets page: every command then gets it as $PI_SECRET_<NAME>, and it is taken out of their output.";

  /** Change variable `name` to `value` (null unsets it) as `tool`. */
  const changeVariable = (
    tool: "environment_variable_set" | "environment_variable_unset",
    {
      id,
      name,
      value,
      reason,
    }: {
      readonly id: string;
      readonly name: string;
      readonly value: string | null;
      readonly reason: string;
    },
    surface: Surface,
    conversation: number | undefined,
  ) => {
    const atGlobal = id === GLOBAL_ID;
    const preposition = atGlobal ? "for" : "in";

    return settingWrite(surface, conversation, {
      tool,
      id,
      field: variableField(name),
      value,
      texts: value === null ? [] : [value],
      refusal: variableRefusal(surface, atGlobal),
      reason,
      prepare: () => Effect.void,
      unchanged: (where) =>
        value === null
          ? `${name} is not set ${preposition} ${where}: nothing changed, and nothing was recorded.`
          : `${name} already has that value ${preposition} ${where}: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, applies }) =>
        `${value === null ? `Unset ${name}` : `Set ${name}`} ${preposition} ${where}: it was ${shownValue(change.before)}, and is ${shownValue(change.after)} now. ${applies}`,
    });
  };

  /** The refusal of a script, Toolchains or path that holds a credential: they are stored as written. */
  const storedAsWritten = (surface: Surface, what: string): string =>
    surface === "session"
      ? `Nothing was saved: the ${what} holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. It is stored as written, and every command and the agent can read it. Use the Secret's name instead: ask the user to keep the value as a Secret for the Environment on the Environments page, and a command or script then gets it as $PI_SECRET_<NAME> (a Setup Script too, when the user marks the Secret for the Build).`
      : `Nothing was saved: the ${what} holds a GitHub token or the GitHub App's key. It is stored as written, and every command and the agent can read it. Use a Secret's name instead: the owner keeps a credential as a Secret for the Environment on the Secrets page, and a command or script then gets it as $PI_SECRET_<NAME> (a Setup Script too, when the Secret is marked for the Build).`;

  /** Change a text setting (a script or the Toolchains) as `tool`. */
  const changeText = (
    tool:
      | "environment_setup_script_set"
      | "environment_start_script_set"
      | "environment_toolchains_set",
    {
      field,
      what,
      id,
      text,
      reason,
      note,
    }: {
      readonly field: "setupScript" | "startScript" | "toolchains";
      /** What the setting is called in a result. */
      readonly what: string;
      readonly id: string;
      readonly text: string;
      readonly reason: string;
      /** What the result adds of when the setting runs or is used. */
      readonly note: string;
    },
    surface: Surface,
    conversation: number | undefined,
  ) =>
    settingWrite(surface, conversation, {
      tool,
      id,
      field,
      value: text,
      texts: [text],
      refusal: storedAsWritten(surface, what),
      reason,
      prepare: () => Effect.void,
      unchanged: (where) =>
        `The ${what} of ${where} is that text already: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, newBuild, global, applies }) =>
        `${text === "" ? `Removed the ${what}` : `Set the ${what}`} of ${where}: it was ${textSize(change.before)}, and is ${textSize(change.after)} now (the ${whoWords(surface)} sees the difference on the Environments page). ${note} ${applies}${newBuild || global !== undefined ? "" : " No new Build was asked for."}`,
    });

  const variableSet: HarnessWrite<ArgsOf<"environment_variable_set">, EnvironmentsError> = (
    args,
    surface,
    conversation,
  ) => changeVariable("environment_variable_set", args, surface, conversation);

  const variableUnset: HarnessWrite<ArgsOf<"environment_variable_unset">, EnvironmentsError> = (
    args,
    surface,
    conversation,
  ) =>
    changeVariable("environment_variable_unset", { ...args, value: null }, surface, conversation);

  const containerResize: HarnessWrite<ArgsOf<"environment_container_resize">, EnvironmentsError> = (
    { id, size, reason },
    surface,
    conversation,
  ) =>
    settingWrite(surface, conversation, {
      tool: "environment_container_resize",
      id,
      field: "instance",
      value: size,
      reason,
      prepare: (environment) =>
        Effect.gen(function* () {
          const { where, settings } = yield* settingsAt(environment);
          const limit = settings.maxInstance;

          if (compareInstances(size, limit) > 0) {
            return yield* refused(
              surface === "session"
                ? `Nothing was saved: ${size} is above the size limit of ${where}, ${limit}. Pick a size up to ${limit}, or ask the user to raise the limit: environment_container_size_limit_set asks for their Approval to raise it.`
                : `Nothing was saved: ${size} is above the size limit of ${where}, ${limit}. Pick a size up to ${limit}: the limit is a Limit that only the owner raises.`,
            );
          }
        }),
      unchanged: (where) =>
        `The Container size of ${where} is ${size} already: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, own, applies }) =>
        surface === "session"
          ? `Set the Container size of ${where}: it was ${plainValue(change.before)}, and is ${plainValue(change.after)} now (${INSTANCE_DESCRIPTIONS[size]}). It is the size of the next Container of every Workspace it reaches, and of those after each idle stop; Containers that run keep their size, and container_resize changes only this Workspace's current Container, until its idle stop, and no Environment. ${applies}${own ? " If container_resize gave this Workspace's Container another size, that size holds through container_restart until the idle stop." : ""}`
          : `Set the Container size of ${where}: it was ${plainValue(change.before)}, and is ${plainValue(change.after)} now (${INSTANCE_DESCRIPTIONS[size]}). It is the size of the next Container of every Workspace it reaches, and of those after each idle stop; Containers that run keep their size until their idle stop. ${applies}`,
    });

  const idleTimeSet: HarnessWrite<ArgsOf<"environment_idle_time_set">, EnvironmentsError> = (
    { id, minutes, reason },
    surface,
    conversation,
  ) =>
    settingWrite(surface, conversation, {
      tool: "environment_idle_time_set",
      id,
      field: "idleMinutes",
      value: minutes,
      reason,
      prepare: settingsAt,
      unchanged: (where) =>
        `The idle time of ${where} is ${minutes} already: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, applies, prepared }) =>
        `Set the idle time of ${where}: it was ${plainValue(change.before)} minutes, and is ${plainValue(change.after)} now. ${describeIdleCost(minutes, prepared.settings.instance)} ${applies}`,
    });

  const setupScriptSet: HarnessWrite<ArgsOf<"environment_setup_script_set">, EnvironmentsError> = (
    { id, script, reason },
    surface,
    conversation,
  ) =>
    changeText(
      "environment_setup_script_set",
      {
        field: "setupScript",
        what: "Setup Script",
        id,
        text: script,
        reason,
        note: "It runs once with this content on each Container: at each Workspace's next Container start (one restored from a snapshot has run the old script, not this one), and in the Environment's Build.",
      },
      surface,
      conversation,
    );

  const startScriptSet: HarnessWrite<ArgsOf<"environment_start_script_set">, EnvironmentsError> = (
    { id, script, reason },
    surface,
    conversation,
  ) =>
    changeText(
      "environment_start_script_set",
      {
        field: "startScript",
        what: "Start Script",
        id,
        text: script,
        reason,
        note: "It runs at every Container start of each Workspace, a restored one too; a service it starts must detach.",
      },
      surface,
      conversation,
    );

  const toolchainsSet: HarnessWrite<ArgsOf<"environment_toolchains_set">, EnvironmentsError> = (
    { id, mise_toml, reason },
    surface,
    conversation,
  ) =>
    changeText(
      "environment_toolchains_set",
      {
        field: "toolchains",
        what: "Toolchains",
        id,
        text: mise_toml,
        reason,
        note: "mise installs them at each Workspace's next Container start.",
      },
      surface,
      conversation,
    );

  const ignoreSet: HarnessWrite<ArgsOf<"environment_ignore_set">, EnvironmentsError> = (
    { id, patterns, reason },
    surface,
    conversation,
  ) =>
    settingWrite(surface, conversation, {
      tool: "environment_ignore_set",
      id,
      field: "ignore",
      value: patterns,
      texts: patterns,
      refusal: storedAsWritten(surface, "list of patterns"),
      reason,
      prepare: () => Effect.void,
      unchanged: (where) =>
        `The extra Container-only paths of ${where} are that list already: nothing changed, and nothing was recorded.`,
      changed: ({ where, change, applies }) =>
        `Set the extra Container-only paths of ${where}: they were ${pathsLine(change.before)}, and are ${pathsLine(change.after)} now. Warning: the next Container of each Workspace it reaches starts without the Workspace's snapshot, from the Environment's Build once there is one for this list, else from the image: dependency directories, build output and caches are made again, and the Setup Scripts run again (minutes). ${applies}`,
    });

  const spareWorkspaceSet: HarnessWrite<
    ArgsOf<"environment_spare_workspace_set">,
    EnvironmentsError
  > = ({ id, enabled, reason }, surface, conversation) =>
    settingWrite(surface, conversation, {
      tool: "environment_spare_workspace_set",
      id,
      field: SPARE_WORKSPACE_FIELD,
      value: enabled,
      reason,
      prepare: () => Effect.void,
      unchanged: (where) =>
        `The Spare Workspace of ${where} is ${enabled ? "on" : "off"} already: nothing changed, and nothing was recorded.`,
      changed: ({ where, global }) =>
        `${
          enabled
            ? `Turned the Spare Workspace of ${where} on: a spare is prepared now for each Environment it reaches that had a Session in the last 3 days, else after its next Session, and a new Session that takes it starts without waiting for the clones and the Setup Scripts.`
            : `Turned the Spare Workspace of ${where} off: the spare of each Environment it reaches, if it had one, is removed with its Snapshot, and none is prepared. A new Session's Workspace is made when the Session starts, waiting for the clones and the Setup Scripts.`
        }${global === undefined ? "" : ` ${describeAppliedGlobal(SPARE_WORKSPACE_FIELD, global)}`}`,
    });

  const secretBuild: HarnessWrite<ArgsOf<"environment_secret_build">, EnvironmentsError> = (
    { id, name, build, reason },
    surface,
    conversation,
  ) =>
    Effect.gen(function* () {
      if (yield* holdsSecret(reason)) {
        return yield* refused(
          surface === "session"
            ? "Nothing was saved: the reason holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Say it without the value; a credential belongs in a Secret kept for the Environment, which the user keeps on the Environments page."
            : "Nothing was saved: the reason holds a GitHub token or the GitHub App's key. Say it without the value; a credential belongs in a Secret the owner keeps on the Secrets page.",
        );
      }

      const environment =
        id === GLOBAL_ID
          ? GLOBAL_ID
          : (yield* environmentTarget(environments, surface)(id)).environment;

      const marked = yield* environments.markSecret({
        environment,
        name,
        build,
        author: authorOf("environment_secret_build", reason, conversation),
      });

      switch (marked.status) {
        case "missing":
          return yield* notFound(environment);
        case "absent":
          return yield* refused(
            `Nothing was saved: no Secret ${name} is ${keptIn(marked.environment)}. environment_get with id ${marked.environment.id} shows the Secrets kept (names only); a Secret kept Global is addressed with id "${GLOBAL_ID}". ${
              surface === "session"
                ? "To keep one, call secret_ask with keep: the user chooses in the form whether to keep it."
                : "The owner keeps Secrets on the Secrets page."
            }`,
          );
        case "unchanged": {
          const markOutput = {
            scope: scopeRef(marked.environment),
            changes: [],
            changes_truncated: false,
            unchanged: [secretBuildField(name)],
          };

          return {
            text: `${name}, ${keptIn(marked.environment)}, is ${markWords(marked.build)} already: nothing changed, and nothing was recorded.`,
            structured:
              surface === "session"
                ? asOutput(ChangeOutput, { ...markOutput, approval: null })
                : asOutput(ChangeEndpointOutput, markOutput),
            details: { unchanged: { environment: marked.environment, name } },
            logged: undefined,
          };
        }

        case "changed": {
          const { change } = marked;

          const markOutput = {
            scope: scopeRef(marked.environment),
            ...changesOutput([change]),
            unchanged: [],
          };

          const who = whoWords(surface);

          return {
            text: Arr.join(
              [
                `${name}, ${keptIn(marked.environment)}, was ${markWords(change.before === true)} and is ${markWords(build)} now.`,
                build
                  ? `${marked.environment.id === GLOBAL_ID ? "Every Setup Script of each Environment" : `Every Setup Script of ${where(marked.environment)}`} gets it as $${secretEnvName(name)}, in the Environment's Build and in the Setup Scripts of each Workspace's Container, from each Workspace's next Container start; a script can print it, so keep the marked Secrets to what a Setup Script needs.`
                  : "No Setup Script gets it any more; commands and Sessions still do.",
                // On the endpoint the upkeep runs once the answer is sent, so it is said as to come.
                `${surface === "session" ? "The Builds' upkeep ran" : "The Builds' upkeep runs once this answer is sent"}, as after the ${who}'s own switch: a new Build is made when the mark changes what the Setup Scripts get (environment_get shows how the Build goes). The change is recorded with your reason, and the ${who} can revert it on the Environments page.`,
              ],
              " ",
            ),
            structured:
              surface === "session"
                ? asOutput(ChangeOutput, { ...markOutput, approval: null })
                : asOutput(ChangeEndpointOutput, fittedChanges(markOutput)),
            details: {
              agentChange: {
                id: change.id,
                environment: marked.environment,
                field: change.field,
                before: asJsonValue(change.before),
                after: asJsonValue(change.after),
              },
            },
            logged: {
              tool: "environment_secret_build",
              environmentName: marked.environment.name,
              field: change.field,
            },
          };
        }
      }
    });

  return {
    environment_variable_set: variableSet,
    environment_variable_unset: variableUnset,
    environment_container_resize: containerResize,
    environment_idle_time_set: idleTimeSet,
    environment_setup_script_set: setupScriptSet,
    environment_start_script_set: startScriptSet,
    environment_toolchains_set: toolchainsSet,
    environment_ignore_set: ignoreSet,
    environment_spare_workspace_set: spareWorkspaceSet,
    environment_secret_build: secretBuild,
  };
};

export type EnvironmentChangeCores = ReturnType<typeof environmentChangeCores>;

/** The tools these cores serve, by name. */
export type EnvironmentChangeToolName = keyof EnvironmentChangeCores;

/** Where a Secret is kept, as a result names it. */
const where = (named: ChangedEnvironment): string =>
  named.id === GLOBAL_ID ? "Global" : `Environment ${JSON.stringify(named.name)} (${named.id})`;

/** "kept Global", or "kept for" the Environment, as a result says it. */
const keptIn = (named: ChangedEnvironment): string =>
  named.id === GLOBAL_ID ? "kept Global" : `kept for ${where(named)}`;

/** A Secret's Build mark, as a result says it. */
const markWords = (build: boolean): string => (build ? "marked for the Build" : "not marked");

// ─── Replayed answers ────────────────────────────────────────────────────────

/**
 * An Agent change an earlier call with the same `request_id` recorded, as the Registry's lookup of the claim gives it
 * (`changeRequest`): its number, its Scope with the Scope's name, its field and its values.
 */
export type RecordedChange = {
  readonly id: number;
  readonly scope: string;
  readonly scopeName: string;
  readonly field: string;
  readonly before: Schema.Json | null;
  readonly after: Schema.Json | null;
};

/** The most of a value a replayed answer's text shows: the values are in the structured answer, or `environment_get`'s. */
const REPLAYED_VALUE_CHARS = 80;

/** A value as a replayed answer's text shows it: JSON, cut. */
const replayedValue = (value: Schema.Json | null): string => {
  const shown = value === null ? "not set" : JSON.stringify(value);

  return shown.length <= REPLAYED_VALUE_CHARS
    ? shown
    : `${shown.slice(0, REPLAYED_VALUE_CHARS - 1)}…`;
};

/**
 * The text of a replayed answer: the changes the first call recorded, each with its Scope, field, values and number,
 * and that the full answer was not kept.
 */
export const replayedText = (
  changes: ReadonlyArray<RecordedChange>,
  /** The read that shows the current state. */
  shows = "environment_get",
): string =>
  endpointText(
    `Already applied by an earlier call with this request_id: ${
      changes.length === 0
        ? "its changes are no longer kept"
        : Arr.join(
            Arr.map(
              changes,
              (change) =>
                `${change.scopeName} · ${change.field} ${replayedValue(change.before)} → ${replayedValue(change.after)} (Agent change #${change.id})`,
            ),
            "; ",
          )
    }. The full answer wasn't kept; ${shows} shows the current state.`,
  );

/** The changes of a replayed answer, as an answer gives Agent changes: what the record does not say is neutral. */
export const replayedChanges = (changes: ReadonlyArray<RecordedChange>) =>
  changesOutput(
    Arr.map(changes, (change): AgentChange => ({
      id: change.id,
      scope: change.scope,
      at: 0,
      actor: "agent",
      session: null,
      conversation: null,
      tool: null,
      reason: "",
      field: change.field,
      before: change.before,
      after: change.after,
      reverts: null,
      revertedBy: null,
    })),
  );

/** The Scope of a replayed answer: the recorded changes' (or the call's `id`, when the Registry keeps none of them). */
export const replayedScope = (changes: ReadonlyArray<RecordedChange>, id: string) => {
  const [first] = changes;

  if (first !== undefined) return { id: first.scope, name: first.scopeName };

  return { id, name: id === GLOBAL_ID ? GLOBAL_NAME : id };
};

/** A replayed answer: built from `changes` for the call whose arguments name `id` (empty for a tool that names none). */
export type Replayed = (changes: ReadonlyArray<RecordedChange>, id: string) => HarnessAnswer;

/** A Container setting's replayed answer: no Build state and no reach at Global is kept, so `environment_get` shows them. */
export const replayedSetting: Replayed = (changes, id) => ({
  text: replayedText(changes),
  structured: asOutput(
    EnvironmentChangeEndpointOutput,
    fittedChanges({
      scope: replayedScope(changes, id),
      ...replayedChanges(changes),
      unchanged: [],
      global: null,
      replayed: true,
    } satisfies EndpointChange),
  ),
  details: null,
});

/**
 * The replayed answer of a tool that makes Agent changes at a Scope and nothing else known only to its first call: built from
 * the records, with `shows` the read that gives the current state.
 */
export const replayedChange =
  (shows: string): Replayed =>
  (changes, id) => ({
    text: replayedText(changes, shows),
    structured: asOutput(
      ChangeEndpointOutput,
      fittedChanges({
        scope: replayedScope(changes, id),
        ...replayedChanges(changes),
        unchanged: [],
        replayed: true,
      } satisfies EndpointMark),
    ),
    details: null,
  });

/** A Build mark's replayed answer. */
const replayedMark: Replayed = (changes, id) => ({
  text: replayedText(changes),
  structured: asOutput(
    ChangeEndpointOutput,
    fittedChanges({
      scope: replayedScope(changes, id),
      ...replayedChanges(changes),
      unchanged: [],
      replayed: true,
    } satisfies EndpointMark),
  ),
  details: null,
});

/** Each tool's replayed answer, by name (#687 L17): the shared fields from the records, the rest neutral. */
export const REPLAYED: Readonly<Record<EnvironmentChangeToolName, Replayed>> = {
  environment_variable_set: replayedSetting,
  environment_variable_unset: replayedSetting,
  environment_container_resize: replayedSetting,
  environment_idle_time_set: replayedSetting,
  environment_setup_script_set: replayedSetting,
  environment_start_script_set: replayedSetting,
  environment_toolchains_set: replayedSetting,
  environment_ignore_set: replayedSetting,
  environment_spare_workspace_set: replayedSetting,
  environment_secret_build: replayedMark,
};
