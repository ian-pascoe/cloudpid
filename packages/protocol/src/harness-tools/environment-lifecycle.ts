// The tools for an Environment's own record, for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Names and surfaces, The tools): `environment_create`, `environment_rename`, `environment_repo_add`,
// `environment_repo_remove` and `environment_rebuild`. The in-session descriptions, parameters and output schemas stay
// as they were (the snapshot in `packages/extensions/src/harness-session.test.ts` pins them). The endpoint's sentences
// name the owner and no Session, and no tool the endpoint does not serve (a Test Build's tools are a later stage's;
// `environment_delete` asks the owner, `./approvals.ts`); every endpoint input takes `request_id`, and every endpoint output is a flat object. The endpoint
// takes `proposed` of `environment_rebuild` (a Test Build, S4a) so that it is refused as unsupported, never dropped and
// answered with a real Build.
// @effect-diagnostics missingPipeableSignature:off
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  EnvironmentCreateEndpointOutput,
  EnvironmentCreateOutput,
  RebuildEndpointOutput,
  RebuildOutput,
  RecordChangeEndpointOutput,
  RecordChangeOutput,
} from "./lifecycle-output.ts";
import { MAX_CHANGE_REASON, RequestIdField } from "./reason.ts";
import { environmentId } from "./scope.ts";
import { DESTRUCTIVE_IDEMPOTENT, WRITE, WRITE_IDEMPOTENT } from "./surface.ts";

/** A lifecycle tool's `reason`, with the example of why one changes an Environment's record. */
const LifecycleReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the API lives in a second repo'",
});

/** The same `reason` on the endpoint, whose words name the owner. */
const LifecycleReasonEndpoint = LifecycleReason.annotate({
  description:
    "Why you make the change, for the owner to read in the Environment's Agent changes, such as 'the API lives in a second repo'",
});

const RepoSource = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The repo to clone: owner/repo (a GitHub repo) or a plain https URL. Never put a credential in it",
});

const RepoDirectory = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The directory below /workspace the repo is cloned into (default: the repo's own name): letters, digits, dots, underscores and dashes, starting with a letter or digit",
});

const NewName = Schema.String.annotate({ description: "The new name" });

const RepoName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The repo's directory name below /workspace, as environment_get shows it",
});

/** The paragraphs of a description, as the in-session tools join them. */
const paragraphs = (lines: ReadonlyArray<string>): string => Arr.join(lines, "\n\n");

const CreateName = Schema.String.annotate({
  description: "The Environment's name, such as 'Billing API'",
});

export const environmentCreate = {
  name: "environment_create",
  annotations: WRITE,
  session: {
    description: paragraphs([
      "Make an Environment with a name and Repos, and the default Container settings: the same name rules as the user's (1 to 80 characters, free among the Environments whatever the case). Its Repos are given as owner/repo or plain https URLs, each cloned into a directory of its own below /workspace by the Workspaces made from it. A spare Workspace and a Build are made for it as for one the user makes.",
      "It answers the new Environment's id. The new Environment is not this Session's: this Session stays in its own Workspace, and you cannot start a Session in another Environment. Set it up by passing its id as id to the other environment_* tools; the user starts a Session in it from the Environments page.",
      "The change is recorded with your reason, and the user can see it on the Environments page. Making an Environment cannot be reverted, since deleting one needs the user's approval.",
    ]),
    input: Schema.Struct({
      name: CreateName,
      repos: RepoSource.pipe(Schema.Array, Schema.optionalKey),
      reason: LifecycleReason,
    }),
    output: EnvironmentCreateOutput,
  },
  endpoint: {
    description: paragraphs([
      "Make an Environment with a name and Repos, and the default Container settings: the same name rules as the owner's (1 to 80 characters, free among the Environments whatever the case). Its Repos are given as owner/repo or plain https URLs, each cloned into a directory of its own below /workspace by the Workspaces made from it. A spare Workspace and a Build are made for it as for one the owner makes.",
      "It answers the new Environment's id (the answer's scope): start a Session in it with session_start and this id, and set it up by passing the id as id to the tools that change an Environment's settings. A repeat with the same request_id does not make a second Environment.",
      "The change is recorded with your reason, and the owner can see it on the Environments page. Making an Environment cannot be reverted, since deleting one needs the owner's approval.",
    ]),
    input: Schema.Struct({
      name: CreateName,
      repos: RepoSource.pipe(Schema.Array, Schema.optionalKey),
      reason: LifecycleReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentCreateEndpointOutput,
  },
} as const;

export const environmentRename = {
  name: "environment_rename",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description:
      "Rename an Environment (the one id names): the same name rules as the user's (1 to 80 characters, free among the Environments whatever the case). Its id never changes. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
    input: Schema.Struct({
      id: environmentId(),
      name: NewName,
      reason: LifecycleReason,
    }),
    output: RecordChangeOutput,
  },
  endpoint: {
    description:
      "Rename an Environment (the one id names): the same name rules as the owner's (1 to 80 characters, free among the Environments whatever the case). Its id never changes. The change is recorded with your reason, and the owner can see and revert it on the Environments page.",
    input: Schema.Struct({
      id: environmentId("endpoint"),
      name: NewName,
      reason: LifecycleReasonEndpoint,
      ...RequestIdField,
    }),
    output: RecordChangeEndpointOutput,
  },
} as const;

export const environmentRepoAdd = {
  name: "environment_repo_add",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Add a Repo to an Environment (the one id names), for the Workspaces made from then on: the same rules as the user's. It is cloned into /workspace/<name> by a Workspace's first use. The Environment's spare Workspace is made again, and its Build is made with the Repo.",
      "Only the Environment's record and its spare Workspace change: no Workspace a Session has gets the clone, this Session's included. A new Workspace gets it. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
    ]),
    input: Schema.Struct({
      id: environmentId(),
      url: RepoSource,
      name: Schema.optionalKey(RepoDirectory),
      reason: LifecycleReason,
    }),
    output: RecordChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Add a Repo to an Environment (the one id names), for the Workspaces made from then on: the same rules as the owner's. It is cloned into /workspace/<name> by a Workspace's first use. The Environment's spare Workspace is made again, its Build is made with the Repo, and its MCP servers are looked at again, as after the owner's own add.",
      "Only the Environment's record and its spare Workspace change: no Workspace that has started a Session gets the clone. A new Workspace gets it. The change is recorded with your reason, and the owner can see and revert it on the Environments page.",
    ]),
    input: Schema.Struct({
      id: environmentId("endpoint"),
      url: RepoSource,
      name: Schema.optionalKey(RepoDirectory),
      reason: LifecycleReasonEndpoint,
      ...RequestIdField,
    }),
    output: RecordChangeEndpointOutput,
  },
} as const;

export const environmentRepoRemove = {
  name: "environment_repo_remove",
  annotations: DESTRUCTIVE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Take a Repo out of an Environment (the one id names), by its directory name as environment_get shows it: the same rules as the user's. The Environment's spare Workspace is made again, and its Build is made without the Repo.",
      "Only the Environment's record and its spare Workspace change: no Workspace a Session has loses its clone, this Session's included. A new Workspace does not get one. The change is recorded with your reason, and the user can see and revert it on the Environments page.",
    ]),
    input: Schema.Struct({
      id: environmentId(),
      name: RepoName,
      reason: LifecycleReason,
    }),
    output: RecordChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Take a Repo out of an Environment (the one id names), by its directory name as environment_get shows it: the same rules as the owner's. The Environment's spare Workspace is made again, its Build is made without the Repo, and its MCP servers are looked at again, as after the owner's own removal.",
      "Only the Environment's record and its spare Workspace change: no Workspace that has started a Session loses its clone. A new Workspace does not get one. The change is recorded with your reason, and the owner can see and revert it on the Environments page.",
    ]),
    input: Schema.Struct({
      id: environmentId("endpoint"),
      name: RepoName,
      reason: LifecycleReasonEndpoint,
      ...RequestIdField,
    }),
    output: RecordChangeEndpointOutput,
  },
} as const;

/** What `environment_rebuild`'s `proposed` replaces: a Test Build's whole fields, each replacing the saved one. */
const Proposed = Schema.Struct({
  repos: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ url: RepoSource, name: Schema.optionalKey(RepoDirectory) }),
    ).annotate({
      description:
        "The whole list of Repos, replacing the Environment's: each as environment_repo_add takes one",
    }),
  ),
  variables: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description:
        "The whole map of the Environment's own variables (NAME to value), replacing them; plain, under the same rules as environment_variable_set. The variables kept Global still apply under it, and the 50 counts both",
    }),
  ),
  setup_script: Schema.optionalKey(
    Schema.String.annotate({
      description: "The Environment's whole Setup Script (bash); empty: none",
    }),
  ),
  toolchains: Schema.optionalKey(
    Schema.String.annotate({
      description: "The whole mise.toml of the Toolchains; empty: the image's base Toolchains",
    }),
  ),
  ignore: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "The whole list of extra Container-only paths",
    }),
  ),
}).annotate({
  description:
    "Make a Test Build of these proposed changes instead of a Build of the saved settings: each field given replaces the saved one whole, the others stay as saved. Nothing is saved.",
});

/** The endpoint's `proposed`: read, so that a call that passes it is refused as unsupported (S4a serves Test Builds). */
const ProposedEndpoint = Schema.Unknown.annotate({
  description:
    "Not offered yet: a Test Build of proposed changes is refused as unsupported. Leave it out to ask for a Build of the saved settings.",
});

export const environmentRebuild = {
  name: "environment_rebuild",
  annotations: WRITE,
  session: {
    description: paragraphs([
      "Ask for a new Build of an Environment now (the one id names), as the user's Rebuild does: its Repos cloned and its Toolchains and Setup Script run on a fresh Container, then snapshotted, for the Workspaces made from then on to start from. A Build already under way for the same Repos and settings is left to finish. An Environment with no Repos, no Setup Script and no Toolchains has nothing to build.",
      "Without proposed it answers at once, with the Build under way: environment_get shows how it goes and, when it fails, the end of its reason. The request is recorded with your reason. It cannot be reverted.",
      "With proposed it makes a Test Build instead, to check a change before saving it: a Build of the Environment's saved Repos and settings with the proposed fields replaced (repos, the full list; variables, the full map; setup_script; toolchains; ignore), made as a Build is, on a Container of its own. The same rules and Secret refusal as the saving tools apply. Nothing is saved or recorded, no Workspace starts from it, and a Build under way goes on beside it. The call waits until it ends, which can take many minutes, then answers the time it took, or the failing step with the end of its output. If it succeeded, save the fields with the setting tools. One Test Build runs per Environment at a time; Stop cancels it.",
    ]),
    input: Schema.Struct({
      id: environmentId(),
      reason: LifecycleReason,
      proposed: Schema.optionalKey(Proposed),
    }),
    output: RebuildOutput,
  },
  endpoint: {
    description: paragraphs([
      "Ask for a new Build of an Environment now (the one id names), as the owner's Rebuild does: its Repos cloned and its Toolchains and Setup Script run on a fresh Container, then snapshotted, for the Workspaces made from then on to start from. A Build already under way for the same Repos and settings is left to finish, and nothing is asked for or recorded. An Environment with no Repos, no Setup Script and no Toolchains has nothing to build.",
      "It answers at once, with the Build under way: environment_get shows how it goes and, when it fails, the end of its reason. The request is recorded with your reason. It cannot be reverted. A repeat with the same request_id asks for no second Build.",
    ]),
    input: Schema.Struct({
      id: environmentId("endpoint"),
      reason: LifecycleReasonEndpoint,
      proposed: Schema.optionalKey(ProposedEndpoint),
      ...RequestIdField,
    }),
    output: RebuildEndpointOutput,
  },
} as const;
