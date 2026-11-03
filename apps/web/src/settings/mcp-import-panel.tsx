// @effect-diagnostics preferEffectArray:off -- JSX lists of entries are native arrays.

// "Paste pi `mcpServers` JSON" (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): each
// entry of the pasted text with its problems before anything is saved; a name the Scope has already asks Replace or Skip
// (Skip until chosen); a top-level `autoEnableCodemode` is ignored with a hint.

import { useAtom } from "@effect/atom-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import { settingsPath } from "../router.ts";
import { AUTO_ENABLE_CODEMODE_HINT, mcpImportWrites, previewMcpImport } from "./mcp-import.ts";
import type { McpReferenceNames, McpScopeView } from "./mcp-model.ts";
import { type McpImportDraft, mcpPanelAtom, saveMcpAtom } from "./mcp-state.ts";
import { CODE_AREA, Field } from "./parts.tsx";

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
  references: McpReferenceNames | null;
}) => {
  const [, setPanel] = useAtom(mcpPanelAtom(scope));
  const [saved, save] = useAtom(saveMcpAtom(scope));
  const busy = saved.waiting;
  const preview = previewMcpImport(draft.text, { names: view.names, atGlobal }, references);
  const writes = mcpImportWrites(preview, draft.choices);

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
          {preview.hints.map((hint) => (
            <li key={hint}>
              {hint}
              {hint === AUTO_ENABLE_CODEMODE_HINT && (
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
              {entry.problems.length > 0 && (
                <ul role="alert" className="flex flex-col gap-0.5 text-xs text-destructive">
                  {entry.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              {entry.warnings.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-amber-600 dark:text-amber-400">
                  {entry.warnings.map(({ message }) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
              {entry.hints.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {entry.hints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
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
