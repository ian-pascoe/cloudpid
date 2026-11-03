// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- JSX lists of rows are native arrays, and a builder of a draft is no combinator.

// The Add/Edit form of an MCP server, and the editor of a Global server's tool exposure at an Environment
// (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): stdio (command, args, `cwd`) or HTTP
// (`url`); `env` and `headers` rows hinting `${NAME}` with the Scope's Secret and Variable names (never a value) and
// warning of a credential-shaped literal; timeout, description, enabled, Exposure, "Model use" (`sampling`); `toolExposure`
// as pattern → Exposure rows, suggesting tool names once the server has been discovered; a "Sign-in (OAuth)" disclosure
// (`mcp-sign-in-form.tsx`, at `SIGN_IN_SEAM`) for an HTTP server; and a raw-JSON tab.

import { MCP_SAMPLING, type McpExposure } from "@cloudpid/config";
import { useAtom } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import {
  checkMcpEntry,
  entryOfFields,
  entryOfJson,
  type McpFields,
  type McpFormCheck,
  type McpFormDraft,
  type McpKeyValue,
  mcpFieldsProblems,
  mcpFormShowing,
  type McpToolRow,
  type McpToolsDraft,
  MCP_EXPOSURE_LABELS,
  MCP_EXPOSURE_OPTIONS,
  MCP_SAMPLING_LABELS,
  toolExposureOfRows,
} from "./mcp-form.ts";
import {
  isFollowedRow,
  type McpReferenceNames,
  type McpRow,
  type McpScopeView,
  repoDirectoryOf,
} from "./mcp-model.ts";
import { MessageList, OptionSelect, ReferencesNotice } from "./mcp-parts.tsx";
import { mcpRepoToolsChange } from "./mcp-write.ts";
import { type McpReferencesState, mcpPanelAtom, saveMcpAtom } from "./mcp-state.ts";
import { OauthDisclosure } from "./mcp-sign-in-form.tsx";
import { CODE_AREA, Field, noteId } from "./parts.tsx";

/** Where the "Sign-in (OAuth)" disclosure is: the id of the element that holds it. */
export const SIGN_IN_SEAM = "sign-in";

/** What each "Model use" answer lets the server do. */
const SAMPLING_HINTS: Readonly<Record<(typeof MCP_SAMPLING)[number], string>> = {
  ask: "The server asks you each time it wants a model's reply.",
  allow: "The server may use your models without asking.",
  off: "The server's requests for a model's reply are refused.",
};

/** A select of the four Exposures, or of `options` (a Repo's server is only ever hidden here). */
export const ExposureSelect = ({
  id,
  label,
  value,
  options = MCP_EXPOSURE_OPTIONS,
  disabled,
  describedBy,
  onChange,
}: {
  id?: string | undefined;
  label?: string | undefined;
  value: McpExposure;
  options?: ReadonlyArray<McpExposure> | undefined;
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
  onChange: (exposure: McpExposure) => void;
}) => (
  <OptionSelect
    id={id}
    label={label}
    options={options}
    labels={MCP_EXPOSURE_LABELS}
    value={value}
    disabled={disabled}
    describedBy={describedBy}
    onChange={onChange}
  />
);

/** Rows of two inputs (a name and a value, or a pattern and an Exposure), each with a remove button, and an add button. */
const Rows = ({
  addLabel,
  onAdd,
  children,
}: {
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    {children}
    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onAdd}>
      <Plus />
      {addLabel}
    </Button>
  </div>
);

const RemoveRow = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <Button
    type="button"
    size="icon"
    variant="ghost"
    className="size-9 shrink-0"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    <X />
  </Button>
);

/** `rows` with row `index` replaced by `next`, or taken out for `undefined`. */
const replaced = <Row,>(rows: ReadonlyArray<Row>, index: number, next: Row | undefined) =>
  next === undefined
    ? Arr.filter(rows, (_, at) => at !== index)
    : Arr.map(rows, (row, at) => (at === index ? next : row));

/** The rows of an `env` or `headers` map: a key, and a value that may read `${NAME}`. */
const KeyValueRows = ({
  label,
  rows,
  namesList,
  onChange,
}: {
  /** "Environment variable" or "Header". */
  label: string;
  rows: ReadonlyArray<McpKeyValue>;
  /** The id of the datalist of `${NAME}` the values suggest. */
  namesList: string;
  onChange: (rows: ReadonlyArray<McpKeyValue>) => void;
}) => (
  <Rows
    addLabel={`Add ${label.toLowerCase()}`}
    onAdd={() => {
      onChange([...rows, { key: "", value: "" }]);
    }}
  >
    {rows.map((row, index) => (
      // Rows are controlled by their position: nothing else names one.
      // oxlint-disable-next-line react/no-array-index-key
      <div key={index} className="flex items-center gap-2">
        <Input
          aria-label={`${label} ${index + 1} name`}
          value={row.key}
          placeholder="NAME"
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="w-2/5 font-mono"
          onChange={(event) => {
            onChange(replaced(rows, index, { ...row, key: event.target.value }));
          }}
        />
        <Input
          aria-label={`${label} ${index + 1} value`}
          value={row.value}
          placeholder="${NAME}"
          list={namesList}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => {
            onChange(replaced(rows, index, { ...row, value: event.target.value }));
          }}
        />
        <RemoveRow
          label={`Remove ${label.toLowerCase()} ${index + 1}`}
          onClick={() => {
            onChange(replaced(rows, index, undefined));
          }}
        />
      </div>
    ))}
  </Rows>
);

/** The arguments of a stdio server, one input each. */
const ArgRows = ({
  rows,
  onChange,
}: {
  rows: ReadonlyArray<string>;
  onChange: (rows: ReadonlyArray<string>) => void;
}) => (
  <Rows
    addLabel="Add argument"
    onAdd={() => {
      onChange([...rows, ""]);
    }}
  >
    {rows.map((arg, index) => (
      // oxlint-disable-next-line react/no-array-index-key
      <div key={index} className="flex items-center gap-2">
        <Input
          aria-label={`Argument ${index + 1}`}
          value={arg}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => {
            onChange(replaced(rows, index, event.target.value));
          }}
        />
        <RemoveRow
          label={`Remove argument ${index + 1}`}
          onClick={() => {
            onChange(replaced(rows, index, undefined));
          }}
        />
      </div>
    ))}
  </Rows>
);

/** `toolExposure` as pattern → Exposure rows, free-typed, with `suggestions` of the tool names a discovered server has. */
export const ToolRows = ({
  rows,
  listId,
  disabled,
  hideOnly = false,
  onChange,
}: {
  rows: ReadonlyArray<McpToolRow>;
  /** The id of the datalist of tool names. */
  listId: string;
  disabled?: boolean | undefined;
  /** A Repo's server's: a tool may only be hidden (a row the Repo gave another Exposure shows it as it is). */
  hideOnly?: boolean | undefined;
  onChange: (rows: ReadonlyArray<McpToolRow>) => void;
}) => (
  <Rows
    addLabel="Add tool exposure"
    onAdd={() => {
      onChange([...rows, { pattern: "", exposure: "hidden" }]);
    }}
  >
    {rows.map((row, index) => (
      // oxlint-disable-next-line react/no-array-index-key
      <div key={index} className="flex items-center gap-2">
        <Input
          aria-label={`Tool exposure ${index + 1} pattern`}
          value={row.pattern}
          placeholder="delete_*"
          list={listId}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => {
            onChange(replaced(rows, index, { ...row, pattern: event.target.value }));
          }}
        />
        <ExposureSelect
          label={`Tool exposure ${index + 1} exposure`}
          value={row.exposure}
          options={hideOnly ? Arr.dedupe<Array<McpExposure>>(["hidden", row.exposure]) : undefined}
          disabled={disabled}
          onChange={(exposure) => {
            onChange(replaced(rows, index, { ...row, exposure }));
          }}
        />
        <RemoveRow
          label={`Remove tool exposure ${index + 1}`}
          onClick={() => {
            onChange(replaced(rows, index, undefined));
          }}
        />
      </div>
    ))}
  </Rows>
);

/** A datalist of options, which an input names in its `list`. */
const Suggestions = ({ id, options }: { id: string; options: ReadonlyArray<string> }) => (
  <datalist id={id}>
    {options.map((option) => (
      <option key={option} value={option} />
    ))}
  </datalist>
);

/** What a `${NAME}` may name at the Scope, said by name; never a value. */
const NamesHint = ({ names }: { names: McpReferenceNames | null }) =>
  names === null ? null : (
    <>
      Write <code>{"${NAME}"}</code> for a Secret or a Variable of this scope.{" "}
      {names.secrets.length === 0
        ? "No Secrets kept. "
        : `Secrets: ${Arr.join(names.secrets, ", ")}. `}
      {names.variables.length === 0
        ? "No Variables."
        : `Variables: ${Arr.join(names.variables, ", ")}.`}
    </>
  );

/** What the form says of the entry it makes: why it cannot be saved, and what to warn of. */
const Checks = ({
  id,
  problems,
  check,
}: {
  /** The id of the problems, which the Save button names in its `aria-describedby`. */
  id: string;
  problems: ReadonlyArray<string>;
  check: McpFormCheck;
}) => (
  <>
    <MessageList tone="problem" id={id} messages={problems} live />
    <MessageList tone="warning" messages={Arr.map(check.warnings, ({ message }) => message)} live />
    <MessageList tone="hint" messages={check.hints} small />
  </>
);

/** The panel's title for a form in `mode`, at an Environment or at Global. */
const titleOf = (draft: McpFormDraft, atGlobal: boolean): string => {
  switch (draft.mode) {
    case "add":
      return atGlobal ? "Add a server" : "Add a server to this environment";
    case "edit":
      return `Edit ${draft.fields.name}`;
    case "replace":
      return `Use ${draft.fields.name} in this environment on its own`;
    case "copy":
      return atGlobal
        ? `Copy ${draft.fields.name} from Repo ${draft.copiedFrom ?? ""} to Global`
        : `Copy ${draft.fields.name} from Repo ${draft.copiedFrom ?? ""} to this environment`;
  }
};

/** The form of an Add, an Edit, or a Global server copied as an Environment's own. */
export const McpFormPanel = ({
  scope,
  atGlobal,
  draft,
  view,
  references,
  tools,
}: {
  scope: string;
  atGlobal: boolean;
  draft: McpFormDraft;
  view: McpScopeView;
  references: McpReferencesState;
  /** The tool names of the server as its host discovered them, for suggestions. */
  tools: ReadonlyArray<string>;
}) => {
  const [, setPanel] = useAtom(mcpPanelAtom(scope));
  const [saved, save] = useAtom(saveMcpAtom(scope));
  const { fields } = draft;
  const jsonShown = draft.tab === "json";
  const namesList = `mcp-names-${scope}`;
  const toolsList = `mcp-tools-${scope}`;
  const busy = saved.waiting;
  const panelId = `mcp-tabpanel-${scope}`;
  const problemsId = `mcp-problems-${scope}`;
  const known = references.status === "ready" ? references.names : null;
  // At an Environment a `${NAME}` that nothing provides is refused, so Save waits for the names it is checked against.
  const held = !atGlobal && known === null;

  const read = jsonShown ? entryOfJson(draft.json) : Result.succeed(entryOfFields(fields));

  const check: McpFormCheck = Result.isSuccess(read)
    ? checkMcpEntry({
        name: fields.name,
        entry: read.success,
        rules: {
          names: view.names,
          atGlobal,
          editing: draft.mode === "add" || draft.mode === "copy" ? null : fields.name,
        },
        references: known,
      })
    : { entry: null, problems: [read.failure], warnings: [], hints: [] };

  const problems = [...(jsonShown ? [] : mcpFieldsProblems(fields)), ...check.problems];
  const entry = check.entry;

  const ready =
    entry !== null && problems.length === 0 && draft.jsonProblem === null && !busy && !held;

  const names = known === null ? [] : [...known.secrets, ...known.variables];
  const nameFixed = draft.mode !== "add";
  const keptKeys = Arr.map(Record.toEntries(fields.kept), ([key]) => key);

  const setFields = (next: Partial<McpFields>) => {
    setPanel({ ...draft, fields: { ...fields, ...next } });
  };

  const showTab = (tab: McpFormDraft["tab"]) => {
    setPanel(mcpFormShowing(draft, tab));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!ready) return;

    save({ kind: "put", name: fields.name, entry });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={titleOf(draft, atGlobal)}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{titleOf(draft, atGlobal)}</h3>
        <div role="tablist" aria-label="Edit as" className="flex gap-1">
          {(["form", "json"] as const).map((tab) => (
            <Button
              key={tab}
              type="button"
              role="tab"
              id={`mcp-tab-${scope}-${tab}`}
              aria-controls={panelId}
              aria-selected={draft.tab === tab}
              variant={draft.tab === tab ? "outline" : "ghost"}
              size="sm"
              onClick={() => {
                showTab(tab);
              }}
            >
              {tab === "form" ? "Form" : "JSON"}
            </Button>
          ))}
        </div>
      </div>
      {draft.mode === "replace" && (
        <p className="text-xs text-muted-foreground">
          A copy of Global's entry, kept as this environment's own: it replaces Global's here and
          stops following its changes. Its adjustments, if it has any, are dropped.
        </p>
      )}
      {draft.mode === "copy" && (
        <p className="text-xs text-muted-foreground">
          {atGlobal
            ? "A copy of the Repo's entry, kept Global and as copied: it stops following the Repo's commits and needs its own MCP sign-in. Every environment that follows Global gets it, and its ${NAME} values read each environment's Secrets as well as its Variables. Its working directory is the Repo's in this environment; check it fits every environment."
            : "A copy of the Repo's entry, kept as this environment's own and as copied: it hides the Repo's here, stops following its commits and needs its own MCP sign-in. Its ${NAME} values read this environment's Secrets as well as its Variables."}
        </p>
      )}
      {draft.mode === "add" && !atGlobal && Arr.contains(view.names.global, fields.name) && (
        <p className="text-xs text-muted-foreground">
          Global has a server of this name: this environment's own replaces it here.
        </p>
      )}
      <Field
        label="Name"
        htmlFor={`mcp-name-${scope}`}
        hint="Letters, digits, - and _; the model sees mcp__name__tool."
      >
        <Input
          id={`mcp-name-${scope}`}
          aria-describedby={noteId(`mcp-name-${scope}`)}
          value={fields.name}
          disabled={nameFixed}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="font-mono sm:max-w-80"
          onChange={(event) => {
            setFields({ name: event.target.value });
          }}
        />
      </Field>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`mcp-tab-${scope}-${draft.tab}`}
        className="flex flex-col gap-4"
      >
        {jsonShown ? (
          <Field
            label="Server as JSON"
            htmlFor={`mcp-json-${scope}`}
            hint="pi's shape: command, args, env, cwd, or url, headers, with enabled, exposure, toolExposure, timeout, description, sampling and oauth."
            problem={draft.jsonProblem}
          >
            <textarea
              id={`mcp-json-${scope}`}
              aria-describedby={noteId(`mcp-json-${scope}`)}
              rows={14}
              value={draft.json}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
              className={cn(CODE_AREA, "resize-y")}
              onChange={(event) => {
                setPanel({ ...draft, json: event.target.value, jsonProblem: null });
              }}
            />
          </Field>
        ) : (
          <>
            <Suggestions id={namesList} options={Arr.map(names, (name) => `\${${name}}`)} />
            <Suggestions id={toolsList} options={tools} />
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Runs as</legend>
              <div className="flex gap-4 text-sm">
                {(["http", "stdio"] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`mcp-kind-${scope}`}
                      checked={fields.kind === kind}
                      onChange={() => {
                        setFields({ kind });
                      }}
                    />
                    {kind === "http" ? "HTTP (a URL)" : "stdio (a command)"}
                  </label>
                ))}
              </div>
            </fieldset>
            {fields.kind === "stdio" ? (
              <>
                <Field
                  label="Command"
                  htmlFor={`mcp-command-${scope}`}
                  hint="Run without a shell, in the workspace's Container."
                >
                  <Input
                    id={`mcp-command-${scope}`}
                    aria-describedby={noteId(`mcp-command-${scope}`)}
                    value={fields.command}
                    placeholder="npx"
                    spellCheck={false}
                    autoComplete="off"
                    data-1p-ignore
                    className="font-mono"
                    onChange={(event) => {
                      setFields({ command: event.target.value });
                    }}
                  />
                </Field>
                <Field label="Arguments" htmlFor={`mcp-args-${scope}`} group>
                  <ArgRows
                    rows={fields.args}
                    onChange={(args) => {
                      setFields({ args });
                    }}
                  />
                </Field>
                <Field
                  label="Directory"
                  htmlFor={`mcp-cwd-${scope}`}
                  hint="An absolute path; empty for the session's default directory."
                >
                  <Input
                    id={`mcp-cwd-${scope}`}
                    aria-describedby={noteId(`mcp-cwd-${scope}`)}
                    value={fields.cwd}
                    placeholder="/workspace/app"
                    spellCheck={false}
                    autoComplete="off"
                    data-1p-ignore
                    className="font-mono"
                    onChange={(event) => {
                      setFields({ cwd: event.target.value });
                    }}
                  />
                </Field>
                <Field
                  label="Environment variables"
                  htmlFor={`mcp-env-${scope}`}
                  hint={<NamesHint names={known} />}
                  group
                >
                  <KeyValueRows
                    label="Environment variable"
                    rows={fields.env}
                    namesList={namesList}
                    onChange={(env) => {
                      setFields({ env });
                    }}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label="URL"
                  htmlFor={`mcp-url-${scope}`}
                  hint="cloudpid connects from its own servers, not from the Container."
                >
                  <Input
                    id={`mcp-url-${scope}`}
                    aria-describedby={noteId(`mcp-url-${scope}`)}
                    value={fields.url}
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                    autoComplete="off"
                    data-1p-ignore
                    className="font-mono"
                    onChange={(event) => {
                      setFields({ url: event.target.value });
                    }}
                  />
                </Field>
                <Field
                  label="Headers"
                  htmlFor={`mcp-headers-${scope}`}
                  hint={<NamesHint names={known} />}
                  group
                >
                  <KeyValueRows
                    label="Header"
                    rows={fields.headers}
                    namesList={namesList}
                    onChange={(headers) => {
                      setFields({ headers });
                    }}
                  />
                </Field>
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Timeout (seconds)" htmlFor={`mcp-timeout-${scope}`}>
                <Input
                  id={`mcp-timeout-${scope}`}
                  inputMode="decimal"
                  value={fields.timeout}
                  placeholder="60"
                  className="sm:max-w-48"
                  onChange={(event) => {
                    setFields({ timeout: event.target.value });
                  }}
                />
              </Field>
              <Field label="Exposure" htmlFor={`mcp-exposure-${scope}`}>
                <ExposureSelect
                  id={`mcp-exposure-${scope}`}
                  value={fields.exposure}
                  onChange={(exposure) => {
                    setFields({ exposure });
                  }}
                />
              </Field>
              <Field
                label="Model use"
                htmlFor={`mcp-sampling-${scope}`}
                hint={SAMPLING_HINTS[fields.sampling]}
              >
                <OptionSelect
                  id={`mcp-sampling-${scope}`}
                  options={MCP_SAMPLING}
                  labels={MCP_SAMPLING_LABELS}
                  value={fields.sampling}
                  describedBy={noteId(`mcp-sampling-${scope}`)}
                  onChange={(sampling) => {
                    setFields({ sampling });
                  }}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={fields.enabled}
                  onChange={(event) => {
                    setFields({ enabled: event.target.checked });
                  }}
                />
                Enabled
              </label>
            </div>
            <Field
              label="Description"
              htmlFor={`mcp-description-${scope}`}
              hint="Shown to the model with the server's name."
            >
              <textarea
                id={`mcp-description-${scope}`}
                aria-describedby={noteId(`mcp-description-${scope}`)}
                rows={2}
                value={fields.description}
                className={cn(CODE_AREA, "font-sans")}
                onChange={(event) => {
                  setFields({ description: event.target.value });
                }}
              />
            </Field>
            <Field
              label="Tool exposure"
              htmlFor={`mcp-tools-field-${scope}`}
              group
              hint={
                tools.length === 0
                  ? "A tool's name, or a * pattern: the first pattern that matches wins, an exact name before any pattern. Tool names are suggested once the server has been discovered."
                  : "A tool's name, or a * pattern: the first pattern that matches wins, an exact name before any pattern."
              }
            >
              <ToolRows
                rows={fields.toolExposure}
                listId={toolsList}
                onChange={(toolExposure) => {
                  setFields({ toolExposure });
                }}
              />
            </Field>
            {keptKeys.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Kept as they are, and editable in the JSON tab: {Arr.join(keptKeys, ", ")}.
              </p>
            )}
            <div id={SIGN_IN_SEAM}>
              {fields.kind === "http" && (
                <OauthDisclosure
                  scope={scope}
                  oauth={fields.oauth}
                  namesList={namesList}
                  referenceHint={<NamesHint names={known} />}
                  ignored={Arr.map(
                    Arr.filter(
                      Arr.map(Record.toEntries(fields.oauth.kept), ([key]) => key),
                      (key) => Arr.contains(["callbackPort", "callbackUrl"], key),
                    ),
                    (key) => `oauth.${key}`,
                  )}
                  onChange={(next) => {
                    setFields({ oauth: { ...fields.oauth, ...next } });
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
      {!atGlobal && <ReferencesNotice scope={scope} references={references} />}
      <Checks id={problemsId} problems={problems} check={check} />
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={!ready}
          aria-describedby={problems.length > 0 ? problemsId : undefined}
        >
          {busy ? "Saving…" : "Save server"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setPanel(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};

/** The editor of Global server `row`'s tool exposure at an Environment: an adjustment, written whole. */
export const McpToolsPanel = ({
  scope,
  draft,
  row,
  tools,
}: {
  scope: string;
  draft: McpToolsDraft;
  row: McpRow | null;
  tools: ReadonlyArray<string>;
}) => {
  const [, setPanel] = useAtom(mcpPanelAtom(scope));
  const [saved, save] = useAtom(saveMcpAtom(scope));
  const gone = row === null || !isFollowedRow(row);
  const busy = saved.waiting;
  const listId = `mcp-tools-${scope}`;
  const directory = row === null ? null : repoDirectoryOf(row);
  const base = directory === null ? "Global's" : `Repo ${directory}'s`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy || gone || row === null) return;

    // A Repo's server: what the owner adds to its file's rows, which are kept as they are.
    save(
      directory === null
        ? {
            kind: "toolExposure",
            name: draft.name,
            target: "adjustment",
            toolExposure: toolExposureOfRows(draft.rows),
          }
        : mcpRepoToolsChange(row, draft.rows),
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Tool exposure of ${draft.name}`}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <h3 className="text-sm font-semibold">Tool exposure of {draft.name}</h3>
      <p className="text-xs text-muted-foreground">
        Saved as this environment's own tool exposure for {draft.name}, over {base}
        {row?.adjusted.includes("toolExposure") === true ? "" : ", which it follows until you save"}
        . The first pattern that matches wins; an exact name goes before any pattern.
        {directory !== null && " A Repo's server can only have tools hidden here."}
      </p>
      <Suggestions id={listId} options={tools} />
      {draft.fixed.length > 0 && (
        <ul
          aria-label={`${draft.name}: tool exposure from the Repo`}
          className="flex flex-col gap-1 text-xs"
        >
          {draft.fixed.map((fixed) => (
            <li key={fixed.pattern} className="flex items-center gap-2 text-muted-foreground">
              <code className="font-mono">{fixed.pattern}</code>
              <span>{MCP_EXPOSURE_LABELS[fixed.exposure]}</span>
              <span>(from the Repo's file; not changed here)</span>
            </li>
          ))}
        </ul>
      )}
      <ToolRows
        rows={draft.rows}
        listId={listId}
        hideOnly={directory !== null}
        onChange={(rows) => {
          setPanel({ ...draft, rows });
        }}
      />
      {gone && (
        <p role="alert" className="text-sm text-destructive">
          {draft.name} is not one of {directory === null ? "Global's" : "a Repo's"} servers in this
          environment any more, so there is nothing to adjust: close this and look at the list
          again.
        </p>
      )}
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || gone}>
          {busy ? "Saving…" : "Save tool exposure"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setPanel(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};
