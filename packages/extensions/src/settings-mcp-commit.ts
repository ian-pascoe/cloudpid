// How every `settings_mcp_*` tool that changes a server ends (`docs/architecture/mcp-configuration.md` → The agent's changes →
// Approval, Records and revert, Results; `docs/architecture/agent-changes.md` → Approval): given the change it would make and
// the Registry's check of what it reaches and widens, it asks the owner or applies at once. A change asks when it is a
// definition (an add, a copy, an update), or when it widens (`checkMcpWidening`: it could make a switched-off server or a
// hidden tool reachable in some Environment). Otherwise it is applied with the Registry checking again, in the transaction
// that writes, that it still widens nothing (the check and the write are not atomic).
//
// The request is the call's own and durable (`./approvals.ts`): its `expected` is `{ value, inherited?, after }`, what the
// owner saw, and Approve applies exactly `after`, only while the Scope still has that value. A rerun after an eviction waits
// for the same request or takes its answer, and applies the `after` it holds without reading the state again, so a change
// that went through before the eviction is reported as approved and done. The result carries the server's status after an
// `add`, `update` or `enable` that reaches this Session's Environment (`./settings-mcp-status.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off -- builders over plain values.
import {
  isMcpToolName,
  type McpWidening,
  matchesToolPattern,
  mcpToolNames,
} from "@cloudpid/config";
import { callDurable } from "@cloudpid/effect-durable";
import { decodeMcpServerValue } from "@cloudpid/config";
import { GLOBAL_SETTINGS_SCOPE, type Surface } from "@cloudpid/protocol/harness-tools";
import { entryReferences, entryTexts } from "./settings-mcp-entry.ts";
import type {
  AgentChange,
  McpChangeGuard,
  McpFieldChange,
  SettingsMcpChangeCheck,
  SettingsMcpReach,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  type ApprovalCall,
  approvedAlready,
  askedBefore,
  Approvals,
  type ApprovalsService,
  type ApprovalChange,
  MAX_APPROVAL_NOTE,
  MAX_APPROVAL_NOTES,
  withApproval,
  declinedWith,
} from "./approvals.ts";
import {
  pushMcpSet,
  readInventory,
  SettingsMcpAccess,
  type SettingsMcpAccessService,
} from "./settings-mcp-access.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import {
  agentChangeDetails,
  isGlobalView,
  SettingsAccess,
  SettingsAccessError,
  type SettingsAccessService,
  SettingsChanges,
  type settingsChanges,
  type SettingsFieldChange,
  settingsTarget,
  type SettingsView,
} from "./settings.ts";
import {
  detailsOf,
  type McpStatus,
  notChecked,
  serverStatus,
  STATUS_WAIT_MS,
} from "./settings-mcp-status.ts";

/**
 * The call that changes an MCP server: its task and conversation, and, in a Session, the running details it may send. None on
 * the endpoint, which has no Session's task to ask the owner for, and makes only the changes that ask nobody.
 */
export type McpCall =
  | (ApprovalCall & { readonly details?: ToolExecutionApi["details"] | undefined })
  | undefined;

/** A refusal the caller reads: on the endpoint, `invalid_argument` with these words. */
export const refuse = (message: string) =>
  SettingsAccessError.make({ message, code: "invalid_argument" });

/** How every refusal begins. */
export const NOTHING = "Nothing was changed: ";

export const environmentWords = (environment: {
  readonly id: string;
  readonly name: string;
}): string => `Environment ${JSON.stringify(environment.name)} (${environment.id})`;

export const listed = (
  environments: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) => Arr.join(Arr.map(environments, environmentWords), ", ");

/** Why a change widens, in a clause. */
export const wideningWords = (widening: McpWidening): string => {
  switch (widening.kind) {
    case "switched_on":
      return "it switches the server on";
    case "exposure_unhidden":
      return "it takes the server out of hidden";
    case "key_removed":
      return `it removes the hidden toolExposure key ${JSON.stringify(widening.key)}`;
    case "key_loosened":
      return `it loosens the hidden toolExposure key ${JSON.stringify(widening.key)} to ${widening.exposure}`;
    case "key_ahead":
      return `it puts the toolExposure key ${JSON.stringify(widening.key)} ahead of ${
        widening.over === null
          ? "the server's own hidden exposure"
          : `the hidden key ${JSON.stringify(widening.over)}`
      }`;
    // A kind a later Registry adds crosses the RPC as itself: it is still a widening.
    default:
      return "it makes something reachable that was not";
  }
};

const namesWords = (view: SettingsMcpView): string =>
  view.names.length === 0 ? " It has none." : ` Its servers: ${Arr.join(view.names, ", ")}.`;

/** The server as `scope`'s set has it. */
export type Located = { readonly view: SettingsMcpView; readonly server: SettingsMcpServer };

/**
 * The server `name` in force in `scope`'s set, or why there is none to change (`docs/architecture/mcp-configuration.md` →
 * Scopes and layers): a name only Environments define, an orphaned adjustment, or no such server.
 */
export const locate = (access: SettingsMcpAccessService, scope: string, name: string) =>
  Effect.gen(function* () {
    const view = yield* access.view({ scope, name });
    const found = Arr.head(view.servers);

    if (Option.isSome(found)) return { view, server: found.value } satisfies Located;

    if (scope === GLOBAL_SETTINGS_SCOPE) {
      const elsewhere = view.definedIn ?? [];

      return yield* refuse(
        elsewhere.length > 0
          ? `${NOTHING}${JSON.stringify(name)} is not one of Global's servers: it is defined in ${listed(elsewhere)} (an Environment's own entry or a Repo's .pi/mcp.json), so there is nothing to change at "*". Give the id of one of them as scope to change it there, or copy it.`
          : `${NOTHING}No MCP server ${JSON.stringify(name)} in Global's entries.${namesWords(view)}`,
      );
    }

    const orphan = Arr.findFirst(view.orphans, (each) => each.name === name);

    if (Option.isSome(orphan)) {
      const fields = Arr.join(
        Arr.map(orphan.value.keys, (key) => `mcp.servers.${name}.${key}`),
        ", ",
      );

      return yield* refuse(
        `${NOTHING}${JSON.stringify(name)} is no server in ${view.name}'s set: it holds an adjustment (${Arr.join(orphan.value.keys, ", ")}) of a server that no layer below defines any more. Remove it with settings_reset of ${fields}.`,
      );
    }

    return yield* refuse(
      `${NOTHING}No MCP server ${JSON.stringify(name)} in ${view.name}'s set.${namesWords(view)}`,
    );
  });

/** The tools of a server the host's inventory holds, by the server's own names; null where none was read. */
export const toolNamesOf = (
  inventory: Effect.Success<ReturnType<typeof readInventory>>,
  server: string,
): ReadonlyArray<string> | null => {
  const row = inventory.byName.get(server);

  if (row === undefined) return null;

  return Arr.filterMap(row.tools ?? [], (tool) =>
    Predicate.hasProperty(tool, "name") && Predicate.isString(tool.name)
      ? Result.succeed(tool.name)
      : Result.failVoid,
  );
};

/** `lines`, each at most `MAX_APPROVAL_NOTE` characters and at most `MAX_APPROVAL_NOTES` of them, the last saying what was cut. */
export const boundedNotes = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const clip = (line: string) =>
    line.length <= MAX_APPROVAL_NOTE ? line : `${line.slice(0, MAX_APPROVAL_NOTE - 1)}…`;

  if (lines.length <= MAX_APPROVAL_NOTES) return Arr.map(lines, clip);

  return [
    ...Arr.map(Arr.take(lines, MAX_APPROVAL_NOTES - 1), clip),
    `…and ${lines.length - MAX_APPROVAL_NOTES + 1} more notes not shown.`,
  ];
};

/** What the card was shown and the call checks once approved: the value at the Scope, whether it was inherited, and `after`. */
const Expected = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  inherited: Schema.optionalKey(Schema.Boolean),
  after: Schema.NullOr(Schema.Json),
});

const decodeExpected = Schema.decodeUnknownOption(Expected);

/** The Environments of `check` that the change reaches. */
const reachedOf = (check: SettingsMcpChangeCheck) =>
  Arr.filter(check.environments, (each) => each.reached);

/** Pretty JSON as the card shows an entry; "None" for none. */
export const pretty = (value: Schema.Json | null): string =>
  value === null ? "None" : JSON.stringify(value, null, 2);

/**
 * The tools a widening of `reach` makes reachable, from this Session's own Environment's inventory when it has one:
 * a line for the card's notes, or null when the change does not widen.
 */
export const wideningNote = (
  reach: SettingsMcpReach | undefined,
  tools: ReadonlyArray<string> | null,
  server: string,
): string | null => {
  if (reach === undefined || reach.widening.length === 0) return null;

  const why = Arr.join(Arr.map(reach.widening, wideningWords), "; ");

  if (tools === null) {
    return `Widens: ${why}. Its tools are not known here (the server has not been discovered in this Environment), so which become reachable is not shown.`;
  }

  const all = Arr.some(
    reach.widening,
    (each) => each.kind === "switched_on" || each.kind === "exposure_unhidden",
  );

  const keys = Arr.filterMap(reach.widening, (each) =>
    "key" in each ? Result.succeed(each.key) : Result.failVoid,
  );

  const names = mcpToolNames(server, tools);

  const affected = all
    ? tools
    : Arr.filter(tools, (tool) =>
        Arr.some(keys, (key) =>
          key.includes("*")
            ? matchesToolPattern(key, tool) || matchesToolPattern(key, names.get(tool) ?? tool)
            : key === tool || (isMcpToolName(key) && key === names.get(tool)),
        ),
      );

  return `Widens: ${why}. Tools it can make reachable: ${
    affected.length === 0 ? "none of the known ones" : Arr.join(Arr.take(affected, 8), ", ")
  }${affected.length > 8 ? `, and ${affected.length - 8} more` : ""}.`;
};

/** What the result says of the user's record of the change, once made. */
const RECORDED =
  "The change is recorded with your reason; the user can see and revert it on the Settings page.";

/** The status the call waited for, kept for its result. */
type HeldStatus = { status: McpStatus | null };

/** What `commit` is given: one change of one server, and everything its words and its card need. */
export type McpCommitInput = {
  readonly tool: string;
  readonly api: McpCall;
  readonly scope: string;
  readonly view: SettingsView;
  readonly name: string;
  /** The field written (`mcp.servers.<name>` or one of its keys) with its value, or reset, and what it is stored as now. */
  readonly field: SettingsFieldChange;
  /**
   * The Registry's check of what the change reaches and widens; null on a rerun that could not read the state again, which
   * only waits for its request and applies what the owner approved.
   */
  readonly check: SettingsMcpChangeCheck | null;
  readonly reason: string;
  /** The texts the change keeps, checked again as `after` before an approved change is made. */
  readonly texts: ReadonlyArray<string>;
  /** Always ask: a definition (an add, a copy, an update). Otherwise only a widening change asks. */
  readonly always: boolean;
  /** The card: its change, the value now, and its notes. */
  readonly card: {
    readonly change: string;
    readonly before: Schema.Json | null;
    readonly notes: ReadonlyArray<string>;
  };
  /** What the server was (an adjustment of no server has none). */
  readonly was: SettingsMcpServer | undefined;
  /** The lines that open the result, from the server as it is after the change and the record. */
  readonly wording: (
    now: SettingsMcpServer | undefined,
    recorded: AgentChange | undefined,
  ) => ReadonlyArray<string>;
  /** Lines after the where and when, such as a copy's provenance or a remove's sign-in. */
  readonly extra: ReadonlyArray<string>;
  /** The result of a change that finds the value already there. */
  readonly alreadySo: string;
  /** Wait for the server's status afterwards (an `add`, `update` or `enable`). */
  readonly status: boolean;
  /** The card's words for a decline. */
  readonly declined: string;
};

/** What the shared ending of the tools that change servers is built over. */
export type McpCommitServices = {
  /** Where the change is made from: a Session's words say "this Session" and "the user"; the endpoint's neither. */
  readonly surface: Surface;
  readonly access: SettingsMcpAccessService;
  readonly settings: SettingsAccessService;
  /** The Settings' change machinery over the same surface (`settingsChanges`). */
  readonly changes: Pick<ReturnType<typeof settingsChanges>, "apply" | "plain">;
  /** The owner's Approvals: none on the endpoint, which makes only the changes that ask nobody. */
  readonly approvals: ApprovalsService | undefined;
};

/**
 * The shared ending of the tools that change servers, over `services`. On the endpoint's surface a change that would ask
 * the owner (a definition, or a widening) is refused as `unsupported` with nothing changed, and one that narrows is made
 * and pushed to the hosts it reaches before the answer; the words say the owner and name no Session.
 */
export const mcpCommit = ({
  surface,
  access,
  settings,
  changes: { apply, plain },
  approvals,
}: McpCommitServices) => {
  /** Whom the words call the one who reads the Settings page. */
  const owner = surface === "session" ? "user" : "owner";

  /** Send each Environment the change reaches its new set; the names of those it could not be sent to. */
  const push = (reached: ReadonlyArray<{ readonly id: string; readonly name: string }>) =>
    Effect.gen(function* () {
      const unsent: Array<string> = [];

      for (const environment of reached) {
        const made = yield* pushMcpSet(access, environment.id);

        if (made === "failed") unsent.push(environment.name);
      }

      return unsent;
    });

  /**
   * The words after a change was made, and the server's status: the lines of the tool, where the change reaches and when, the
   * push of the new set to each host, the status once the host has it (after a running update that names the call as
   * connecting), and the record.
   */
  const finish = (
    input: McpCommitInput,
    made: {
      readonly check: SettingsMcpChangeCheck;
      readonly changes: ReadonlyArray<AgentChange>;
      readonly approved: boolean;
      /** The running details a status wait sends before it waits, from the status it starts at. */
      readonly running: (status: McpStatus) => Effect.Effect<void>;
      /** The call finds the change made already (a rerun): its status is read without waiting. */
      readonly waitless: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const reached = Arr.map(reachedOf(made.check), (each) => each.environment);

      const missed = Arr.map(
        Arr.filter(made.check.environments, (each) => !each.reached),
        (each) => each.environment,
      );

      const unsent = yield* push(reached);

      const nowView = yield* access
        .view({ scope: input.scope, name: input.name })
        .pipe(Effect.orElseSucceed(() => undefined));

      const now =
        nowView === undefined ? undefined : Option.getOrUndefined(Arr.head(nowView.servers));

      // The endpoint has no Session, so no Environment is its own.
      const own =
        surface === "endpoint" ? null : yield* access.own.pipe(Effect.orElseSucceed(() => null));

      const reachesOwn = own !== null && Arr.some(reached, (each) => each.id === own);
      const recorded = Option.getOrUndefined(Arr.head(made.changes));

      const reach =
        input.scope === GLOBAL_SETTINGS_SCOPE
          ? `It reaches ${reached.length === 0 ? "no Environment" : listed(reached)}${
              missed.length === 0
                ? ""
                : `; not ${listed(missed)}, where an entry or an adjustment of its own overrides it`
            }.`
          : `It reaches ${listed(reached)}.`;

      let status: McpStatus | null = null;

      if (input.status) {
        if (!reachesOwn || own === null || now === undefined) {
          status = notChecked(
            input.name,
            "not checked: the change does not reach this Session's Environment, and no other Environment's host is woken to ask",
          );
        } else {
          const ownView =
            input.scope === own
              ? nowView
              : yield* access
                  .view({ scope: own, name: input.name })
                  .pipe(Effect.orElseSucceed(() => undefined));

          const entry =
            ownView === undefined ? undefined : Option.getOrUndefined(Arr.head(ownView.servers));

          status =
            entry === undefined || ownView === undefined
              ? notChecked(input.name, "this Session's Environment has no such server now")
              : yield* serverStatus(access, {
                  own,
                  entry,
                  offered: ownView.offered,
                  waitMs: made.waitless ? 0 : STATUS_WAIT_MS,
                  before: made.running,
                });
        }
      }

      const words = Arr.join(
        [
          ...input.wording(now, recorded),
          reach,
          ...(surface === "endpoint"
            ? ["The Sessions of the Environments it reaches get it at their next request."]
            : [
                reachesOwn
                  ? "This Session's Environment is one of them: the server's tools follow from this Session's next request once discovered (the mcp_servers section of the system prompt stays as it is for this Context Window, and a notice says so); other Sessions get it at their next request."
                  : "This Session's Environment is not one of them, so the change does not reach this Session; the Sessions of the Environments it reaches get it at their next request.",
              ]),
          unsent.length === 0
            ? reached.length === 0
              ? "No MCP host was sent anything."
              : "The new set was handed to the MCP host of each Environment it reaches (one that never had a server and has none is not woken)."
            : `The new set could not be handed to the MCP host of ${Arr.join(unsent, ", ")} now: it takes it at its next pull.`,
          ...(status === null ? [] : [status.note]),
          ...input.extra,
          made.approved
            ? "The change is recorded as approved, with your reason; the user can see and revert it on the Settings page."
            : surface === "session"
              ? RECORDED
              : `The change is recorded with your reason; the ${owner} can see and revert it on the Settings page.`,
        ],
        "\n",
      );

      return { words, status };
    });

  /** The result of a call, with the server's status in its details and its value. */
  const withStatus = <
    R extends { readonly structuredOutput: unknown; readonly details: Record<string, unknown> },
  >(
    result: R,
    status: McpStatus | null,
  ) => {
    const output = Predicate.isObject(result.structuredOutput) ? result.structuredOutput : {};

    return status === null
      ? result
      : {
          ...result,
          structuredOutput: {
            ...output,
            server_status: {
              server: status.server,
              state: status.status,
              tools: status.tools,
              direct: status.direct,
              error: status.error,
              note: status.note,
            },
          },
          details: {
            ...result.details,
            mcp: detailsOf(status),
          },
        };
  };

  /**
   * Make the change: apply it at once when it asks nobody (the Registry checking again that it widens nothing), or ask the owner
   * and apply what they approve. The result says what changed, whom it reaches and when, and the status of the server.
   */
  const commit = (input: McpCommitInput, rerunning = false) =>
    Effect.gen(function* () {
      const { api, check } = input;

      const widens =
        check !== null && Arr.some(check.environments, (each) => each.widening.length > 0);

      const asks = input.always || widens || rerunning || check === null;
      const held: HeldStatus = { status: null };

      // Nothing on the endpoint asks the owner: a change that would is not made there, and says so.
      const asking =
        surface === "session" && approvals !== undefined && api !== undefined
          ? { approvals, api }
          : undefined;

      const notHere = SettingsAccessError.make({
        message: `${NOTHING}${
          check !== null && widens
            ? `it would make something reachable that is not (${Arr.join(
                Arr.flatMap(check.environments, (each) => Arr.map(each.widening, wideningWords)),
                "; ",
              )}), which waits for the owner's Approval and is not made here`
            : "it waits for the owner's Approval, which is not asked here"
        }. The owner makes it on the Settings page.`,
        code: "unsupported",
      });

      if (asks && asking === undefined) return yield* notHere;

      /** The details of the call while the status is waited for: the change made, and the server connecting. */
      const running = (approved: boolean, made: ReadonlyArray<AgentChange>) => {
        const send = api?.details;
        const approvedDetails = approved ? { approval: { approved: true } } : {};

        if (send === undefined) return () => Effect.void;

        return (starting: McpStatus) =>
          callDurable("details", (context) =>
            send(
              {
                scope: input.view.scope,
                unchanged: [],
                agentChanges: agentChangeDetails(input.view, made),
                ...approvedDetails,
                mcp: detailsOf(starting),
              },
              context,
            ),
          ).pipe(Effect.ignore);
      };

      /** The change made; an approved one that finds its value there already is a rerun's, which waits for nothing. */
      const make = (
        approved: boolean,
        field: SettingsFieldChange,
        checked: SettingsMcpChangeCheck,
      ) => {
        const guard: Mutable<McpChangeGuard> = { name: input.name };

        if (!approved) guard.widening = true;

        // An entry written at an Environment: the Registry checks again as it writes that every `${NAME}` it reads resolves there.
        const written = field.value;

        if (input.scope !== GLOBAL_SETTINGS_SCOPE && approved && written !== null) {
          const entry = decodeMcpServerValue(written);

          if (Result.isSuccess(entry)) {
            guard.reads = Arr.dedupe(Arr.map(entryReferences(entry.success), ({ name }) => name));
          }
        }

        return apply({
          tool: input.tool,
          view: input.view,
          fields: [field],
          texts:
            approved && written !== null ? [...input.texts, ...entryTexts(written)] : input.texts,
          reason: input.reason,
          conversation: api?.conversationId,
          approved: approved ? true : undefined,
          guard,
          unchanged: approved
            ? Effect.gen(function* () {
                const done = yield* finish(input, {
                  check: checked,
                  changes: [],
                  approved,
                  running: () => Effect.void,
                  waitless: true,
                });

                held.status = done.status;

                return `${input.alreadySo}\n${done.words}`;
              })
            : input.alreadySo,
          changed: ({ changes }) =>
            Effect.gen(function* () {
              const done = yield* finish(input, {
                check: checked,
                changes,
                approved,
                running: running(approved, changes),
                waitless: false,
              });

              held.status = done.status;

              return done.words;
            }),
        });
      };

      if (!asks) {
        const result = yield* make(false, input.field, check);

        return withStatus(result, held.status);
      }

      if (asking === undefined) return yield* notHere;

      const expected: Mutable<{
        value: Schema.Json | null;
        inherited?: boolean;
        after: Schema.Json | null;
      }> = {
        value: input.field.expected?.value ?? null,
        after: input.field.reset === true ? null : input.field.value,
      };

      if (input.field.expected?.inherited !== undefined) {
        expected.inherited = input.field.expected.inherited;
      }

      const asked: ApprovalChange = {
        tool: input.tool,
        target: settingsTarget(input.view),
        change: input.card.change,
        before: pretty(input.card.before),
        after: pretty(expected.after),
        reason: input.reason,
        notes: boundedNotes(input.card.notes),
        notice: `MCP server ${input.name}, ${isGlobalView(input.view) ? "Global" : `Environment ${JSON.stringify(input.view.name)}`}`,
        expected,
      };

      const result = yield* withApproval(asking.approvals, asking.api, asked, (answer) =>
        Effect.gen(function* () {
          if (!answer.approved) {
            return declinedWith(answer, input.declined, (approval) =>
              settingsChangeOutput({ view: input.view, changes: [], unchanged: [], approval }),
            );
          }

          const shown = decodeExpected(answer.expected);

          if (Option.isNone(shown)) {
            return yield* refuse(
              "The user approved, but what they were shown was lost: nothing was saved. Ask again.",
            );
          }

          const { value, inherited, after } = shown.value;

          // What the owner saw: applied exactly, and only while the Scope still has the value they saw.
          const seen: Mutable<NonNullable<SettingsFieldChange["expected"]>> = { value };

          if (inherited !== undefined) seen.inherited = inherited;

          const field: SettingsFieldChange =
            after === null
              ? { field: input.field.field, value: null, reset: true, expected: seen }
              : { field: input.field.field, value: after, expected: seen };

          const asChange: McpFieldChange =
            after === null
              ? { field: field.field, value: null, reset: true }
              : { field: field.field, value: after };

          // A rerun that could not read the state again takes what the Registry says now of where the server is.
          const checked =
            check ??
            ({
              environments: Arr.map(
                (yield* access.check({ scope: input.scope, name: input.name, changes: [asChange] }))
                  .environments,
                (each) => ({ ...each, reached: true }),
              ),
            } satisfies SettingsMcpChangeCheck);

          return yield* make(true, field, checked);
        }),
      );

      return withStatus(result, held.status);
    });

  /** Whether the call is a rerun that asked already: none on the endpoint, which never asks. */
  const rerun = (api: ApprovalCall | undefined) =>
    approvals === undefined || api === undefined
      ? Effect.succeed(false)
      : askedBefore(approvals, api);

  /**
   * The input of a call that reruns without being able to read the state again (the server it changed is gone, or its name
   * is taken now): it waits for its request or takes the answer, and applies the `after` the request holds.
   */
  const resumeOf = (resumed: {
    readonly tool: string;
    readonly api: McpCall;
    readonly scope: string;
    readonly name: string;
    readonly field: string;
    readonly reason: string;
    readonly texts: ReadonlyArray<string>;
    readonly status: boolean;
  }) =>
    Effect.gen(function* () {
      const view = yield* settings.get(resumed.scope);

      return {
        tool: resumed.tool,
        api: resumed.api,
        scope: resumed.scope,
        view,
        name: resumed.name,
        field: { field: resumed.field, value: null },
        check: null,
        reason: resumed.reason,
        texts: resumed.texts,
        always: true,
        card: { change: "", before: null, notes: [] },
        was: undefined,
        wording: () => [`Made the change the user approved to MCP server ${resumed.name}.`],
        extra: [],
        alreadySo: approvedAlready(`MCP server ${resumed.name} has the approved change`),
        status: resumed.status,
        declined: `the change to MCP server ${resumed.name}`,
      } satisfies McpCommitInput;
    });

  /**
   * Run a call: `prepare` reads the state and gives the change to make, or the result of a change that finds nothing to do
   * (`done`). A rerun that asked already goes on to its request whatever it finds: it may have made the change itself before the
   * eviction, so "already so" or a refusal of the state (the name is taken now, the server is gone) is not its answer.
   */
  const run = <D>(call: {
    readonly rerun: boolean;
    readonly prepare: Effect.Effect<Prepared<D>, SettingsAccessError>;
    readonly resume: Effect.Effect<McpCommitInput, SettingsAccessError>;
  }) =>
    Effect.gen(function* () {
      if (!call.rerun) {
        const prepared = yield* call.prepare;

        return prepared.kind === "done" ? prepared.result : yield* commit(prepared.input);
      }

      const prepared = yield* Effect.option(call.prepare);

      if (Option.isSome(prepared) && prepared.value.kind === "commit") {
        return yield* commit(prepared.value.input, true);
      }

      return yield* commit(yield* call.resume, true);
    });

  /** The tools of `name` this Session's own Environment's host holds, or null where it holds none or there is no own Environment. */
  const ownTools = (scope: string, name: string, located: SettingsMcpView | undefined) =>
    Effect.gen(function* () {
      const own = yield* access.own.pipe(Effect.orElseSucceed(() => null));

      if (own === null) return null;

      const view =
        located !== undefined && located.scope === own
          ? located
          : yield* access.view({ scope: own, name }).pipe(Effect.orElseSucceed(() => undefined));

      if (view === undefined) return null;

      return toolNamesOf(
        yield* readInventory(access, { view, names: [name], parts: ["tools"] }),
        name,
      );
    });

  /** What a change reaches and widens, as the card's notes say it: the Sessions it reaches, and the tools a widening can make reachable. */
  const reachNotes = (input: {
    readonly scope: string;
    readonly name: string;
    readonly check: SettingsMcpChangeCheck;
    readonly view: SettingsMcpView | undefined;
  }) =>
    Effect.gen(function* () {
      // The card's notes: the endpoint asks nobody, so it has no card.
      if (surface === "endpoint") return Arr.empty<string>();

      const { check } = input;
      const reached = Arr.filter(check.environments, (each) => each.reached);
      const missed = Arr.filter(check.environments, (each) => !each.reached);
      const own = yield* access.own.pipe(Effect.orElseSucceed(() => null));

      const reaches =
        input.scope === GLOBAL_SETTINGS_SCOPE
          ? `Reaches: ${
              reached.length === 0
                ? "no Environment"
                : `${Arr.join(
                    Arr.map(reached, (each) => JSON.stringify(each.environment.name)),
                    ", ",
                  )} (every Environment but those whose own entry or adjustment overrides it${
                    missed.length === 0
                      ? ""
                      : `: ${Arr.join(
                          Arr.map(missed, (each) => JSON.stringify(each.environment.name)),
                          ", ",
                        )}`
                  })`
            }.`
          : reached.length === 0
            ? "Reaches: nothing (this Environment's own entry or adjustment already decides it)."
            : "Reaches: this Environment's Sessions.";

      const tools = yield* ownTools(input.scope, input.name, input.view);

      const widened = Arr.take(
        Arr.filter(check.environments, (each) => each.widening.length > 0),
        3,
      );

      const widening = Arr.filterMap(widened, (each) => {
        const note = wideningNote(each, each.environment.id === own ? tools : null, input.name);

        return note === null
          ? Result.failVoid
          : Result.succeed(
              input.scope === GLOBAL_SETTINGS_SCOPE
                ? `In ${JSON.stringify(each.environment.name)}: ${note}`
                : note,
            );
      });

      return [reaches, ...widening];
    });

  /** The plain-value check of a call that refuses before it asks: every refusal says nothing was asked either. */
  const plainBeforeAsking = (reason: string, texts: ReadonlyArray<string>) =>
    plain(reason, texts, "Nothing was asked or saved");

  return {
    surface,
    owner,
    access,
    settings,
    plain: plainBeforeAsking,
    commit,
    rerun,
    resumeOf,
    run,
    reachNotes,
  };
};

/** The shared ending in a Session: over its access to the Registry, the hosts and the Approvals. */
export const McpCommit = Effect.gen(function* () {
  const access = yield* SettingsMcpAccess;
  const approvals = yield* Approvals;
  const settings = yield* SettingsAccess;
  const changes = yield* SettingsChanges;

  return mcpCommit({ surface: "session", access, settings, changes, approvals });
});

export type McpCommitService = ReturnType<typeof mcpCommit>;

/** What a call's preparation comes to: a result that needs no change, or the change to make. */
export type Prepared<D> =
  | { readonly kind: "done"; readonly result: D }
  | { readonly kind: "commit"; readonly input: McpCommitInput };
