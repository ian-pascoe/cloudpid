// The Container setting tools and `environment_secret_build` for both surfaces (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Names and surfaces, The tools): `environment_variable_set`, `_variable_unset`,
// `_container_resize`, `_idle_time_set`, `_setup_script_set`, `_start_script_set`, `_toolchains_set`, `_ignore_set`,
// `_spare_workspace_set` and `_secret_build`. The in-session descriptions, parameters and output schemas stay as they
// were (the snapshot in `packages/extensions/src/harness-session.test.ts` pins them). The endpoint's sentences name no
// Session, no tool the endpoint does not serve (`container_restart`, `container_resize`, `secret_ask`, the Limit tools)
// and no "this Session's own"; every endpoint input takes `request_id`, and every endpoint output is a flat object.
// @effect-diagnostics missingPipeableSignature:off
import {
  compareInstances,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_TYPES,
  InstanceType,
  MAX_IDLE_MINUTES,
  MAX_IGNORE_PATTERNS,
  MAX_SCRIPT_BYTES,
  MAX_TOOLCHAINS_BYTES,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  ChangeEndpointOutput,
  ChangeOutput,
  EnvironmentChangeEndpointOutput,
  EnvironmentChangeOutput,
} from "./change-output.ts";
import { MAX_CHANGE_REASON, Reason, ReasonEndpoint, RequestIdField } from "./reason.ts";
import { GLOBAL_ID, idOrGlobal } from "./scope.ts";
import { SecretName } from "./secret-name.ts";
import { DESTRUCTIVE_IDEMPOTENT, WRITE_IDEMPOTENT } from "./surface.ts";

/** Every size, smallest memory first, with what it offers. */
export const SIZE_LINES = Arr.join(
  Arr.map(
    Arr.sort(INSTANCE_TYPES, compareInstances),
    (size) => `- ${size}: ${INSTANCE_DESCRIPTIONS[size]}`,
  ),
  "\n",
);

/** What `*` names in a Container setting tool's `id`. */
const SETTING_KEPT =
  "the Container setting at Global, which each Environment that does not override it inherits";

/** The `id` of a Container setting tool: one Environment, or `*` for Global's. */
const SettingId = idOrGlobal(SETTING_KEPT);

const SettingIdEndpoint = idOrGlobal(SETTING_KEPT, "endpoint");

const VariableName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The variable's name, such as API_URL: letters, digits and _, not starting with a digit",
});

const Value = Schema.String.annotate({ description: "The value, saved as written" });

const Size = InstanceType.annotate({
  description: "The size of the Environment's next Containers",
});

const Minutes = Schema.Finite.annotate({
  description: `Minutes of idle time, a whole number from 1 to ${MAX_IDLE_MINUTES}`,
});

const Script = Schema.String.annotate({
  description: "The whole script, replacing the one there is; empty removes it",
});

const MiseToml = Schema.String.annotate({
  description: "The whole mise.toml, replacing the one there is; empty means the base Toolchains",
});

const Patterns = Schema.Array(Schema.String).annotate({
  description: "The whole list of extra Container-only paths; empty removes them all",
});

const Enabled = Schema.Boolean.annotate({
  description: "true keeps a spare made ahead; false removes it and prepares none",
});

/** `environment_secret_build`'s own `reason`, with its own example. */
const MarkReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you change the mark, for the user to read in the Agent changes, such as 'the Setup Script runs npm install against the private registry'",
});

/** The same `reason` on the endpoint, whose words name the owner. */
const MarkReasonEndpoint = MarkReason.annotate({
  description:
    "Why you change the mark, for the owner to read in the Agent changes, such as 'the Setup Script runs npm install against the private registry'",
});

const Name = SecretName.annotate({ description: "The Secret's name, such as NPM_TOKEN" });

const Build = Schema.Boolean.annotate({
  description: "true marks the Secret for the Build, false takes the mark off",
});

/** The description pieces the in-session tools share, as they have always read. */
const PLAIN_VALUES =
  "Variables are plain: every command, and you, can read them, and they are not taken out of output. Never put a credential in one: a value holding a Secret this Session holds, or a GitHub token, is refused, and so is a Secret Reference, which is not resolved here.";

const RECORDED = `With id "*" the setting is changed at Global: every Environment that does not override it inherits it, and a new Build is asked for in each whose Build is made with it. Setting an Environment's value makes it the Environment's own (an Override), which a later change at Global does not reach; environment_setting_reset makes it inherit Global's again. The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.`;

const STORED_AS_WRITTEN =
  "The text is stored as written: a Secret this Session holds, or a GitHub token, in it is refused.";

/** The same pieces on the endpoint: no Session, and nothing is pushed to a Container that runs. */
const PLAIN_VALUES_ENDPOINT =
  "Variables are plain: every command, and the agent, can read them, and they are not taken out of output. Never put a credential in one: a value holding a kept Secret, or a GitHub token, is refused, and so is a Secret Reference, which is not resolved here.";

const RECORDED_ENDPOINT = `With id "*" the setting is changed at Global: every Environment that does not override it inherits it, and a new Build is asked for in each whose Build is made with it. Setting an Environment's value makes it the Environment's own (an Override), which a later change at Global does not reach. The change is recorded with your reason, and the owner can see and revert it on the Environments page. It applies at each Workspace's next Container start: a Container that runs keeps what it started with.`;

const STORED_AS_WRITTEN_ENDPOINT =
  "The text is stored as written: a kept Secret's value, or a GitHub token, in it is refused.";

/** The paragraphs of a description, as the in-session tools join them. */
const paragraphs = (lines: ReadonlyArray<string>): string => Arr.join(lines, "\n\n");

export const environmentVariableSet = {
  name: "environment_variable_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Set one of an Environment's variables (the one id names): every command on its Workspaces' Containers, their Setup and Start Scripts and the Environment's Build get it. The same rules as the user's Edit dialog: at most 50 variables, values of at most 4096 characters, and names a shell can export, other than those the Container sets itself (PATH, HOME, GITHUB_TOKEN, CLOUDPID_…).",
      `With id "${GLOBAL_ID}" the variable is kept Global, for a value that is shared and not secret (an email, a URL); an Environment's own variable of the same name wins, and the 50 counts an Environment's own and the ones it inherits together, so a call that would leave any Environment with more is refused. Each Environment's Build is made with it, so a new Build is asked for in each Environment that does not override it.`,
      PLAIN_VALUES,
      "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
    ]),
    input: Schema.Struct({
      id: idOrGlobal("a variable kept Global"),
      name: VariableName,
      value: Value,
      reason: Reason,
    }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Set one of an Environment's variables (the one id names): every command on its Workspaces' Containers, their Setup and Start Scripts and the Environment's Build get it. The same rules as the owner's Edit dialog: at most 50 variables, values of at most 4096 characters, and names a shell can export, other than those the Container sets itself (PATH, HOME, GITHUB_TOKEN, CLOUDPID_…).",
      `With id "${GLOBAL_ID}" the variable is kept Global, for a value that is shared and not secret (an email, a URL); an Environment's own variable of the same name wins, and the 50 counts an Environment's own and the ones it inherits together, so a call that would leave any Environment with more is refused. Each Environment's Build is made with it, so a new Build is asked for in each Environment that does not override it.`,
      PLAIN_VALUES_ENDPOINT,
      "The change is recorded with your reason, and the owner can see and revert it on the Environments page. It applies at each Workspace's next Container start: a Container that runs keeps what it started with.",
    ]),
    input: Schema.Struct({
      id: idOrGlobal("a variable kept Global", "endpoint"),
      name: VariableName,
      value: Value,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

export const environmentVariableUnset = {
  name: "environment_variable_unset",
  annotations: DESTRUCTIVE_IDEMPOTENT,
  session: {
    description: `Unset one of an Environment's variables (the one id names; id "${GLOBAL_ID}" is a variable kept Global, which no Environment inherits any more, and a new Build is asked for in each that did). The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now. A variable that is not set is left as it is, and nothing is recorded.`,
    input: Schema.Struct({
      id: idOrGlobal("a variable kept Global"),
      name: VariableName,
      reason: Reason,
    }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: `Unset one of an Environment's variables (the one id names; id "${GLOBAL_ID}" is a variable kept Global, which no Environment inherits any more, and a new Build is asked for in each that did). The change is recorded with your reason, and the owner can see and revert it on the Environments page. It applies at each Workspace's next Container start: a Container that runs keeps what it started with. A variable that is not set is left as it is, and nothing is recorded.`,
    input: Schema.Struct({
      id: idOrGlobal("a variable kept Global", "endpoint"),
      name: VariableName,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

export const environmentContainerResize = {
  name: "environment_container_resize",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Set the Container size of an Environment (the one id names): the size the next Container of every one of its Workspaces starts on, and the size they keep after each idle stop.",
      `Sizes, by memory, then vCPU:\n${SIZE_LINES}`,
      "Memory is what a running Container costs, so a larger size costs more for every Workspace of the Environment. The Environment's size limit bounds the size: a larger one is refused, and the limit is a Limit that only the user can raise, with environment_container_size_limit_set, which asks for their Approval.",
      "This changes the Environment, not a Container that runs: it keeps the size it started on, and a size container_resize gave it holds there until its idle stop. To restart only this Workspace's current Container at another size, for more memory now, use container_resize, which changes no Environment.",
      RECORDED,
    ]),
    input: Schema.Struct({ id: SettingId, size: Size, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Set the Container size of an Environment (the one id names): the size the next Container of every one of its Workspaces starts on, and the size they keep after each idle stop.",
      `Sizes, by memory, then vCPU:\n${SIZE_LINES}`,
      "Memory is what a running Container costs, so a larger size costs more for every Workspace of the Environment. The Environment's size limit bounds the size: a larger one is refused, and the limit is a Limit that only the owner raises (environment_get shows it).",
      "This changes the Environment, not a Container that runs: it keeps the size it started on until its idle stop.",
      RECORDED_ENDPOINT,
    ]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      size: Size,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

export const environmentIdleTimeSet = {
  name: "environment_idle_time_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      `Set an Environment's idle time (the one id names): the minutes a Container may sit without a command before its Workspace stops it, from 1 to ${MAX_IDLE_MINUTES}. A disk snapshot is taken first, so the next command starts a new Container from it in several seconds.`,
      "A Container is billed for its memory for as long as it runs, idle or not, so a long idle time costs more; a short one stops a Container between a few minutes of thought and work. The result names the cost at the Environment's size.",
      RECORDED,
    ]),
    input: Schema.Struct({ id: SettingId, minutes: Minutes, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      `Set an Environment's idle time (the one id names): the minutes a Container may sit without a command before its Workspace stops it, from 1 to ${MAX_IDLE_MINUTES}. A disk snapshot is taken first, so the next command starts a new Container from it in several seconds.`,
      "A Container is billed for its memory for as long as it runs, idle or not, so a long idle time costs more; a short one stops a Container between a few minutes of thought and work. The result names the cost at the Environment's size.",
      RECORDED_ENDPOINT,
    ]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      minutes: Minutes,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Setup Script's description says of it, on either surface. */
const SETUP_SCRIPT_LINES = [
  `Set an Environment's own Setup Script (the one id names): the whole bash text, at most ${MAX_SCRIPT_BYTES / 1024} KiB of UTF-8; an empty script removes it. It prepares what the Environment's Workspaces need whatever their Repos (system packages, a Docker image), in /workspace.`,
  "It runs once per content on each Container (when the content changes, or on a Container started from the image; one restored from a snapshot has run it already), before the Repos' own Setup Scripts, and in the Environment's Build. A Setup Script is part of what a Build is made with, so a changed one makes a new Build. It gets the Environment's variables and the Secrets marked for the Build, runs for 15 minutes at most, and a failure stops no command. Nothing validates the bash before it runs.",
  "A step that belongs to one Repo (installing its dependencies) is usually better in that Repo's own .cloudpid/setup.sh, which is committed with the code; use this one for what is the Environment's.",
];

export const environmentSetupScriptSet = {
  name: "environment_setup_script_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([...SETUP_SCRIPT_LINES, STORED_AS_WRITTEN, RECORDED]),
    input: Schema.Struct({ id: SettingId, script: Script, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([...SETUP_SCRIPT_LINES, STORED_AS_WRITTEN_ENDPOINT, RECORDED_ENDPOINT]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      script: Script,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Start Script's description says of it, on either surface. */
const START_SCRIPT_LINES = [
  `Set an Environment's own Start Script (the one id names): the whole bash text, at most ${MAX_SCRIPT_BYTES / 1024} KiB of UTF-8; an empty script removes it. It brings up what a snapshot cannot hold, such as a database or docker compose up, in /workspace.`,
  "It runs at every Container start (a restored Container too), after the Setup Scripts and before the Repos' own Start Scripts, for 5 minutes at most; a failure stops no command. A service it starts must detach, or the script never ends: setsid nohup cmd >/tmp/cmd.log 2>&1 &. It may run again on a Container that already runs, so it should leave a service that is up alone. A Start Script is not part of the Build.",
  "A step that belongs to one Repo is usually better in that Repo's own .cloudpid/start.sh, which is committed with the code; use this one for what is the Environment's.",
];

export const environmentStartScriptSet = {
  name: "environment_start_script_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([...START_SCRIPT_LINES, STORED_AS_WRITTEN, RECORDED]),
    input: Schema.Struct({ id: SettingId, script: Script, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([...START_SCRIPT_LINES, STORED_AS_WRITTEN_ENDPOINT, RECORDED_ENDPOINT]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      script: Script,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Toolchains' description says of them, on either surface. */
const TOOLCHAINS_LINES = [
  `Set an Environment's Toolchains (the one id names): the text of a mise.toml, at most ${MAX_TOOLCHAINS_BYTES / 1024} KiB of UTF-8 with no NUL; empty means the image's base Toolchains. mise reads it, not the save: a bad one fails the install at the next Container start.`,
  "The bootstrap writes it as /workspace/mise.toml where a Workspace has none or still has the copy it wrote last, and installs from it; a Workspace whose own mise.toml was changed keeps that one. Toolchains are part of what a Build is made with, so a changed text makes a new Build.",
];

export const environmentToolchainsSet = {
  name: "environment_toolchains_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([...TOOLCHAINS_LINES, STORED_AS_WRITTEN, RECORDED]),
    input: Schema.Struct({ id: SettingId, mise_toml: MiseToml, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([...TOOLCHAINS_LINES, STORED_AS_WRITTEN_ENDPOINT, RECORDED_ENDPOINT]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      mise_toml: MiseToml,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Container-only paths' description says of them, on either surface: `who` saves them in the app. */
const ignoreLines = (who: "user" | "owner") => [
  `Set an Environment's extra Container-only paths (the one id names): the full list, replacing the one there is, of at most ${MAX_IGNORE_PATTERNS} patterns. A path matching one lives on the Container's disk only: it is not synced to the Workspace, so it is fast and kept out of its storage, and it is gone when the Workspace's Container is restarted fresh. The built-in list already covers node_modules, .venv, caches and build tools' output directories.`,
  `A pattern starts with "/" (from /workspace: "/data" is /workspace/data) or "**/" (at any depth), may start with "!" to keep a path synced again, and has only "*" and "**" (a whole segment) as wildcards. The last pattern that matches a path wins. A bad pattern is refused as the ${who}'s save refuses it.`,
  "A changed list means the next Container of each Workspace starts without the Workspace's snapshot (a snapshot is tied to the list its Container launched with): from the Environment's Build once there is one for the new list, else from the image, so dependency directories, build output and caches are made again and the Setup Scripts run again, which takes minutes.",
];

export const environmentIgnoreSet = {
  name: "environment_ignore_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      ...ignoreLines("user"),
      "The patterns are stored as written: a Secret this Session holds, or a GitHub token, in one is refused.",
      RECORDED,
    ]),
    input: Schema.Struct({ id: SettingId, patterns: Patterns, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      ...ignoreLines("owner"),
      "The patterns are stored as written: a kept Secret's value, or a GitHub token, in one is refused.",
      RECORDED_ENDPOINT,
    ]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      patterns: Patterns,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Spare Workspace's description says of it, on either surface. */
const SPARE_LINES = [
  "Turn an Environment's Spare Workspace on or off (the one id names). On (the default), the Environment keeps one Workspace made ahead from its last good Build while it had a Session in the last 3 days: cloned, its Setup Scripts run, its Container snapshotted and stopped, so a new Session takes it and starts without waiting for the clones and the Setup Scripts. Each spare prepared runs a Container for a minute or two and keeps a Snapshot, after every Session that takes one and every new Build.",
  "Off: no spare is prepared, the one there is is removed with its Snapshot, and a new Session's Workspace is made when the Session starts, waiting for the clones and the Setup Scripts as the first Workspace after a Build does. Off saves that Container time for an Environment whose new Sessions can wait; on suits one whose new Sessions should start fast.",
];

export const environmentSpareWorkspaceSet = {
  name: "environment_spare_workspace_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      ...SPARE_LINES,
      `With id "${GLOBAL_ID}" the setting is changed at Global: every Environment that does not override it inherits it. Setting an Environment's value makes it the Environment's own, which a later change at Global does not reach; environment_setting_reset makes it inherit Global's again.`,
      "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at once: no Container restarts, and no new Build is made.",
    ]),
    input: Schema.Struct({ id: SettingId, enabled: Enabled, reason: Reason }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      ...SPARE_LINES,
      `With id "${GLOBAL_ID}" the setting is changed at Global: every Environment that does not override it inherits it. Setting an Environment's value makes it the Environment's own, which a later change at Global does not reach.`,
      "The change is recorded with your reason, and the owner can see and revert it on the Environments page. It applies at once: no Container restarts, and no new Build is made.",
    ]),
    input: Schema.Struct({
      id: SettingIdEndpoint,
      enabled: Enabled,
      reason: ReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentChangeEndpointOutput,
  },
} as const;

/** What the Build mark's description says of it, on either surface. */
const SECRET_BUILD_REACH =
  "A Secret marked for the Build reaches every Setup Script of the Environment as $PI_SECRET_<NAME>: the Environment's own and each Repo's .cloudpid/setup.sh, in the Environment's Build and in the Setup Scripts of each Workspace's Container. A script can print it or write it to a file, so mark only a Secret a Setup Script needs (a private registry token); an unmarked one reaches only commands and Sessions. A Secret marked for the Build is part of the Build's key, so changing the mark can make a new Build.";

export const environmentSecretBuild = {
  name: "environment_secret_build",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      `Mark a Secret kept for an Environment as reaching the Build, or take the mark off (the one id names; id "${GLOBAL_ID}" is a Secret kept Global). Only a Secret the user kept can be marked: ask for one with secret_ask and keep, and the user chooses in the form whether to keep it.`,
      SECRET_BUILD_REACH,
      "The change is recorded with your reason, the mark before and after (never the value), and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start.",
    ]),
    input: Schema.Struct({
      id: idOrGlobal("a Secret kept Global"),
      name: Name,
      build: Build,
      reason: MarkReason,
    }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      `Mark a Secret kept for an Environment as reaching the Build, or take the mark off (the one id names; id "${GLOBAL_ID}" is a Secret kept Global). Only a Secret the owner kept can be marked: the owner keeps Secrets on the Secrets page, and environment_get lists the names kept (never a value).`,
      SECRET_BUILD_REACH,
      "The change is recorded with your reason, the mark before and after (never the value), and the owner can see and revert it on the Environments page. It applies at each Workspace's next Container start.",
    ]),
    input: Schema.Struct({
      id: idOrGlobal("a Secret kept Global", "endpoint"),
      name: Name,
      build: Build,
      reason: MarkReasonEndpoint,
      ...RequestIdField,
    }),
    output: ChangeEndpointOutput,
  },
} as const;

/** The Container setting tools, in the order the `environment` extension registers them. */
export const CONTAINER_SETTING_TOOLS = {
  environment_variable_set: environmentVariableSet,
  environment_variable_unset: environmentVariableUnset,
  environment_container_resize: environmentContainerResize,
  environment_idle_time_set: environmentIdleTimeSet,
  environment_setup_script_set: environmentSetupScriptSet,
  environment_start_script_set: environmentStartScriptSet,
  environment_toolchains_set: environmentToolchainsSet,
  environment_ignore_set: environmentIgnoreSet,
  environment_spare_workspace_set: environmentSpareWorkspaceSet,
} as const;

export type ContainerSettingToolName = keyof typeof CONTAINER_SETTING_TOOLS;
