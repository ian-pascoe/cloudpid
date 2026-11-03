// @effect-diagnostics preferEffectArray:off -- JSX lists of servers are native arrays.

// The MCP servers section of the Settings page (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers"
// section; ADR-0027): one list by name of the servers at the Scope, each with its transport and target, an enabled switch,
// an Exposure select, its description (or its problems, naming the source), a source badge, its connection status, and at
// an Environment the marks that say what it inherits from Global and what it overrides, with Reset on `enabled`,
// `exposure` and `toolExposure`; at Global, where each server says which Environments override it. At an Environment a
// Global server's switch and select write an adjustment, and _Add_ writes an entry of its own. The form, the import and
// the tool exposure editor open above the list.
//
// As built, left to their tickets: a Repo's file, its rows and its Reload (#468: `mcpScopeView` takes its layers); the
// Sign-in (OAuth) disclosure and a row's sign-in state (#469: `SIGN_IN_SEAM` of the form, and the row's meta line); and "Changed
// by the agent · 5 min ago" on a row (the `settings_mcp_*` tools, #484, are what make the records it reads: the row's
// meta line is where it goes).

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Record from "effect/Record";
import { Plus, Trash2, Upload } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import { settingsPath } from "../router.ts";
import {
  ExposureSelect,
  McpFormPanel,
  McpToolsPanel,
  newMcpForm,
  toolsDraftOf,
} from "./mcp-form-panel.tsx";
import { McpImportPanel } from "./mcp-import-panel.tsx";
import {
  type McpAdjustmentKey,
  type McpProblemLine,
  type McpReferenceNames,
  type McpRow,
  type McpScopeView,
  type McpStatusChip,
  mcpMissingReferenceProblem,
  mcpMissingReferences,
  type McpStatuses,
} from "./mcp-model.ts";
import {
  changeMcpAtom,
  mcpPanelAtom,
  mcpReferenceNamesAtom,
  mcpRemoveAtom,
  mcpStatusesAtom,
  mcpViewAtom,
  removeMcpAtom,
} from "./mcp-state.ts";
import { mcpAdjustmentFields, type McpChange } from "./mcp-write.ts";
import { Group, OverriddenIn, Pending, ScopeChip, SettingsSection } from "./parts.tsx";

/** What a row's target is: the command it runs, or the URL it connects to. */
const targetOf = (row: McpRow): string =>
  row.server.type === "stdio"
    ? Arr.join([row.server.command, ...row.server.args], " ")
    : row.server.url;

/** The source badge: where the server's definition is, as the Scope sees it. */
const sourceBadgeOf = (row: McpRow, atGlobal: boolean): string => {
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
}) => (
  <ul
    aria-label={`${row.name}: inherited and overridden`}
    className="flex flex-wrap gap-x-4 gap-y-1"
  >
    {MARKED.map(([key, label]) => {
      const overridden = Arr.contains(row.adjusted, key);

      return (
        <li key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            {label}
            {key === "toolExposure" && ` (${Record.size(row.server.toolExposure)})`}
          </span>
          <ScopeChip kind={overridden ? "overridden" : "inherited"} />
          {overridden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-label={`Reset ${row.name} ${label.toLowerCase()} to Global`}
              onClick={() => {
                onReset(key);
              }}
            >
              Reset to Global
            </Button>
          )}
        </li>
      );
    })}
  </ul>
);

/** One server of the list. */
const McpRowView = ({
  scope,
  row,
  chip,
  references,
  busy,
  onChange,
}: {
  scope: string;
  row: McpRow;
  chip: McpStatusChip | undefined;
  references: McpReferenceNames | null;
  busy: boolean;
  onChange: (change: McpChange) => void;
}) => {
  const atGlobal = scope === GLOBAL_SCOPE;
  const setPanel = useAtomSet(mcpPanelAtom(scope));
  const setRemoving = useAtomSet(mcpRemoveAtom(scope));
  const own = row.kind === "global" || row.kind === "own" || row.kind === "replaces";
  const toolKeys = Record.size(row.server.toolExposure);

  const problems = [
    ...row.problems,
    ...(atGlobal || references === null
      ? []
      : Arr.map(mcpMissingReferences(row.references, references), mcpMissingReferenceProblem)),
  ];

  return (
    <li id={`mcp-server-${row.name}`} className="flex scroll-mt-6 flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium break-all">{row.name}</span>
        <Badge>{row.server.type === "stdio" ? "stdio" : "HTTP"}</Badge>
        <Badge>{sourceBadgeOf(row, atGlobal)}</Badge>
        {chip !== undefined && <StatusChip chip={chip} />}
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{targetOf(row)}</p>
      {problems.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-0.5 text-sm text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : (
        row.server.description !== undefined && (
          <p className="max-w-prose text-sm text-muted-foreground">{row.server.description}</p>
        )
      )}
      {row.hints.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {row.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            aria-label={`${row.name} enabled`}
            checked={row.server.enabled}
            disabled={busy}
            onChange={(event) => {
              onChange({ kind: "enabled", name: row.name, enabled: event.target.checked });
            }}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          Exposure
          <ExposureSelect
            label={`${row.name} exposure`}
            value={row.server.exposure}
            disabled={busy}
            onChange={(exposure) => {
              onChange({ kind: "exposure", name: row.name, exposure });
            }}
          />
        </label>
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
      {(row.kind === "inherited" || row.kind === "adjusted") && (
        <AdjustmentMarks
          row={row}
          busy={busy}
          onReset={(key) => {
            onChange({ kind: "reset", fields: mcpAdjustmentFields(row.name, [key]) });
          }}
        />
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
  references: McpReferenceNames | null;
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
