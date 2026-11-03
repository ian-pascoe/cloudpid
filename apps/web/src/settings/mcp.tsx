// @effect-diagnostics preferEffectArray:off globalDate:off -- JSX lists of servers are native arrays, and a file's read time is said against now as the Skills page does.

// The MCP servers section of the Settings page (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers"
// section; ADR-0027): one list by name of the servers at the Scope, each with its transport and target, an enabled switch,
// an Exposure select, its description (or its problems, naming the source), a source badge, its connection status, and at
// an Environment the marks that say what it inherits from Global and what it overrides, with Reset on `enabled`,
// `exposure` and `toolExposure`; at Global, where each server says which Environments override it. At an Environment a
// Global server's switch and select write an adjustment, and _Add_ writes an entry of its own. The form, the import and
// the tool exposure editor open above the list.
//
// At an Environment, above the servers, each Repo's `.pi/mcp.json` as the Registry last looked at it (its path, when it was
// read, its error and what is wrong with it, with Reload); a Repo's servers are rows of the list, read-only (view as JSON),
// with the switch and select writing this environment's adjustment, and _Copy to this environment_ / _Copy to Global_.
//
// An HTTP server's row also says its MCP sign-in (docs/architecture/mcp-sign-in.md → Settings): a state chip, the last
// problem, Sign in, Sign in again and Sign out, and the refused-document-client hint (`mcp-sign-in-parts.tsx`); at Global,
// the Sign-ins list follows the servers (`#sign-ins`). The form's Sign-in (OAuth) disclosure is `mcp-sign-in-form.tsx`.
//
// A row the agent changed (the `settings_mcp_*` tools, #484) says so on its meta line: "Changed by the agent · 5 min ago",
// linking to its change in the Agent changes section, while that change is neither reverted nor dismissed.

import type { McpExposure } from "@cloudpid/config";
import { type AgentChange, GLOBAL_SCOPE, readMcpRepoFileState } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Record from "effect/Record";
import { Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { agentChangesAtom, environmentListAtom } from "../environments-state.ts";
import { relativeTime } from "../format.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import { latestAgentChange } from "../mcp-change.ts";
import { navigate, settingsPath } from "../router.ts";
import { settingsChangesAtom } from "../settings.ts";
import { ExposureSelect, McpFormPanel, McpToolsPanel } from "./mcp-form-panel.tsx";
import { mcpCopyForm, newMcpForm, toolsDraftOf } from "./mcp-form.ts";
import { McpImportPanel } from "./mcp-import-panel.tsx";
import {
  isFollowedRow,
  isOwnRow,
  isRepoRow,
  type McpAdjustmentKey,
  type McpFileRow,
  type McpProblemLine,
  type McpRow,
  type McpScopeView,
  type McpStatusChip,
  mcpMissingReferenceProblems,
  mcpProblemText,
  mcpRepoReferenceProblems,
  type McpStatuses,
  repoBaseOf,
  repoDirectoryOf,
} from "./mcp-model.ts";
import { MessageList } from "./mcp-parts.tsx";
import { type McpSignInLine, mcpSignInLine, type McpSignInsState } from "./mcp-sign-in-model.ts";
import {
  SignInChip,
  SignInControls,
  SignInNotes,
  SignInsList,
  SignOutDialog,
} from "./mcp-sign-in-parts.tsx";
import { mcpSignInsStateAtom } from "./mcp-sign-in-state.ts";
import {
  changeMcpAtom,
  type McpReferencesState,
  mcpPanelAtom,
  mcpReferenceNamesAtom,
  mcpRemoveAtom,
  mcpRepoFilesAtom,
  mcpStatusesAtom,
  mcpViewAtom,
  reloadMcpRepoAtom,
  removeMcpAtom,
} from "./mcp-state.ts";
import {
  mcpAdjustmentFields,
  type McpChange,
  mcpRepoRowChanges,
  mcpRowChanges,
} from "./mcp-write.ts";
import { FieldMark, Group, noteId, OverriddenIn, Pending, SettingsSection } from "./parts.tsx";

/** What a row's target is: the command it runs, or the URL it connects to. */
const targetOf = (row: McpRow): string =>
  row.server.type === "stdio"
    ? Arr.join([row.server.command, ...row.server.args], " ")
    : row.server.url;

/** The source badge: where the server's definition is, as the Scope sees it. */
const sourceBadgeOf = (row: McpRow, atGlobal: boolean): string => {
  const directory = repoDirectoryOf(row);

  if (directory !== null) return `From Repo ${directory}`;

  switch (row.kind) {
    case "global":
    case "inherited":
    case "adjusted":
      return atGlobal ? "Global" : "From Global";
    case "own":
      return "This environment";
    case "replaces":
      return "This environment · replaces Global's";
  }
};

const Badge = ({ children, className }: { children: string; className?: string }) => (
  <span
    className={cn(
      "inline-flex h-5 shrink-0 items-center rounded-sm border border-input px-1.5 text-xs leading-none text-muted-foreground",
      className,
    )}
  >
    {children}
  </span>
);

/** A server's connection status, as its host reports it. */
const StatusChip = ({ chip }: { chip: McpStatusChip }) => (
  <span
    className={cn(
      "inline-flex h-5 max-w-full shrink-0 items-center truncate rounded-sm border px-1.5 text-xs leading-none",
      chip.problem
        ? "border-destructive/40 text-destructive"
        : "border-input text-muted-foreground",
    )}
  >
    {chip.label}
  </span>
);

/** Whether the host's chip says what the sign-in's chip does: the server waits for a sign-in, or was refused its token. */
const isSignInState = (chip: McpStatusChip): boolean =>
  chip.state === "sign_in" || chip.state === "rejected";

const MARKED: ReadonlyArray<readonly [McpAdjustmentKey, string]> = [
  ["enabled", "Enabled"],
  ["exposure", "Exposure"],
  ["toolExposure", "Tool exposure"],
];

/** At an Environment, a Global server's marks: each of the three keys Inherited, or Overridden with its Reset. */
const AdjustmentMarks = ({
  row,
  busy,
  onReset,
}: {
  row: McpRow;
  busy: boolean;
  onReset: (key: McpAdjustmentKey) => void;
}) => {
  const directory = repoDirectoryOf(row);

  return (
    <ul
      aria-label={`${row.name}: inherited and overridden`}
      className="flex flex-wrap gap-x-4 gap-y-1"
    >
      {MARKED.map(([key, label]) => (
        <li key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {label}
            {key === "toolExposure" && ` (${Record.size(row.server.toolExposure)})`}
          </span>
          <FieldMark
            kind={Arr.contains(row.adjusted, key) ? "overridden" : "inherited"}
            name={`${row.name} ${label.toLowerCase()}`}
            from={directory === null ? "Global" : `Repo ${directory}`}
            busy={busy}
            onReset={() => {
              onReset(key);
            }}
          />
        </li>
      ))}
    </ul>
  );
};

/** "Changed by the agent · 5 min ago", linking to the change in the Agent changes section; nothing while there is none. */
const AgentChangedLine = ({
  scope,
  name,
  changes,
}: {
  scope: string;
  name: string;
  changes: ReadonlyArray<AgentChange>;
}) => {
  const change = latestAgentChange(changes, name);

  if (change === null) return null;

  return (
    <InAppLink
      href={`${settingsPath(scope, "agent-changes")}#agent-change-${change.id}`}
      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      Changed by the agent · {relativeTime(change.at, Date.now())}
    </InAppLink>
  );
};

/** An Environment's row's mark, from the Environment's Agent changes. */
const EnvironmentAgentChanged = ({ scope, name }: { scope: string; name: string }) => {
  const loaded = useAtomValue(agentChangesAtom(scope));

  return (
    <AgentChangedLine
      scope={scope}
      name={name}
      changes={loaded.pipe(
        AsyncResult.value,
        Option.getOrElse((): ReadonlyArray<AgentChange> => []),
      )}
    />
  );
};

/** A Global row's mark, from the Settings' Agent changes. */
const GlobalAgentChanged = ({ name }: { name: string }) => {
  const loaded = useAtomValue(settingsChangesAtom);

  return (
    <AgentChangedLine
      scope={GLOBAL_SCOPE}
      name={name}
      changes={loaded.pipe(
        AsyncResult.value,
        Option.getOrElse((): ReadonlyArray<AgentChange> => []),
      )}
    />
  );
};

/** One server of the list. */
const McpRowView = ({
  scope,
  row,
  chip,
  signIn,
  references,
  busy,
  onChange,
}: {
  scope: string;
  row: McpRow;
  chip: McpStatusChip | undefined;
  /** What the row says of its MCP sign-in; null for a server that has none. */
  signIn: McpSignInLine | null;
  references: McpReferencesState;
  busy: boolean;
  onChange: (change: McpChange) => void;
}) => {
  const atGlobal = scope === GLOBAL_SCOPE;
  const setPanel = useAtomSet(mcpPanelAtom(scope));
  const setGlobalPanel = useAtomSet(mcpPanelAtom(GLOBAL_SCOPE));
  const setRemoving = useAtomSet(mcpRemoveAtom(scope));
  const own = isOwnRow(row);
  const fromRepo = isRepoRow(row);
  const toolKeys = Record.size(row.server.toolExposure);
  const changes = fromRepo ? mcpRepoRowChanges(row) : mcpRowChanges(row);
  const repoBase = fromRepo ? repoBaseOf(row) : null;
  // A Repo's server is only switched off or hidden here; what the Repo's file says comes back by Reset.
  const switchOnLocked = repoBase !== null && !row.server.enabled && !repoBase.enabled;
  const exposureLocked = repoBase !== null && repoBase.exposure === "hidden";

  const problemsId = noteId(`mcp-row-${row.name}`);
  const hintsId = `mcp-row-hints-${row.name}`;

  const problems = [
    ...row.problems,
    ...(atGlobal || references.status !== "ready"
      ? []
      : fromRepo
        ? mcpRepoReferenceProblems(row, references.names)
        : mcpMissingReferenceProblems(row, references.names)),
  ];

  const describedBy =
    Arr.join(
      [...(problems.length > 0 ? [problemsId] : []), ...(row.hints.length > 0 ? [hintsId] : [])],
      " ",
    ) || undefined;

  return (
    <li
      id={`mcp-server-${row.name}`}
      tabIndex={-1}
      className="flex scroll-mt-6 flex-col gap-2 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium break-all">{row.name}</span>
        <Badge>{row.server.type === "stdio" ? "stdio" : "HTTP"}</Badge>
        <Badge>{sourceBadgeOf(row, atGlobal)}</Badge>
        {signIn?.chip != null && <SignInChip chip={signIn.chip} />}
        {chip !== undefined && !(signIn?.chip != null && isSignInState(chip)) && (
          <StatusChip chip={chip} />
        )}
        {atGlobal ? (
          <GlobalAgentChanged name={row.name} />
        ) : (
          <EnvironmentAgentChanged scope={scope} name={row.name} />
        )}
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{targetOf(row)}</p>
      {signIn !== null && <SignInNotes id={noteId(`mcp-row-sign-in-${row.name}`)} line={signIn} />}
      {problems.length > 0 ? (
        <MessageList
          tone="problem"
          id={problemsId}
          messages={Arr.map(problems, mcpProblemText)}
          action={(index) => {
            const reset = problems[index]?.reset ?? [];

            return reset.length === 0 ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Reset ${Arr.join(reset, ", ")}`}
                onClick={() => {
                  onChange({ kind: "reset", fields: reset });
                }}
              >
                Reset
              </Button>
            );
          }}
        />
      ) : (
        row.server.description !== undefined && (
          <p className="max-w-prose text-sm text-muted-foreground">{row.server.description}</p>
        )
      )}
      <MessageList tone="hint" id={hintsId} messages={row.hints} small />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            aria-label={`${row.name} enabled`}
            aria-describedby={describedBy}
            checked={row.server.enabled}
            disabled={busy || switchOnLocked}
            onChange={(event) => {
              onChange(changes.enabled(event.target.checked));
            }}
          />
          <span aria-hidden="true">Enabled</span>
        </label>
        <div className="flex items-center gap-2 text-sm">
          <span aria-hidden="true">Exposure</span>
          <ExposureSelect
            label={`${row.name} exposure`}
            value={row.server.exposure}
            options={
              repoBase === null
                ? undefined
                : Arr.dedupe<Array<McpExposure>>([repoBase.exposure, "hidden", row.server.exposure])
            }
            disabled={busy || exposureLocked}
            describedBy={describedBy}
            onChange={(exposure) => {
              onChange(changes.exposure(exposure));
            }}
          />
        </div>
        {atGlobal || own ? (
          toolKeys > 0 && (
            <span className="text-xs text-muted-foreground">
              {toolKeys} tool exposure {toolKeys === 1 ? "key" : "keys"}
            </span>
          )
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setPanel(toolsDraftOf(row));
            }}
          >
            Tool exposure…
          </Button>
        )}
        {signIn !== null && (
          <SignInControls
            scope={scope}
            name={row.name}
            line={signIn}
            returnTo={`mcp-server-${row.name}`}
          />
        )}
        <span className="flex items-center gap-1 sm:ml-auto">
          {own ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPanel(newMcpForm("edit", row.name, row.written));
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Remove ${row.name}`}
                title={`Remove ${row.name}`}
                onClick={() => {
                  setRemoving(row.name);
                }}
              >
                <Trash2 />
              </Button>
            </>
          ) : fromRepo ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Copy ${row.name} to this environment`}
                onClick={() => {
                  setPanel(mcpCopyForm(row));
                }}
              >
                Copy to this environment…
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Copy ${row.name} to Global`}
                onClick={() => {
                  // Global's form opens with the copy, in Global's own section.
                  setGlobalPanel(mcpCopyForm(row));
                  navigate(settingsPath(GLOBAL_SCOPE, "mcp"));
                }}
              >
                Copy to Global…
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPanel(newMcpForm("replace", row.name, row.written));
                }}
              >
                Use its own copy…
              </Button>
              <InAppLink
                href={settingsPath(GLOBAL_SCOPE, "mcp")}
                className="px-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Edit at Global
              </InAppLink>
            </>
          )}
        </span>
      </div>
      {isFollowedRow(row) && (
        <AdjustmentMarks
          row={row}
          busy={busy}
          onReset={(key) => {
            onChange({ kind: "reset", fields: mcpAdjustmentFields(row.name, [key]) });
          }}
        />
      )}
      {fromRepo && (
        <>
          <p className="text-xs text-muted-foreground">
            Read-only: from Repo {repoDirectoryOf(row)}'s .pi/mcp.json on its default branch. It
            runs without Secrets, so its <code>{"${NAME}"}</code> values read this environment's
            Variables only. Switch it off or hide tools here (Reset brings back what its file says),
            or copy it to keep an entry of your own.
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">View as JSON</summary>
            <pre className="mt-1 max-w-full overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono">
              {JSON.stringify({ [row.name]: row.fileEntry ?? row.written }, null, 2)}
            </pre>
          </details>
        </>
      )}
      {row.kind === "replaces" && (
        <p className="text-xs text-muted-foreground">
          This environment's own entry replaces Global's of the same name; removing it falls back to
          Global's.
        </p>
      )}
      {atGlobal && (
        <OverriddenIn
          environments={row.overriddenIn}
          pathAt={(environment) => settingsPath(environment, "mcp")}
        />
      )}
    </li>
  );
};

/** What is wrong that no row shows: an entry left out, or an adjustment with no server to adjust. */
const ProblemRow = ({
  line,
  busy,
  onReset,
}: {
  line: McpProblemLine;
  busy: boolean;
  onReset: (fields: ReadonlyArray<string>) => void;
}) => (
  <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
    <span className="min-w-0 text-destructive">
      {line.name !== null && <span className="font-mono font-medium">{line.name} </span>}
      {line.source}: {line.message}
    </span>
    {line.reset.length > 0 && (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          onReset(line.reset);
        }}
      >
        Reset
      </Button>
    )}
  </li>
);

/** What a Repo's file is, in words: where the Registry's last look left it. */
const fileStateOf = ({ file }: McpFileRow, now: number): ReadonlyArray<string> => {
  const when = (time: number | undefined): string =>
    time === undefined ? "" : relativeTime(time, now);

  switch (readMcpRepoFileState(file.state)) {
    case "never":
      return ["Not read yet."];
    case "read":
      return [`Read ${when(file.readAt)}.`];
    case "absent":
      return [
        `Not in the Repo: no .pi/mcp.json on its default branch (looked ${when(file.lookedAt)}).`,
      ];
    case "oversize":
      return [`Not read (looked ${when(file.lookedAt)}).`];
    case "unreadable":
      return [
        `Could not be read${file.errorSince === undefined ? "" : ` since ${when(file.errorSince)}`}: ${file.error ?? "GitHub gave no answer"}`,
        file.text === undefined
          ? "There is no copy of it, so it adds no servers."
          : `Its servers are those of the copy read ${when(file.readAt)}.`,
      ];
    case "not_github":
      return [
        "Not on GitHub, so its .pi/mcp.json is not read: put its servers in this environment's Settings.",
      ];
    case "unknown":
      return [`In a state this page does not know (${file.state}).`];
  }
};

/** One Repo's file: its path, when it was read, its error and problems, and Reload. */
const RepoFileRow = ({
  row,
  now,
  busy,
  onReload,
}: {
  row: McpFileRow;
  now: number;
  busy: boolean;
  onReload: (repo: string) => void;
}) => {
  const { file } = row;
  const problemsId = noteId(`mcp-repo-${file.repo}`);

  return (
    <li id={`mcp-repo-${file.repo}`} className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium break-all">{file.repo}</span>
        <Badge>{file.path}</Badge>
        {file.slug !== undefined && <Badge>{file.slug}</Badge>}
        {file.blob !== undefined && readMcpRepoFileState(file.state) === "read" && (
          <Badge>{`blob ${file.blob.slice(0, 7)}`}</Badge>
        )}
        {readMcpRepoFileState(file.state) !== "not_github" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="sm:ml-auto"
            disabled={busy}
            aria-label={`Reload ${file.repo}'s ${file.path}`}
            onClick={() => {
              onReload(file.repo);
            }}
          >
            <RefreshCw />
            Reload
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {Arr.map(fileStateOf(row, now), (line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <MessageList
        tone="problem"
        id={problemsId}
        messages={Arr.map(row.problems, (line) => `${line.source}: ${line.message}`)}
        small
      />
    </li>
  );
};

/** At an Environment, each Repo's `.pi/mcp.json` above the servers, with Reload; or why they are not known. */
const RepoFiles = ({ scope, view }: { scope: string; view: McpScopeView }) => {
  const known = useAtomValue(mcpRepoFilesAtom(scope));
  const environments = useAtomValue(environmentListAtom);
  const [reloaded, reload] = useAtom(reloadMcpRepoAtom(scope));
  const busy = reloaded.waiting;

  // An Environment with no Repos has nothing to say of their files, whatever the Registry answers.
  const hasRepos = Arr.some(
    environments ?? [],
    (environment) => environment.id === scope && environment.repos.length > 0,
  );

  if (known.status === "failed") {
    if (!hasRepos) return null;

    return (
      <Group title="Repo files">
        <p className="text-xs text-muted-foreground">
          The Repos' .pi/mcp.json are unavailable, so their servers are not shown: {known.problem}
        </p>
      </Group>
    );
  }

  if (view.files.length === 0) return null;

  return (
    <Group title="Repo files">
      <p className="max-w-prose text-sm text-muted-foreground">
        Each Repo's .pi/mcp.json on its default branch, as last read. A Repo's servers run without
        Secrets and are read-only here.
      </p>
      <ul className="flex flex-col divide-y">
        {view.files.map((row) => (
          <RepoFileRow
            key={row.file.repo}
            row={row}
            now={Date.now()}
            busy={busy}
            onReload={reload}
          />
        ))}
      </ul>
      <DialogProblem problem={settledFailureOf(reloaded)} />
    </Group>
  );
};

/** The warnings of the section: `codemode` Exposure while `codemode` is not offered. */
const Warnings = ({ scope, view }: { scope: string; view: McpScopeView }) => (
  <>
    {view.warnings.map((warning) => (
      <p
        key={warning.kind}
        role="status"
        className="max-w-prose text-sm text-amber-600 dark:text-amber-400"
      >
        {Arr.join(warning.servers, ", ")} {warning.servers.length === 1 ? "has" : "have"} codemode
        Exposure, but the offered tools here do not include <code>codemode</code>: the model has to
        load it with <code>tool_search</code> first.{" "}
        <InAppLink
          href={settingsPath(scope, "tools")}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Offered tools
        </InAppLink>
      </p>
    ))}
  </>
);

/** Confirm removing server `name`, after saying what stays. */
const RemoveDialogBody = ({
  scope,
  view,
  name,
}: {
  scope: string;
  view: McpScopeView;
  name: string;
}) => {
  const [removed, remove] = useAtom(removeMcpAtom(scope));
  const [, setRemoving] = useAtom(mcpRemoveAtom(scope));
  const busy = removed.waiting;
  const row = Arr.findFirst(view.rows, (held) => held.name === name);
  const replaces = Option.exists(row, (held) => held.kind === "replaces");

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!busy) remove(name);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm">
        {scope === GLOBAL_SCOPE
          ? "Every environment that follows it loses it, within a minute for a session that has it. An environment's own entry of the same name stays; an adjustment of it is left with no server to adjust."
          : replaces
            ? "This environment goes back to Global's server of this name."
            : "This environment's sessions lose it within a minute."}{" "}
        An MCP sign-in kept for it stays, listed as unused, until you sign out.
      </p>
      <DialogProblem problem={settledFailureOf(removed)} />
      <DialogActions>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setRemoving(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy ? "Removing…" : "Remove server"}
        </Button>
      </DialogActions>
    </form>
  );
};

/** The panel open above the list: a form, the import, or the tool exposure editor. */
const OpenPanel = ({
  scope,
  view,
  references,
  statuses,
}: {
  scope: string;
  view: McpScopeView;
  references: McpReferencesState;
  statuses: McpStatuses;
}) => {
  const [panel] = useAtom(mcpPanelAtom(scope));
  const atGlobal = scope === GLOBAL_SCOPE;

  switch (panel?.kind) {
    case "form":
      return (
        <McpFormPanel
          scope={scope}
          atGlobal={atGlobal}
          draft={panel}
          view={view}
          references={references}
          tools={statuses.tools[panel.fields.name] ?? []}
        />
      );
    case "tools":
      return (
        <McpToolsPanel
          scope={scope}
          draft={panel}
          row={Option.getOrNull(Arr.findFirst(view.rows, (row) => row.name === panel.name))}
          tools={statuses.tools[panel.name] ?? []}
        />
      );
    case "import":
      return (
        <McpImportPanel
          scope={scope}
          atGlobal={atGlobal}
          draft={panel}
          view={view}
          references={references}
        />
      );
    default:
      return null;
  }
};

const McpLoaded = ({ scope, view }: { scope: string; view: McpScopeView }) => {
  const atGlobal = scope === GLOBAL_SCOPE;
  const statuses = useAtomValue(mcpStatusesAtom(scope));
  const signIns: McpSignInsState = useAtomValue(mcpSignInsStateAtom);
  const references = useAtomValue(mcpReferenceNamesAtom(scope));
  const [, setPanel] = useAtom(mcpPanelAtom(scope));
  const [removing, setRemoving] = useAtom(mcpRemoveAtom(scope));
  const [changed, change] = useAtom(changeMcpAtom(scope));
  const [removed] = useAtom(removeMcpAtom(scope));
  const busy = changed.waiting;

  return (
    <>
      <Group>
        <Warnings scope={scope} view={view} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPanel(newMcpForm("add", "", null));
            }}
          >
            <Plus />
            Add server
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPanel({ kind: "import", text: "", choices: {} });
            }}
          >
            <Upload />
            Import pi JSON…
          </Button>
        </div>
        <OpenPanel scope={scope} view={view} references={references} statuses={statuses} />
      </Group>
      {!atGlobal && <RepoFiles scope={scope} view={view} />}
      <Group title="Servers">
        {view.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {atGlobal ? "No MCP servers kept Global." : "No MCP servers in this environment."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {view.rows.map((row) => (
              <McpRowView
                key={row.name}
                scope={scope}
                row={row}
                chip={statuses.chips[row.name]}
                signIn={mcpSignInLine(row, signIns, statuses.chips[row.name]?.state)}
                references={references}
                busy={busy}
                onChange={change}
              />
            ))}
          </ul>
        )}
        {statuses.unavailable !== null && (
          <p className="text-xs text-muted-foreground">
            Connection status is unavailable: {statuses.unavailable}
          </p>
        )}
        <DialogProblem problem={settledFailureOf(changed)} />
      </Group>
      {atGlobal && <SignInsList />}
      {view.problems.length > 0 && (
        <Group title="Problems">
          <ul className="flex flex-col divide-y">
            {view.problems.map((line) => (
              <ProblemRow
                key={`${line.source}:${line.name ?? ""}:${line.message}`}
                line={line}
                busy={busy}
                onReset={(fields) => {
                  change({ kind: "reset", fields });
                }}
              />
            ))}
          </ul>
        </Group>
      )}
      <SignOutDialog scope={scope} />
      <Dialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
        }}
        dismissible={!removed.waiting}
        title={`Remove ${removing ?? ""}?`}
      >
        {removing !== null && <RemoveDialogBody scope={scope} view={view} name={removing} />}
      </Dialog>
    </>
  );
};

/** The MCP servers section at Scope `scope`. */
export const McpSection = ({ scope }: { scope: string }) => {
  const loaded = useAtomValue(mcpViewAtom(scope));
  const view = AsyncResult.value(loaded);

  return (
    <SettingsSection
      title="MCP servers"
      description={
        scope === GLOBAL_SCOPE
          ? "The MCP servers every environment's sessions can use. An environment can switch one off, change how it reaches the model, or keep an entry of its own under the same name."
          : "The MCP servers this environment's sessions can use: Global's, which a switch or select here adjusts for this environment only, and its own."
      }
    >
      {Option.isSome(view) ? (
        <McpLoaded scope={scope} view={view.value} />
      ) : (
        <Pending problem={failureOf(loaded)} />
      )}
    </SettingsSection>
  );
};
