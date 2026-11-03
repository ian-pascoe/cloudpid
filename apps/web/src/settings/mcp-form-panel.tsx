// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- JSX lists of rows are native arrays, and a builder of a draft is no combinator.

// The Add/Edit form of an MCP server, and the editor of a Global server's tool exposure at an Environment
// (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): stdio (command, args, `cwd`) or HTTP
// (`url`); `env` and `headers` rows hinting `${NAME}` with the Scope's Secret and Variable names (never a value) and
// warning of a credential-shaped literal; timeout, description, enabled, Exposure, "Model use" (`sampling`); `toolExposure`
// as pattern → Exposure rows, suggesting tool names once the server has been discovered; and a raw-JSON tab. The "Sign-in
// (OAuth)" disclosure's fields and controls are #469's: the form keeps an entry's `oauth` as it was (`McpFields.kept`), and
// `SIGN_IN_SEAM` marks where the disclosure goes.

import { decodeMcpServerValue, MCP_SAMPLING, type McpExposure } from "@cloudpid/config";
import { useAtom } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { Plus, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import {
  checkMcpEntry,
  emptyMcpFields,
  entryOfFields,
  entryOfJson,
  fieldsOfEntry,
  jsonOfEntry,
  type McpFields,
  type McpFormCheck,
  type McpKeyValue,
  mcpFieldsProblems,
  type McpToolRow,
  MCP_EXPOSURE_LABELS,
  MCP_EXPOSURE_OPTIONS,
  MCP_SAMPLING_LABELS,
  rowsOfToolExposure,
  toolExposureOfRows,
} from "./mcp-form.ts";
import type { McpReferenceNames, McpRow, McpScopeView } from "./mcp-model.ts";
import { type McpFormDraft, mcpPanelAtom, type McpToolsDraft, saveMcpAtom } from "./mcp-state.ts";
import { CODE_AREA, Field } from "./parts.tsx";

/** Where the "Sign-in (OAuth)" disclosure goes: its state and controls are #469's. */
export const SIGN_IN_SEAM = "sign-in";

/** What each "Model use" answer lets the server do. */
const SAMPLING_HINTS: Readonly<Record<(typeof MCP_SAMPLING)[number], string>> = {
  ask: "The server asks you each time it wants a model's reply.",
  allow: "The server may use your models without asking.",
  off: "The server's requests for a model's reply are refused.",
};

const asExposure = (value: string): McpExposure | undefined =>
  Option.getOrUndefined(Arr.findFirst(MCP_EXPOSURE_OPTIONS, (known) => known === value));

/** A select of the four Exposures. */
export const ExposureSelect = ({
  id,
  label,
  value,
  disabled,
  className,
  onChange,
}: {
  id?: string | undefined;
  label?: string | undefined;
  value: McpExposure;
  disabled?: boolean | undefined;
  className?: string | undefined;
  onChange: (exposure: McpExposure) => void;
}) => (
  <NativeSelect
    id={id}
    aria-label={label}
    value={value}
    disabled={disabled}
    className={className}
    onChange={(event) => {
      const picked = asExposure(event.target.value);

      if (picked !== undefined) onChange(picked);
    }}
  >
    {MCP_EXPOSURE_OPTIONS.map((exposure) => (
      <option key={exposure} value={exposure}>
        {MCP_EXPOSURE_LABELS[exposure]}
      </option>
    ))}
  </NativeSelect>
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
  onChange,
}: {
  rows: ReadonlyArray<McpToolRow>;
  /** The id of the datalist of tool names. */
  listId: string;
  disabled?: boolean | undefined;
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
const Checks = ({ problems, check }: { problems: ReadonlyArray<string>; check: McpFormCheck }) => (
  <>
    {problems.length > 0 && (
      <ul role="alert" className="flex flex-col gap-1 text-sm text-destructive">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    )}
    {check.warnings.length > 0 && (
      <ul role="status" className="flex flex-col gap-1 text-sm text-amber-600 dark:text-amber-400">
        {check.warnings.map(({ message }) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    )}
    {check.hints.length > 0 && (
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {check.hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    )}
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
  references: McpReferenceNames | null;
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

  const read = jsonShown ? entryOfJson(draft.json) : Result.succeed(entryOfFields(fields));

  const check: McpFormCheck = Result.isSuccess(read)
    ? checkMcpEntry({
        name: fields.name,
        entry: read.success,
        rules: {
          names: view.names,
          atGlobal,
          editing: draft.mode === "add" ? null : fields.name,
        },
        references,
      })
    : { entry: null, problems: [read.failure], warnings: [], hints: [] };

  const problems = [...(jsonShown ? [] : mcpFieldsProblems(fields)), ...check.problems];
  const entry = check.entry;
  const ready = entry !== null && problems.length === 0 && draft.jsonProblem === null && !busy;
  const names = references === null ? [] : [...references.secrets, ...references.variables];
  const nameFixed = draft.mode !== "add";
  const keptKeys = Arr.map(Record.toEntries(fields.kept), ([key]) => key);

  const setFields = (next: Partial<McpFields>) => {
    setPanel({ ...draft, fields: { ...fields, ...next } });
  };

  const showTab = (tab: "form" | "json") => {
    if (tab === draft.tab) return;

    if (tab === "json") {
      setPanel({ ...draft, tab, json: jsonOfEntry(entryOfFields(fields)), jsonProblem: null });

      return;
    }

    const parsed = entryOfJson(draft.json);

    if (Result.isFailure(parsed)) {
      setPanel({ ...draft, jsonProblem: parsed.failure });

      return;
    }

    const decoded = decodeMcpServerValue(parsed.success);

    if (Result.isFailure(decoded)) {
      setPanel({
        ...draft,
        jsonProblem: `The form cannot show it until it is fixed: ${Arr.join(
          Arr.map(decoded.failure, (problem) => problem.line),
          "; ",
        )}`,
      });

      return;
    }

    setPanel({
      ...draft,
      tab,
      fields: fieldsOfEntry(fields.name, parsed.success),
      jsonProblem: null,
    });
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
      {jsonShown ? (
        <Field
          label="Server as JSON"
          htmlFor={`mcp-json-${scope}`}
          hint="pi's shape: command, args, env, cwd, or url, headers, with enabled, exposure, toolExposure, timeout, description, sampling and oauth."
          problem={draft.jsonProblem}
        >
          <textarea
            id={`mcp-json-${scope}`}
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
              <Field label="Arguments" htmlFor={`mcp-args-${scope}`}>
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
                hint={<NamesHint names={references} />}
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
                hint={<NamesHint names={references} />}
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
              <NativeSelect
                id={`mcp-sampling-${scope}`}
                value={fields.sampling}
                onChange={(event) => {
                  const picked = Option.getOrUndefined(
                    Arr.findFirst(MCP_SAMPLING, (known) => known === event.target.value),
                  );

                  if (picked !== undefined) setFields({ sampling: picked });
                }}
              >
                {MCP_SAMPLING.map((answer) => (
                  <option key={answer} value={answer}>
                    {MCP_SAMPLING_LABELS[answer]}
                  </option>
                ))}
              </NativeSelect>
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
            <p id={SIGN_IN_SEAM} className="text-xs text-muted-foreground">
              Kept as they are, and editable in the JSON tab: {Arr.join(keptKeys, ", ")}.
            </p>
          )}
        </>
      )}
      <Checks problems={problems} check={check} />
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!ready}>
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

/** What a form of mode `mode` starts from: empty fields for an Add, or the entry `written` of server `name`. */
export const newMcpForm = (
  mode: McpFormDraft["mode"],
  name: string,
  written: Parameters<typeof fieldsOfEntry>[1] | null,
): McpFormDraft => ({
  kind: "form",
  mode,
  fields: written === null ? emptyMcpFields() : fieldsOfEntry(name, written),
  tab: "form",
  json: "",
  jsonProblem: null,
});

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
  const busy = saved.waiting;
  const listId = `mcp-tools-${scope}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!busy)
      save({
        kind: "toolExposure",
        name: draft.name,
        toolExposure: toolExposureOfRows(draft.rows),
      });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Tool exposure of ${draft.name}`}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <h3 className="text-sm font-semibold">Tool exposure of {draft.name}</h3>
      <p className="text-xs text-muted-foreground">
        Saved as this environment's own tool exposure for {draft.name}, over Global's
        {row?.adjusted.includes("toolExposure") === true ? "" : ", which it follows until you save"}
        . The first pattern that matches wins; an exact name goes before any pattern.
      </p>
      <Suggestions id={listId} options={tools} />
      <ToolRows
        rows={draft.rows}
        listId={listId}
        onChange={(rows) => {
          setPanel({ ...draft, rows });
        }}
      />
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>
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

/** The rows a tool exposure editor starts from: the exposure in force. */
export const toolsDraftOf = (row: McpRow): McpToolsDraft => ({
  kind: "tools",
  name: row.name,
  rows: rowsOfToolExposure(row.server.toolExposure),
});
