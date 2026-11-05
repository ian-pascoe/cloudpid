/**
 * The text of each read tool's result (`docs/architecture/mcp-endpoint.md` → Tools, Results): `content` is one text block
 * rendering the same result `structuredContent` carries, so neither holds anything the other lacks (Claude Code forwards
 * only the JSON; pi shows only the text). Every rendering shows an id beside the title. Pure functions of the decoded
 * results; the `next` sentence is the caller's, appended last.
 */
// @effect-diagnostics globalDate:off -- an epoch time said as ISO text.
import type {
  McpSessionOrigin,
  McpSessionSummary,
  WaitingRequest,
} from "@cloudpid/protocol/mcp-api";
import type {
  EnvironmentsListResult,
  SessionGetResult,
  SessionImportAppendResult,
  SessionImportBeginResult,
  SessionImportCancelResult,
  SessionImportFinishResult,
  SessionSendResult,
  SessionsListResult,
  SessionStartResult,
  SessionStopResult,
  SessionTranscriptResult,
  SessionWaitResult,
} from "@cloudpid/protocol/mcp-tools";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Record from "effect/Record";

/** The most characters of `content` a result other than a transcript carries. */
export const MAX_TEXT_CHARS = 12_000;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

const titled = (title: string | null, id: string): string =>
  `${title === null || title === "" ? "(untitled)" : title} [${id}]`;

/** Where a Session came from, in a few words. */
const originOf = (origin: McpSessionOrigin | undefined): string | undefined => {
  if (origin === undefined) return undefined;

  if ("session" in origin) return `${origin.kind} of ${origin.session}`;

  const client = origin.client?.name;

  const kind = Match.value(origin.kind).pipe(
    Match.when("import", () => "imported"),
    Match.when("mcp", () => "started over MCP"),
    Match.orElse(() => "via MCP"),
  );

  return client === undefined ? kind : `${kind} by ${client}`;
};

const sessionLine = (session: McpSessionSummary): string => {
  const parts = [
    titled(session.title, session.session_id),
    session.status,
    `${session.environment.name} [${session.environment.id}]`,
    `updated ${session.updated_at}`,
    ...(session.archived ? ["archived"] : []),
    ...Arr.fromIterable(originOf(session.origin) ?? []),
    session.url,
  ];

  return `- ${Arr.join(parts, " · ")}`;
};

export const renderEnvironments = (result: EnvironmentsListResult): string => {
  const lines = Arr.map(result.environments, (environment) => {
    const repos =
      environment.repos.length === 0
        ? "no repos"
        : Arr.join(
            Arr.map(environment.repos, (repo) => `${repo.name} ${repo.url}`),
            ", ",
          );

    const parts = [
      `${environment.name} [${environment.id}]${environment.default ? " (default)" : ""}`,
      `${environment.running_sessions} running`,
      repos,
    ];

    return `- ${Arr.join(parts, " · ")}`;
  });

  const models =
    result.models.default === undefined
      ? Arr.join(result.models.available, ", ")
      : `${Arr.join(result.models.available, ", ")} (default ${result.models.default})`;

  return Arr.join(
    [`Environments (${result.environments.length}):`, ...lines, `Models: ${models}`],
    "\n",
  );
};

export const renderSessions = (result: SessionsListResult): string => {
  if (result.sessions.length === 0) return "No Sessions match.";

  return Arr.join(
    [
      `Sessions (${result.sessions.length}${result.next_cursor === undefined ? "" : ", more follow"}):`,
      ...Arr.map(result.sessions, sessionLine),
    ],
    "\n",
  );
};

const waitingLine = (request: WaitingRequest): string =>
  `- ${request.kind} [${request.request_id}] (${request.agent_id}) since ${iso(request.since)}: ${request.summary} ${request.url}`;

export const renderSession = (result: SessionGetResult): string => {
  const lines: Array<string> = [
    `Session ${titled(result.title, result.session_id)}`,
    Arr.join(
      [
        `status ${result.status}`,
        `environment ${result.environment.name} [${result.environment.id}]`,
        `updated ${result.updated_at}`,
        ...(result.archived ? ["archived"] : []),
      ],
      " · ",
    ),
    `url ${result.url}`,
  ];

  const origin = originOf(result.origin);

  if (origin !== undefined) lines.push(`origin ${origin}`);

  const model = Arr.join(
    [
      ...Arr.fromIterable(result.model === undefined ? [] : [`model ${result.model}`]),
      ...Arr.fromIterable(result.thinking === undefined ? [] : [`thinking ${result.thinking}`]),
    ],
    " · ",
  );

  if (model !== "") lines.push(model);

  const { branch, base, repos } = result.workspace;

  lines.push(
    `workspace ${branch ?? "(no branch)"}${base === null ? "" : ` (from ${base})`} · repos ${repos.length === 0 ? "none" : Arr.join(repos, ", ")}`,
  );

  if (result.agents.length > 0) {
    lines.push(
      "agents:",
      ...Arr.map(
        result.agents,
        (agent) =>
          `- ${agent.agent_id}${agent.role === null ? "" : ` (${agent.role})`} ${agent.status}, started by ${agent.parent}`,
      ),
    );
  }

  if (result.waiting.length > 0) {
    lines.push("waiting for the owner:", ...Arr.map(result.waiting, waitingLine));
  }

  if (result.outcome !== undefined) {
    const { result: how, reason, message } = result.outcome;

    lines.push(
      `last Run ${how}${reason === undefined ? "" : ` (${reason})`}${message === undefined ? "" : `: ${message}`}`,
    );
  }

  if (result.last_answer !== undefined) {
    lines.push(
      `last answer${result.last_answer.truncated ? " (cut)" : ""}:`,
      result.last_answer.text,
    );
  }

  if (result.text_withheld !== undefined) {
    lines.push(`text withheld: ${result.text_withheld}`);
  }

  if (result.branch_changed === true)
    lines.push("The owner moved the active branch since the cursor.");

  lines.push(`cursor ${result.cursor}`);

  return Arr.join(lines, "\n");
};

/** What a wait whose connection to the Session was cut says of it, in the text and in the `next` sentence. */
export const INTERRUPTED_NOTE = "(the connection to the Session was cut; the Run is not affected)";

const ENDED_BY = {
  run_ended: "the Run ended",
  owner_needed: "a request is waiting for the owner",
  import_ended: "the import ended",
  timeout: "the wait ended with nothing new",
} as const;

export const renderWait = (result: SessionWaitResult): string => {
  const lines: Array<string> = [
    `Wait on Session ${result.session_id}: ${ENDED_BY[result.ended_by]}${result.interrupted === true ? ` ${INTERRUPTED_NOTE}` : ""}`,
    `status ${result.status}`,
  ];

  if (result.outcome !== undefined) {
    const { result: how, reason, message } = result.outcome;

    lines.push(
      `Run ${how}${reason === undefined ? "" : ` (${reason})`}${message === undefined ? "" : `: ${message}`}`,
    );
  }

  if (result.error !== undefined) lines.push(`error: ${result.error}`);

  if (result.waiting.length > 0) {
    lines.push("waiting for the owner:", ...Arr.map(result.waiting, waitingLine));
  }

  const { entries, tool_calls: calls, latest } = result.activity;

  lines.push(`activity since the cursor: ${entries} entries, ${calls} tool calls`);

  if (latest.length > 0) lines.push(...Arr.map(latest, (line) => `  ${line}`));

  if (result.answer !== undefined) {
    lines.push(`answer${result.answer.truncated ? " (cut)" : ""}:`, result.answer.text);
  }

  if (result.text_withheld !== undefined) lines.push(`text withheld: ${result.text_withheld}`);

  if (result.branch_changed === true) {
    lines.push("The owner moved the active branch since the cursor.");
  }

  lines.push(`cursor ${result.cursor}`);

  return Arr.join(lines, "\n");
};

export const renderTranscript = (result: SessionTranscriptResult): string => {
  const lines: Array<string> = [
    `Transcript of ${result.session_id}${result.agent_id === undefined ? "" : ` (${result.agent_id})`}: ${result.entries.length} entries`,
  ];

  if (result.branch_changed === true)
    lines.push("The owner moved the active branch since the cursor.");

  if (result.entries.length === 0) lines.push("(no entries)");

  for (const entry of result.entries) lines.push("", entry.text);

  lines.push("", `older ${result.older ?? "(none: this page starts at the oldest entry)"}`);
  lines.push(`newer ${result.newer}`);

  return Arr.join(lines, "\n");
};

export const renderStart = (result: SessionStartResult): string =>
  Arr.join(
    [
      `Started Session ${titled(result.title, result.session_id)}`,
      Arr.join(
        [
          `status ${result.status}`,
          `environment ${result.environment.name} [${result.environment.id}]`,
          `repos ${result.environment.repos.length === 0 ? "none" : Arr.join(result.environment.repos, ", ")}`,
        ],
        " · ",
      ),
      `url ${result.url}`,
      `cursor ${result.cursor}`,
    ],
    "\n",
  );

const DELIVERIES = {
  started: "Sent: it started a Run.",
  queued: "Queued: it starts another Run when the current one ends.",
  steered: "Steered: it joins the running Run at its next step.",
  unknown: "Sent.",
} as const;

export const renderSend = (result: SessionSendResult): string =>
  Arr.join([DELIVERIES[result.delivery], `cursor ${result.cursor}`], "\n");

export const renderStop = (result: SessionStopResult): string =>
  result.stopping === true
    ? `Stopping: the Session is still ${result.status}; it was asked to stop.`
    : `The Session is ${result.status}.`;

export const renderImportBegin = (result: SessionImportBeginResult): string =>
  Arr.join(
    [
      `Import ${result.import_id} begun: it is Session ${result.session_id}, importing.`,
      `url ${result.url}`,
      `received ${result.received} bytes · slices of at most ${result.max_slice_bytes} bytes · expires ${result.expires_at} without an append`,
      `carry_ref ${result.carry_ref}`,
    ],
    "\n",
  );

export const renderImportAppend = (result: SessionImportAppendResult): string =>
  `Received ${result.received} bytes.`;

export const renderImportFinish = (result: SessionImportFinishResult): string => {
  const lines: Array<string> = [
    result.status === "importing"
      ? `Import of Session ${result.session_id} accepted: still importing.`
      : `Import of Session ${result.session_id} ended: ${result.status}.`,
    `url ${result.url}`,
  ];

  if (result.summary !== undefined) {
    const { cut, dropped, closed } = result.summary;

    const droppedKinds = Arr.join(
      Arr.map(Record.toEntries(dropped), ([kind, count]) => `${kind} ${count}`),
      ", ",
    );

    lines.push(
      `summary: ${cut} cut, ${closed} closed, dropped ${droppedKinds === "" ? "none" : droppedKinds}`,
    );
  }

  for (const warning of result.warnings) lines.push(`warning: ${warning}`);

  lines.push(`cursor ${result.cursor}`);

  return Arr.join(lines, "\n");
};

export const renderImportCancel = (_result: SessionImportCancelResult): string =>
  "The import was cancelled and its Session deleted.";
