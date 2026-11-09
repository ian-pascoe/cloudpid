// @effect-diagnostics preferEffectArray:off -- JSX lists of entries are native arrays.

// "Paste pi `mcpServers` JSON" (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): each
// entry of the pasted text with its problems before anything is saved; a name the Scope has already asks Replace or Skip
// (Skip until chosen); a top-level `autoEnableCodemode` is ignored with a hint.

import { settingsPath } from "@cloudpid/protocol";
import { useAtom } from "@effect/atom-react";
import * as Arr from "effect/Array";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import { type McpImportDraft, mcpImportWrites, previewMcpImport } from "./mcp-import.ts";
import type { McpScopeView } from "./mcp-model.ts";
import { MessageList, ReferencesNotice } from "./mcp-parts.tsx";
import { type McpReferencesState, mcpPanelAtom, saveMcpAtom } from "./mcp-state.ts";
import { CODE_AREA, Field, noteId } from "./parts.tsx";

/** The import: a text box for pi's JSON, and under it each entry it holds, as it would be saved. */
export const McpImportPanel = ({
  scope,
  atGlobal,
  draft,
  view,
  references,
}: {
  scope: string;
  atGlobal: boolean;
  draft: McpImportDraft;
  view: McpScopeView;
  references: McpReferencesState;
}) => {
  const [, setPanel] = useAtom(mcpPanelAtom(scope));
  const [saved, save] = useAtom(saveMcpAtom(scope));
  const busy = saved.waiting;
  const known = references.status === "ready" ? references.names : null;
  // At an Environment a `${NAME}` that nothing provides is refused, so the import waits for the names it is checked against.
  const held = !atGlobal && known === null;
  const preview = previewMcpImport(draft.text, { names: view.names, atGlobal }, known);
  const writes = held ? [] : mcpImportWrites(preview, draft.choices);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (writes.length === 0 || busy) return;

    save({ kind: "import", entries: writes });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Import servers"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <h3 className="text-sm font-semibold">Paste pi mcpServers JSON</h3>
      <Field
        label="JSON"
        htmlFor={`mcp-import-${scope}`}
        problem={preview.problem}
        hint="The mcpServers object of a pi settings or mcp.json file."
      >
        <textarea
          id={`mcp-import-${scope}`}
          aria-describedby={noteId(`mcp-import-${scope}`)}
          rows={10}
          value={draft.text}
          placeholder={
            '{\n  "mcpServers": {\n    "linear": { "url": "https://mcp.linear.app/mcp" }\n  }\n}'
          }
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          aria-invalid={preview.problem !== null}
          className={cn(CODE_AREA, "resize-y")}
          onChange={(event) => {
            setPanel({ ...draft, text: event.target.value });
          }}
        />
      </Field>
      {preview.hints.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {preview.hints.map(({ text, link }) => (
            <li key={text}>
              {text}
              {link === "tools" && (
                <>
                  {" "}
                  <InAppLink
                    href={settingsPath(scope, "tools")}
                    className="text-foreground underline underline-offset-2"
                  >
                    Offered tools
                  </InAppLink>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!atGlobal && <ReferencesNotice scope={scope} references={references} />}
      {preview.entries.length > 0 && (
        <ul aria-label="Entries to import" className="flex flex-col divide-y">
          {preview.entries.map((entry) => (
            <li key={entry.name} className="flex flex-col gap-1.5 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-sm font-medium break-all">{entry.name}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.problems.length > 0
                    ? "Not imported"
                    : entry.conflict
                      ? "Already here"
                      : entry.replacesGlobal
                        ? "New here, replaces Global's"
                        : "New"}
                </span>
              </div>
              <MessageList tone="problem" messages={entry.problems} small />
              <MessageList
                tone="warning"
                messages={Arr.map(entry.warnings, ({ message }) => message)}
                small
              />
              <MessageList tone="hint" messages={entry.hints} small />
              {entry.conflict && entry.problems.length === 0 && (
                <fieldset className="flex gap-4 text-sm">
                  <legend className="sr-only">{entry.name} is already here</legend>
                  {(["skip", "replace"] as const).map((choice) => (
                    <label key={choice} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`mcp-import-${scope}-${entry.name}`}
                        checked={(draft.choices[entry.name] ?? "skip") === choice}
                        onChange={() => {
                          setPanel({
                            ...draft,
                            choices: { ...draft.choices, [entry.name]: choice },
                          });
                        }}
                      />
                      {choice === "skip" ? "Skip" : "Replace"}
                    </label>
                  ))}
                </fieldset>
              )}
            </li>
          ))}
        </ul>
      )}
      <DialogProblem problem={settledFailureOf(saved)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={writes.length === 0 || busy}>
          {busy
            ? "Importing…"
            : writes.length === 0
              ? "Import"
              : `Import ${writes.length} ${writes.length === 1 ? "server" : "servers"}`}
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
