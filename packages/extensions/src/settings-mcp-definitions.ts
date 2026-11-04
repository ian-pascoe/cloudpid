// The `settings_mcp` tools that change an MCP server definition, which always wait for the owner's Approval:
// `settings_mcp_add` (an `entry`, or a copy of a Repo's server with `from_repo`), `settings_mcp_update` and
// `settings_mcp_remove`, which waits only when it falls back to a switched-on or un-hidden server
// (`docs/architecture/mcp-configuration.md` → The agent's changes → The tools, Scopes and layers, Approval, Copying a Repo's
// server; `docs/architecture/agent-changes.md` → MCP server changes, Approval).
//
// Each refuses before asking, in the order of the design (the #391 D16): parameters that fail to decode; a reason that
// holds a Secret; an unknown scope (and `from_repo` at `*`); the name and the layers; the plain-value check of every text; the
// credential-shaped literals; the strict decode of the entry that would result, which also holds the bounds; a 51st server;
// "already so"; an unknown `${NAME}` at an Environment; and then widening decides whether to ask. The card's notes say what
// the server runs or connects to, what it sends and where, whom it reaches, what it replaces, its sign-in, its prompt and
// its model use. The change is one field, `mcp.servers.<name>`, with `expected` the entry in force and `after` the entry kept.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off globalDate:off
import {
  decodeMcpServerValue,
  isJsonObject,
  isMcpFullEntry,
  MCP_LIMITS,
  MCP_NAME,
  type McpServerValue,
  normalizeMcpName,
  overrideInherited,
  settingsFieldValue,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  readMcpRepoFileState,
  type SettingsMcpRepo,
  type SettingsMcpServer,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChangeOutput, outputSchema } from "./outputs.ts";
import {
  environmentWords,
  type McpCall,
  McpCommit,
  NOTHING,
  refuse,
} from "./settings-mcp-commit.ts";
import {
  copiedEntry,
  credentialLiterals,
  entryJson,
  entryReferences,
  entryTexts,
  entryWithSet,
  setProblem,
  textOf,
} from "./settings-mcp-entry.ts";
import { McpChangeOutput } from "./settings-mcp-outputs.ts";
import { Reason, ServerName, unchanged } from "./settings-mcp-changes.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  isGlobalView,
  type SettingsFieldChange,
  SettingsScope,
  type SettingsView,
} from "./settings.ts";

const ASKED = "Nothing was asked or saved: ";

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** The field of a whole entry. */
const entryField = (name: string) => `mcp.servers.${name}`;

/** What an entry runs or connects to, as a line says it. */
const targetWords = (entry: Schema.JsonObject): string =>
  Predicate.isString(entry.command)
    ? `a stdio server running ${Arr.join(
        [entry.command, ...(Array.isArray(entry.args) ? entry.args.map(textOf) : [])],
        " ",
      )}`
    : `a Streamable HTTP server at ${textOf(entry.url)}`;

/** `text`, cut to `max` characters. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** How long ago `then` was, for a note. */
const ageWords = (now: number, then: number | undefined): string => {
  if (then === undefined) return "read at an unknown time";

  const minutes = Math.max(0, Math.round((now - then) / 60_000));

  if (minutes < 60) return `read ${minutes} min ago`;

  if (minutes < 60 * 48) return `read ${Math.round(minutes / 60)} h ago`;

  return `read ${Math.round(minutes / 1440)} days ago`;
};

/**
 * Why `name` is no name for a server, or undefined: not `^[A-Za-z0-9_-]+$` or over 64 characters. The refusal never
 * repeats what it was given beyond the name's length.
 */
const nameProblem = (name: string): string | undefined =>
  name.length > MCP_LIMITS.name || !MCP_NAME.test(name)
    ? `${JSON.stringify(cut(name, 40))} is not a server name: use letters, digits, - and _, at most ${MCP_LIMITS.name} characters`
    : undefined;

/** The same wording for what each `${NAME}` is, for the card. */
const KIND_WORDS = {
  secret: "Secret",
  variable: "Variable (plain: the agent can change it)",
  missing: "missing",
} as const;

const kindWords = (kind: "secret" | "variable" | "missing"): string => KIND_WORDS[kind];

/** Where the server in force now comes from, for the line that says a removal fell back to it. */
const sourceWords = (source: SettingsMcpServer["server"]["source"]): string => {
  if (source.kind === "global") return "Global's";

  return source.kind === "repo" ? `the Repo's (${source.directory})` : "the Environment's";
};

/** The tools' ending of a refusal about a `${NAME}` that resolves to nothing (#391 D5.4). */
const missingWords = (
  names: ReadonlyArray<string>,
  scope: { readonly id: string; readonly name: string },
  own: string | null,
): string =>
  `Nothing was asked or saved: ${Arr.join(
    Arr.map(names, (name) => "${" + name + "}"),
    ", ",
  )} is neither a Secret nor a Variable of Environment ${JSON.stringify(scope.name)} (${scope.id}) or of Global. ${
    scope.id === own
      ? 'Keep it first: secret_ask with keep: "environment" keeps a Secret in this Environment and keep: "all" at Global'
      : "Ask the user to keep it in that Environment's Secrets section (or at Global)"
  }; for a value that is not secret, environment_variable_set keeps a Variable. Then add the server.`;

/** The entry of a server as the Scope keeps it now: Global's at `*`, the Environment's own at an Environment; null for none. */
const storedEntry = (view: SettingsView, name: string): Schema.Json | null =>
  settingsFieldValue(view.settings, entryField(name));

/** The strict decode of the entry that would result, as the owner's save decodes it: its problems, one a line, or the entry. */
const strict = (entry: Schema.JsonObject) => {
  const decoded = decodeMcpServerValue(entry, "settings");

  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(
        Arr.join(
          Arr.map(decoded.failure, (problem) => problem.line),
          "\n",
        ),
      );
};

/** The same-layer servers of a Scope's set: Global's at `*`, the Environment's own at an Environment. */
const ownLayer = (view: SettingsView, servers: ReadonlyArray<SettingsMcpServer>) =>
  Arr.filter(
    servers,
    (each) => each.server.source.kind === (isGlobalView(view) ? "global" : "environment"),
  );

type Reads = ReadonlyArray<{
  readonly name: string;
  readonly kind: "secret" | "variable" | "missing";
}>;

/** The lines of the card's `Sends` note: each `${NAME}` as a Secret or a Variable, where it goes, and where it is missing. */
const sendsNotes = (
  entry: McpServerValue,
  reach: ReadonlyArray<{
    readonly environment: { readonly name: string };
    readonly reads?: Reads | undefined;
  }>,
  atGlobal: boolean,
): ReadonlyArray<string> => {
  const references = entryReferences(entry);

  if (references.length === 0)
    return ["Sends: no ${NAME} value: it sends only what is written in the entry."];

  const names = Arr.dedupe(Arr.map(references, ({ name }) => name));

  const parts = Arr.map(names, (name) => {
    const where = Arr.join(
      Arr.map(
        Arr.filter(references, (each) => each.name === name),
        (each) => each.where,
      ),
      ", ",
    );

    const kinds = Arr.filterMap(reach, ({ environment, reads }) => {
      const found = Arr.findFirst(reads ?? [], (read) => read.name === name);

      return Option.isSome(found)
        ? Result.succeed({ environment: environment.name, kind: found.value.kind })
        : Result.failVoid;
    });

    const first = Arr.head(kinds);
    const missing = Arr.filter(kinds, (each) => each.kind === "missing");

    const what = atGlobal
      ? Arr.some(kinds, (each) => each.kind === "secret")
        ? "Secret"
        : Arr.some(kinds, (each) => each.kind === "variable")
          ? kindWords("variable")
          : "unknown"
      : Option.isSome(first)
        ? kindWords(first.value.kind)
        : "unknown";

    return `\${${name}} (${what}) in ${where}${
      atGlobal && missing.length > 0
        ? `; missing in ${Arr.join(
            Arr.map(missing, (each) => JSON.stringify(each.environment)),
            ", ",
          )}`
        : ""
    }`;
  });

  return [
    `Sends: ${Arr.join(Arr.take(parts, 3), "; ")}${
      parts.length > 3 ? "; and more" : ""
    }. The host sends them, never the Container.`,
  ];
};

/** What the owner's MCP sign-in has to do with the server, for the card. */
const signInNote = (entry: McpServerValue, was: SettingsMcpServer | undefined): string => {
  if (entry.command !== undefined) return "Sign-in: none (a stdio server has no MCP sign-in).";

  if (
    was !== undefined &&
    was.signIn !== null &&
    was.server.server.type === "http" &&
    was.server.server.url === entry.url
  ) {
    return "Sign-in: keeps using your MCP sign-in for this server and URL.";
  }

  return entry.oauth === undefined
    ? "Sign-in: needs its own MCP sign-in only if the server asks for one: you sign in separately (never the agent)."
    : "Sign-in: needs its own MCP sign-in with the oauth settings written here: you sign in separately (never the agent).";
};

/** The tools of the definition tools, over the shared ending of the changing tools. */
export const McpDefinitions = Effect.gen(function* () {
  const engine = yield* McpCommit;
  const { access, settings } = engine;

  const environmentName = (view: SettingsView): string =>
    isGlobalView(view) ? "Global" : `Environment ${JSON.stringify(view.name)}`;

  const where = (view: SettingsView): string =>
    isGlobalView(view)
      ? "at Global"
      : `for Environment ${JSON.stringify(view.name)} (${view.scope})`;

  /** The refusals that apply to the entry an add or an update would keep, in order, up to the check of the `${NAME}`s. */
  const entryChecks = (input: {
    readonly view: SettingsView;
    readonly reason: string;
    readonly entry: Schema.JsonObject;
    readonly base: Schema.JsonObject | undefined;
    /** The keys of the entry that are given, for the plain-value check of what an update keeps. */
    readonly texts: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      yield* engine
        .plain(input.reason, input.texts)
        .pipe(
          Effect.mapError((error) =>
            refuse(error.message.replace("Nothing was saved:", "Nothing was asked or saved:")),
          ),
        );

      const literals = credentialLiterals(input.entry, input.base);

      if (literals.length > 0) {
        return yield* refuse(
          `${ASKED}${Arr.join(literals, ", ")} holds a credential written out. Keep the value as a Secret (secret_ask) and write \${NAME} in its place: the host sends the Secret, and the entry holds only its name.`,
        );
      }

      const decoded = strict(input.entry);

      if (Result.isFailure(decoded)) {
        return yield* refuse(`${ASKED}the entry is not one the Settings take:\n${decoded.failure}`);
      }

      return decoded.success;
    });

  /** The check of the `${NAME}`s of an entry at an Environment (a refusal), or at `*` (the card says where they are missing). */
  const checkReads = (
    view: SettingsView,
    name: string,
    field: SettingsFieldChange,
    entry: McpServerValue,
  ) =>
    Effect.gen(function* () {
      const reads = Arr.dedupe(Arr.map(entryReferences(entry), (each) => each.name));

      const check = yield* access.check({
        scope: view.scope,
        name,
        changes: [{ field: field.field, value: field.value }],
        reads,
      });

      if (!isGlobalView(view)) {
        const here = Arr.head(check.environments);

        const missing = Option.isSome(here)
          ? Arr.map(
              Arr.filter(here.value.reads ?? [], (read) => read.kind === "missing"),
              (read) => read.name,
            )
          : [];

        if (missing.length > 0) {
          const own = yield* access.own.pipe(Effect.orElseSucceed(() => null));

          return yield* refuse(missingWords(missing, { id: view.scope, name: view.name }, own));
        }
      }

      return check;
    });

  /** Whole-entry change of `name`: asked, applied and worded. */
  const entryChange = (input: {
    readonly tool: string;
    readonly api: McpCall;
    readonly view: SettingsView;
    readonly name: string;
    readonly after: Schema.Json | null;
    readonly entry: McpServerValue | undefined;
    readonly was: SettingsMcpServer | undefined;
    readonly reason: string;
    readonly card: string;
    readonly lead: string;
    readonly notes: ReadonlyArray<string>;
    readonly extra: ReadonlyArray<string>;
    readonly status: boolean;
    readonly checked?: Effect.Effect<Effect.Success<ReturnType<typeof access.check>>, never>;
  }) =>
    Effect.gen(function* () {
      const field = entryField(input.name);
      const stored = storedEntry(input.view, input.name);

      const change: SettingsFieldChange =
        input.after === null
          ? { field, value: null, reset: true, expected: expectedOf(input.view, field, stored) }
          : { field, value: input.after, expected: expectedOf(input.view, field, stored) };

      const check =
        input.entry === undefined
          ? yield* access.check({
              scope: input.view.scope,
              name: input.name,
              changes: [
                input.after === null
                  ? { field, value: null, reset: true }
                  : { field, value: input.after },
              ],
            })
          : yield* checkReads(input.view, input.name, change, input.entry);

      const reached = yield* engine.reachNotes({
        scope: input.view.scope,
        name: input.name,
        check,
        view: undefined,
      });

      const reach = Arr.take(reached, 1);

      const sends =
        input.entry === undefined
          ? []
          : sendsNotes(input.entry, check.environments, isGlobalView(input.view));

      return {
        kind: "commit",
        input: {
          tool: input.tool,
          api: input.api,
          scope: input.view.scope,
          view: input.view,
          name: input.name,
          field: change,
          check,
          reason: input.reason,
          texts: [],
          always: input.after !== null,
          rerun: false,
          card: {
            change: `MCP server ${JSON.stringify(input.name)}: ${input.card}`,
            before: stored,
            notes: [...input.notes.slice(0, 1), ...sends, ...reach, ...input.notes.slice(1)],
          },
          was: input.was,
          wording: (now: SettingsMcpServer | undefined) => [
            input.lead,
            input.after === null
              ? `- MCP server ${input.name}: removed${
                  now === undefined
                    ? ""
                    : `; the server in force ${where(input.view)} is ${sourceWords(now.server.source)} now`
                }.`
              : `- MCP server ${input.name}: ${stored === null ? "added" : "edited"} as ${isJsonObject(input.after) ? targetWords(input.after) : "an entry"}.`,
          ],
          extra: input.extra,
          alreadySo: `Nothing changed: MCP server ${input.name} has that entry ${where(input.view)} already.`,
          status: input.status,
          declined: `${input.card} of MCP server ${input.name} ${where(input.view)}`,
        },
      } as const;
    });

  /** What the Scope has for a field now, as an approval's `expected`: the value, and at an Environment whether it is inherited. */
  const expectedOf = (view: SettingsView, field: string, stored: Schema.Json | null) =>
    isGlobalView(view)
      ? { value: stored }
      : { value: stored, inherited: overrideInherited(view.overrides, field) };

  /** The Repo `directory` of Environment `view`'s Repos and the entry it holds for `name`, or why there is none to copy. */
  const repoEntry = (
    view: Effect.Success<ReturnType<typeof access.view>>,
    name: string,
    directory: string,
  ) => {
    const repo: SettingsMcpRepo | undefined = view.repos.find((each) => each.repo === directory);

    if (repo === undefined) {
      return refuse(
        `${ASKED}${environmentWords({ id: view.scope, name: view.name })} has no Repo whose directory is ${JSON.stringify(directory)}${
          view.repos.length === 0
            ? " (it has no Repos)"
            : `: its Repos are ${Arr.join(
                Arr.map(view.repos, (each) => each.repo),
                ", ",
              )}`
        }. from_repo is the Repo's directory name as settings_mcp_list shows it, not owner/repo.`,
      );
    }

    const copyState = readMcpRepoFileState(repo.state);

    if ((copyState !== "read" && copyState !== "unreadable") || repo.blob === undefined) {
      return refuse(
        `${ASKED}no copy of ${directory}'s .pi/mcp.json has been read yet (settings_mcp_list shows its state): settings_mcp_reload reads it, and only a file on the Repo's default branch counts.`,
      );
    }

    const layer = view.layers?.repos.find((each) => each.source.directory === directory);

    if (layer === undefined) {
      return refuse(
        `${ASKED}${directory}'s last good copy of .pi/mcp.json has no server ${JSON.stringify(name)}. Copying never reads GitHub afresh: settings_mcp_reload looks again, and a file changed on a branch counts only once merged.`,
      );
    }

    if (layer.kind === "adjustment" || !isJsonObject(layer.value)) {
      return refuse(
        `${ASKED}${directory}'s entry ${JSON.stringify(name)} is an adjustment, not a server definition, so there is nothing to copy.`,
      );
    }

    return Effect.succeed({ repo, value: layer.value, blob: repo.blob });
  };

  /** `settings_mcp_add`: an `entry`, or a copy of a Repo's server. */
  const add = (input: {
    readonly scope: string;
    readonly name: string;
    readonly entry: Schema.JsonObject | undefined;
    readonly from_repo: string | undefined;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      const tool = "settings_mcp_add";
      const copy = input.from_repo !== undefined;

      // 1. Parameters that fail to decode: exactly one of `entry` and `from_repo`.
      if ((input.entry === undefined) === (input.from_repo === undefined)) {
        return yield* refuse(
          `${ASKED}give exactly one of entry (the server in pi's shape) and from_repo (the directory of a Repo of the Environment, whose server of that name is copied).`,
        );
      }

      // 2. A reason that holds a Secret.
      yield* engine
        .plain(input.reason, [])
        .pipe(
          Effect.mapError((error) =>
            refuse(error.message.replace("Nothing was saved:", "Nothing was asked or saved:")),
          ),
        );

      // 3. An unknown scope, and `from_repo` at `*`.
      if (copy && input.scope === GLOBAL_SETTINGS_SCOPE) {
        return yield* refuse(
          `${ASKED}from_repo is for an Environment's id: Global has no Repos, so the copy's directory would be ambiguous. Copy to an Environment, then add at "*" with an entry whose cwd is explicit.`,
        );
      }

      const rerun = yield* engine.rerun(input.api);
      const field = entryField(input.name);

      return yield* engine.run<never>({
        rerun,
        prepare: Effect.gen(function* () {
          const view = yield* settings.get(input.scope);
          const all = yield* access.view({ scope: input.scope });
          const named = yield* access.view({ scope: input.scope, name: input.name });

          // 4. The name and the layers.
          const problem = nameProblem(input.name);

          if (problem !== undefined) return yield* refuse(`${ASKED}${problem}.`);

          const existing = Option.getOrUndefined(Arr.head(named.servers));
          const same = ownLayer(view, all.servers);

          const twin = Arr.findFirst(
            same,
            (each) =>
              each.server.name !== input.name &&
              normalizeMcpName(each.server.name) === normalizeMcpName(input.name),
          );

          if (Option.isSome(twin)) {
            return yield* refuse(
              `${ASKED}${JSON.stringify(input.name)} clashes with the server ${JSON.stringify(twin.value.server.name)} ${where(view)}: names that differ only in case or in - and _ are one server (a tool is mcp__<name>__<tool>).`,
            );
          }

          if (existing !== undefined && Arr.some(same, (each) => each.server.name === input.name)) {
            return yield* refuse(
              `${ASKED}MCP server ${JSON.stringify(input.name)} is defined ${where(view)} already: settings_mcp_update changes its definition${
                isGlobalView(view) ? "" : ", settings_mcp_remove removes it"
              }.`,
            );
          }

          const adjusted = Arr.findFirst(named.orphans, (each) => each.name === input.name);

          const held =
            existing?.resetFields ??
            (Option.isSome(adjusted)
              ? Arr.map(adjusted.value.keys, (key) => `mcp.servers.${input.name}.${key}`)
              : []);

          if (held.length > 0) {
            return yield* refuse(
              `${ASKED}${environmentName(view)} holds an adjustment of ${JSON.stringify(input.name)} (${Arr.join(held, ", ")}): an Environment holds either its own entry or an adjustment for a name. Remove the adjustment first with settings_reset of each of those fields, then add.`,
            );
          }

          // The entry: given, or copied from the Repo's last good read.
          let candidate: Schema.JsonObject;

          let provenance:
            | { readonly repo: SettingsMcpRepo; readonly cwd: string | null }
            | undefined;

          if (input.entry !== undefined) {
            candidate = input.entry;
          } else {
            const found = yield* repoEntry(named, input.name, input.from_repo ?? "");
            const copied = copiedEntry(found.value, found.repo.repo);

            if ("problem" in copied) {
              return yield* refuse(
                `${ASKED}${input.from_repo}'s entry ${JSON.stringify(input.name)}: ${copied.problem}.`,
              );
            }

            candidate = copied.entry;
            provenance = { repo: found.repo, cwd: copied.cwd };
          }

          if (!isMcpFullEntry(candidate)) {
            return yield* refuse(
              `${ASKED}the entry defines no server: give it a command (stdio) or a url (Streamable HTTP). enabled, exposure and toolExposure alone are an adjustment, which settings_mcp_enable and the exposure tools make.`,
            );
          }

          // 5-7. Plain values, credential literals, the strict decode.
          const decoded = yield* entryChecks({
            view,
            reason: input.reason,
            entry: candidate,
            base: undefined,
            texts: [input.name, ...entryTexts(candidate)],
          }).pipe(
            Effect.mapError((error) =>
              provenance === undefined
                ? error
                : refuse(
                    `${error.message} The Repo's entry cannot be copied as it is: write the server with entry instead, keeping any value as a Secret.`,
                  ),
            ),
          );

          // 8. A 51st server.
          if (same.length >= MCP_LIMITS.servers) {
            return yield* refuse(
              `${ASKED}${environmentName(view)} already has ${MCP_LIMITS.servers} servers of its own, the most a Scope may hold: remove one first.`,
            );
          }

          const replaces = existing?.server.source.kind === "global" && !isGlobalView(view);
          const shadows = existing?.server.source.kind === "repo";
          const lines: Array<string> = [];

          const first =
            candidate.command !== undefined
              ? `Runs: ${Arr.join([textOf(candidate.command), ...(Array.isArray(candidate.args) ? candidate.args.map(textOf) : [])], " ")} in ${
                  Predicate.isString(candidate.cwd) ? candidate.cwd : "the Session's directory"
                }, in each Workspace's Container of the Environments it reaches.`
              : `Connects: from cloudpid (not the Container) to ${textOf(candidate.url)}.`;

          lines.push(first);

          const second: Array<string> = [];

          if (replaces)
            second.push(
              `Replaces Global's ${JSON.stringify(input.name)} in this Environment: its own entry wins here.`,
            );
          else if (shadows && existing !== undefined && existing.server.source.kind === "repo") {
            second.push(
              `Shadows ${existing.server.source.directory}'s ${JSON.stringify(input.name)} (a Repo's file), which stays in the file.`,
            );
          } else if (
            isGlobalView(view) &&
            named.definedIn !== undefined &&
            named.definedIn.length > 0
          ) {
            second.push(
              `Shadows the Repo entries of ${JSON.stringify(input.name)} in ${Arr.join(
                Arr.map(named.definedIn, (each) => JSON.stringify(each.name)),
                ", ",
              )}.`,
            );
          }

          second.push(signInNote(decoded, existing));

          if (decoded.description !== undefined) {
            second.push(
              `Prompt: its description is shown to the model in every conversation of the Environments it reaches.`,
            );
          }

          if (decoded.sampling === "allow") {
            second.push(
              'Model use: sampling "allow" lets the server use your models without asking.',
            );
          }

          if (provenance !== undefined) {
            const now = yield* Clock.currentTimeMillis;

            second.push(
              `Copy: ${provenance.repo.repo}${provenance.repo.slug === undefined ? "" : ` (${provenance.repo.slug})`} ${provenance.repo.path}, commit ${provenance.repo.blob ?? "unknown"}, ${ageWords(now, provenance.repo.readAt)}${
                provenance.cwd === null ? "" : `, cwd made absolute: ${provenance.cwd}`
              }.`,
            );
          }

          const extra: Array<string> = [];

          if (provenance !== undefined) {
            extra.push(
              `The copy is the user's server now: it needs its own MCP sign-in if it asks for one, and it no longer follows ${provenance.repo.repo}'s commits (the Repo's entry shows as shadowed).`,
            );
          }

          if (replaces)
            extra.push("It replaces Global's server of that name for this Environment's Sessions.");

          return yield* entryChange({
            tool,
            api: input.api,
            view,
            name: input.name,
            after: decoded === undefined ? candidate : entryJson(decoded),
            entry: decoded,
            was: existing,
            reason: input.reason,
            card: provenance === undefined ? "add" : `copy from Repo ${provenance.repo.repo}`,
            lead:
              provenance === undefined
                ? `Added MCP server ${input.name} ${where(view)}.`
                : `Copied MCP server ${input.name} from ${provenance.repo.repo} ${where(view)}.`,
            notes: [...lines, ...second],
            extra,
            status: true,
          });
        }),
        resume: engine.resumeOf({
          tool,
          api: input.api,
          scope: input.scope,
          name: input.name,
          field,
          reason: input.reason,
          texts: [],
          status: true,
        }),
      });
    });

  /** `settings_mcp_update`. */
  const update = (input: {
    readonly scope: string;
    readonly name: string;
    readonly set: Schema.JsonObject;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      const tool = "settings_mcp_update";

      yield* engine
        .plain(input.reason, [])
        .pipe(
          Effect.mapError((error) =>
            refuse(error.message.replace("Nothing was saved:", "Nothing was asked or saved:")),
          ),
        );

      const settingProblem = setProblem(input.set);

      if (settingProblem !== undefined) return yield* refuse(`${ASKED}${settingProblem}.`);

      const rerun = yield* engine.rerun(input.api);

      return yield* engine.run<ReturnType<typeof unchanged>>({
        rerun,
        prepare: Effect.gen(function* () {
          const view = yield* settings.get(input.scope);
          const located = yield* definedHere(view, input.name, "update");
          const stored = storedEntry(view, input.name);

          if (!isJsonObject(stored)) {
            return yield* refuse(
              `${NOTHING}MCP server ${JSON.stringify(input.name)} has no entry here to update.`,
            );
          }

          const merged = entryWithSet(stored, input.set);

          if ("problem" in merged) return yield* refuse(`${ASKED}${merged.problem}.`);

          const decoded = yield* entryChecks({
            view,
            reason: input.reason,
            entry: merged.entry,
            base: stored,
            texts: entryTexts(input.set),
          });

          const after = entryJson(decoded);

          if (sameJson(stored, after) && !rerun) {
            return {
              kind: "done",
              result: unchanged(
                view,
                entryField(input.name),
                `MCP server ${input.name} has that definition ${where(view)} already: nothing was asked, changed or recorded.`,
              ),
            } as const;
          }

          const lines: Array<string> = [];
          const storedObject = stored;

          lines.push(
            decoded.command !== undefined
              ? `Runs: ${Arr.join([decoded.command, ...(decoded.args ?? [])], " ")} in ${decoded.cwd ?? "the Session's directory"}, in each Workspace's Container of the Environments it reaches.`
              : `Connects: from cloudpid (not the Container) to ${decoded.url ?? ""}${
                  storedObject.url !== undefined && storedObject.url !== decoded.url
                    ? ` (it was ${textOf(storedObject.url)})`
                    : ""
                }.`,
          );

          const second: Array<string> = [signInNote(decoded, located.server)];

          if (decoded.description !== storedObject.description) {
            second.push(
              "Prompt: the description changes, and it is shown to the model in every conversation of the Environments it reaches.",
            );
          }

          if (decoded.sampling === "allow" && storedObject.sampling !== "allow") {
            second.push(
              'Model use: sampling "allow" lets the server use your models without asking.',
            );
          }

          return yield* entryChange({
            tool,
            api: input.api,
            view,
            name: input.name,
            after,
            entry: decoded,
            was: located.server,
            reason: input.reason,
            card: "edit",
            lead: `Edited the definition of MCP server ${input.name} ${where(view)}. The keys set: ${Arr.join(
              Arr.map(Record.toEntries(input.set), ([key]) => key),
              ", ",
            )}.`,
            notes: [...lines, ...second],
            extra: [],
            status: true,
          });
        }),
        resume: engine.resumeOf({
          tool,
          api: input.api,
          scope: input.scope,
          name: input.name,
          field: entryField(input.name),
          reason: input.reason,
          texts: [],
          status: true,
        }),
      });
    });

  /** The server `name` where it is defined: Global's at `*`, the Environment's own at an Environment; or why it is not (D2). */
  const definedHere = (view: SettingsView, name: string, verb: "update" | "remove") =>
    Effect.gen(function* () {
      const named = yield* access.view({ scope: view.scope, name });
      const found = Arr.head(named.servers);

      if (Option.isNone(found)) {
        const elsewhere = named.definedIn ?? [];

        return yield* refuse(
          elsewhere.length > 0
            ? `${NOTHING}${JSON.stringify(name)} is not one of Global's servers: it is defined in ${Arr.join(Arr.map(elsewhere, environmentWords), ", ")}, so there is nothing to ${verb} at "*". Give the id of one of them as scope, or copy it.`
            : `${NOTHING}No MCP server ${JSON.stringify(name)} ${where(view)}. Its servers: ${named.names.length === 0 ? "none" : Arr.join(named.names, ", ")}.`,
        );
      }

      const kind = found.value.server.source.kind;

      if (isGlobalView(view) ? kind === "global" : kind === "environment") {
        return { view: named, server: found.value };
      }

      if (kind === "global") {
        return yield* refuse(
          verb === "update"
            ? `${NOTHING}${JSON.stringify(name)} is Global's server: settings_mcp_update at "*" changes it for every Environment, and settings_mcp_add here gives this Environment an entry of its own that replaces it.`
            : `${NOTHING}${JSON.stringify(name)} is Global's server, which an Environment cannot delete: settings_mcp_disable switches it off here, and settings_mcp_remove at "*" removes it for every Environment.`,
        );
      }

      const source = found.value.server.source;

      return yield* refuse(
        `${NOTHING}${JSON.stringify(name)} comes from ${source.kind === "repo" ? `${source.directory}'s ${source.path}` : "a Repo"}, which no tool writes: edit that file in a pull request, or copy the server with settings_mcp_add and from_repo to change it here.`,
      );
    });

  /** `settings_mcp_remove`. */
  const remove = (input: {
    readonly scope: string;
    readonly name: string;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      const tool = "settings_mcp_remove";

      yield* engine
        .plain(input.reason, [])
        .pipe(
          Effect.mapError((error) =>
            refuse(error.message.replace("Nothing was saved:", "Nothing was asked or saved:")),
          ),
        );

      const rerun = yield* engine.rerun(input.api);

      return yield* engine.run<never>({
        rerun,
        prepare: Effect.gen(function* () {
          const view = yield* settings.get(input.scope);
          const located = yield* definedHere(view, input.name, "remove");
          const server = located.server;

          const fallback = server.server.replacesGlobal
            ? "It falls back to Global's server of that name for this Environment's Sessions."
            : server.server.shadowed.length > 0
              ? `It un-shadows ${Arr.join(
                  Arr.map(server.server.shadowed, (each) =>
                    each.source.kind === "repo" ? each.source.directory : each.source.kind,
                  ),
                  ", ",
                )}'s entry, which runs again (a Repo's server gets no Secrets).`
              : "Nothing takes its place.";

          return yield* entryChange({
            tool,
            api: input.api,
            view,
            name: input.name,
            after: null,
            entry: undefined,
            was: server,
            reason: input.reason,
            card: "remove",
            lead: `Removed MCP server ${input.name} ${where(view)}. ${fallback}`,
            notes: [`Removes the definition ${where(view)}; ${fallback}`],
            extra: [
              "Its MCP sign-in, if any, stays, listed as unused, until the user signs out on the Settings page; a new server of that name and URL would use it again.",
            ],
            status: false,
          });
        }),
        resume: engine.resumeOf({
          tool,
          api: input.api,
          scope: input.scope,
          name: input.name,
          field: entryField(input.name),
          reason: input.reason,
          texts: [],
          status: false,
        }),
      });
    });

  return { add, update, remove, engine };
});

const NOTE =
  "It always waits for the user's Approval: the call waits for their answer on a card in the Session (and a notification), with no deadline, and a decline changes nothing, the result carrying their reason (do not ask again unless they want it). The card says what the server runs or connects to, which ${NAME} values it sends and where, whom it reaches and what it replaces. A server definition is the user's to approve because it decides which code runs, where Secrets the Session never holds go (a Global entry resolves ${NAME} against each Environment's Secrets, and scope <id> writes into that Environment), what every later call sends, and what the model is told (the description) — not because the Session's own Secrets are at risk. Keep every credential as a Secret and write ${NAME}: a literal in an Authorization, Proxy-Authorization, Cookie, X-API-Key or Api-Key header, or in an env or headers key ending TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, APIKEY, ACCESS_KEY or PRIVATE_KEY, is refused (secret_ask with keep \"environment\" or \"all\" keeps one, environment_variable_set a value that is not secret). At an Environment a ${NAME} must be a Secret or a Variable there or at Global, or it is refused; oauth's clientSecret and privateKey are exactly one ${NAME}. Once made, the result says the server's status, waiting up to 10 s (connected with its tool count, needs sign-in, failed with the error, still connecting), only when the change reaches this Session's Environment; a stdio server is discovered only in this Workspace's Container while it runs ('not discovered: the first call starts the Container'); no other Environment's host is woken ('not checked'). A server that needs sign-in: load mcp_sign_in_ask with tool_search and ask the user. A Repo's .pi/mcp.json is edited as a file in a pull request and is no Agent change.";

/** The three definition tools, over `McpDefinitions`. */
export const McpDefinitionTools = Effect.gen(function* () {
  const definitions = yield* McpDefinitions;

  const add = yield* defineEffectTool({
    name: "settings_mcp_add",
    description: `Add an MCP server at one Scope: at "*" to Global's entries, or at an Environment's id to that Environment's own (which replaces Global's server of the name there, or shadows a Repo's). Give exactly one of entry (the server in pi's shape: command, args, env, cwd, url, headers, oauth, timeout, description, sampling, and optionally enabled, exposure, toolExposure; it must define a server with a command or a url) and from_repo (an Environment's id only: the directory name of a Repo of the Environment, whose server of that name is copied from the last good read of its .pi/mcp.json, with \${NAME} kept and a stdio cwd made absolute, /workspace/<directory>; a copy to Global is two steps: copy to an Environment, then add at "*" with an entry whose cwd is explicit). The copy is the user's server afterwards: it can read Secrets, needs its own MCP sign-in, and no longer follows the Repo's commits. Test a server by hand first, in your Container: run its command, the MCP Inspector's CLI, or curl an initialize with a held Secret's placeholder. ${NOTE}`,
    parameters: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      entry: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)).annotate({
        description: "The server in pi's shape; exactly one of entry and from_repo",
      }),
      from_repo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The directory name of a Repo of the Environment (as settings_mcp_list shows it, not owner/repo), whose server of this name is copied; an Environment's id as scope only",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(McpChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, entry, from_repo, reason }, api) =>
      definitions.add({ scope, name, entry, from_repo, reason, api }),
  });

  const update = yield* defineEffectTool({
    name: "settings_mcp_update",
    description: `Change the definition of an MCP server where it is defined: Global's at "*", an Environment's own entry at its id (a Global server at an Environment is refused: change it at "*", or add an entry of its own; a Repo's is changed in the Repo's file). set takes definition keys only: a top-level key replaces its value and null removes it; env, headers and oauth merge key by key, null removing one key; args is replaced whole. enabled, exposure and toolExposure are refused: settings_mcp_enable, settings_mcp_disable, settings_mcp_exposure_set and settings_mcp_tool_exposure_set change them. ${NOTE}`,
    parameters: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      set: Schema.Record(Schema.String, Schema.Json).annotate({
        description:
          "The definition keys to change: a value replaces the key's, null removes it; env, headers and oauth merge key by key",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(McpChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, set, reason }, api) =>
      definitions.update({ scope, name, set, reason, api }),
  });

  const remove = yield* defineEffectTool({
    name: "settings_mcp_remove",
    description: `Remove an MCP server where it is defined: Global's at "*" (every Environment loses it, but those with an entry of their own), an Environment's own entry at its id (the server then falls back to Global's of the name, or the Repo's it shadowed). A Global server at an Environment is not removed there: settings_mcp_disable switches it off for that Environment. Its MCP sign-in stays, listed as unused, until the user signs out. Removing makes no Approval necessary, unless it falls back to a server that is switched on or a tool that is not hidden (then it waits for the user's Approval as ${"settings_mcp_enable"} does). A rename is an add (which waits for the user's Approval) and a remove, so an MCP sign-in never follows a new name without the user's yes. The change is recorded with your reason, and the user can see and revert it on the Settings page. A Repo's .pi/mcp.json is edited as a file in a pull request.`,
    parameters: Schema.Struct({ scope: SettingsScope, name: ServerName, reason: Reason }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, reason }, api) => definitions.remove({ scope, name, reason, api }),
  });

  return [add, update, remove] as const;
});
