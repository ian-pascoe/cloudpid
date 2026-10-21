# What do `edit` and `write` calls record for a per-call diff?

Research for ticket #100 (map #99). Sources: pi-durable `1.3.0`, as `pnpm-lock.yaml` pins it, read from
`earendil-works/pi` at commit `bd3c9b8` (`packages/durable/package.json` says `1.3.0`; paths below are in
`packages/durable/src/`), and cloudpid at `3c3ab8b`.

## Answer

- **`edit`: yes, already enough, for a call the model made directly.** Its result `details` is
  `{ diff, patch, firstChangedLine? }`. `patch` is a standard unified diff (4 lines of context) whose `@@ -a,b +c,d @@`
  headers carry real old/new line numbers; `diff` is a line-numbered display string. `details` is stored in the
  `pi.tool-result` entry, so it reaches the web app in the snapshot and in live events. `@pierre/diffs` can take
  `patch`. cloudpid's web app receives it already (`TranscriptPart` `tool-result.details`) and ignores it today
  (`resolveCall` only reads `details` for `codemode`/`subagent`). The server captures nothing new.
- **`write`: no.** It records no `details` and never reads the file it overwrites. Its arguments hold the new content
  only. A create can be shown as an all-added diff from the arguments; an overwrite cannot be shown faithfully.
  The narrowest hook is a wrapper around `createWriteTool()` in `packages/extensions/src/coding-tools.ts` that reads the
  previous text through `api.env` first and puts a patch (or `created: true`) in `details`.
- **Inside `codemode`: not recoverable after the fact.** Live, a nested call's full args and (for `edit`) its
  `details` pass over the socket, but cloudpid's reducer drops the details; the persisted record keeps only args cut to
  200 characters and no details. Showing nested diffs needs a capture step (below), and since the wrapper above runs for
  nested calls too, the same wrapper is the place to do it.
- Recommendation: make the `edit` card read `details.patch` now; add the `write` wrapper; decide nested persistence
  separately (open question 1). Storage cost of the `write` wrapper is small (below).

## Findings

### `edit`

- Arguments: `{ path, edits: [{ oldText, newText }] }` (`tools/edit.ts` L19-33). `prepareArguments` repairs odd shapes
  (string `edits`, top-level `oldText`/`newText`), so the recorded arguments are the repaired ones only if the
  harness stores the repaired form; the diff does not depend on them.
- Result `details` (`tools/edit.ts` L73-77, L127-138):
  ```ts
  type EditToolDetails = { diff: string; patch: string; firstChangedLine?: number };
  ```
  `patch = generateUnifiedPatch(path, baseContent, newContent)`, i.e. `Diff.createTwoFilesPatch(path, path, old, new, …,
  { context: 4, headerOptions: FILE_HEADERS_ONLY })` (`tools/edit-diff.ts` L366-371). So it has `---`/`+++` headers
  with the path and ordinary hunks: line numbers are real, and old/new sides are both present. `diff` is
  `+NN text` / `-NN text` / ` NN text` lines with `...` gaps (`edit-diff.ts` L377-); `firstChangedLine` is in the new
  file.
- Caveats for faithfulness (`tools/edit.ts` L116-127, `edit-diff.ts` L297-362):
  - the diff is computed on LF-normalised text with the BOM stripped; the file is written back with its original line
    endings and BOM, so a CRLF file's patch shows LF lines;
  - if any `oldText` needed a fuzzy match, the replacement runs in fuzzy-normalised content space, so `newContent`
    (and thus the patch) can include incidental normalisation elsewhere in the file (e.g. quotes, trailing whitespace).
    That is what was written, so the diff is faithful to the file, not only to the model's intent;
  - the context is fixed at 4 lines; more context needs the file.
- **How it reaches the client.** The tool task appends the result with `details` into the message
  (`harness/tool.ts` `appendToolResult` L890-910: `...(result.details === undefined ? {} : { details })`). The snapshot
  returns entries, and live events are `entry_appended`/`tool_execution_end{entry}` carrying the same entry.
  cloudpid passes pi's `AgentEvent`s through unchanged (`packages/protocol/src/session.ts`, `AgentEventSchema`), and
  `projectMessage` keeps `details` on the `tool-result` part (`packages/protocol/src/transcript.ts` L60, L140). So
  after a reload and live, the same `details` arrives. In the card, `thread-messages.ts` `resolveCall` (L108-146) keeps
  only the result text plus `nested`/`subagent`/`images` artifacts; the card's "Result" is "Successfully replaced N
  block(s) in path." (`edit.ts` L136).
- **Local pi's edit tool.** Same shape: `EditToolDetails { diff, patch, firstChangedLine }`
  (`packages/coding-agent/src/core/tools/edit.ts` L70-74, L201-210 at `bd3c9b8`). pi-durable's is a port; the
  coding-agent version additionally renders in a TUI. No difference in the recorded data that matters here.

### `write`

- Arguments `{ path, content }` (`tools/write.ts` L9-12). `execute` resolves the path, then calls
  `env.writeFile(absolutePath, content)` inside the file mutation queue and returns only
  `Successfully wrote to ${path}` (L22-36). No `details`; no read of the existing file; no create-or-overwrite
  indication. Local pi's `write` also returns `details: undefined` (`coding-agent/.../write.ts` L87).
- So the record can say what the file became, not what it was. An overwrite diff needs the old content at call time.

### Nested in `codemode`

- A script's `tools.edit(...)` runs the same registered tool as a nested call (`harness/tool.ts` L640-720), so the
  same `details` are produced.
- Live events: `tool_execution_start{args, parentToolCallId}` has the full arguments; `tool_execution_end{result,
  parentToolCallId}` has a `NestedToolExecutionResult` including `details` (`harness/events.ts` L71-85;
  `harness/types.ts` L181-198; the result comes from the caller's `NestedCallDoc`, `events.ts` L240-255).
  cloudpid's reducer keeps only `isError`, `durationMs` and error text of that result and clears the nested calls at the
  parent's end (`packages/protocol/src/view.ts` L364-395). So the diff is delivered live and dropped by the client.
- Snapshot while running: a nested slot has `arguments` and, once done, a `summary` of `{ isError, durationMs, usage,
  error }` only; "the result itself is in the caller's `NestedCallDoc`" (`harness/live.ts` L41-60), which "retires with
  the caller" (`harness/tool.ts` L101-107). So no details after the call is over.
- After the codemode call ends, its own result `details` is `{ calls: [{ id, name, args, status, durationMs?, error? }],
  fullOutputPath? }` where `args` is compact JSON cut to 200 characters (`codemode/codemode.ts` L173-199, `ARGS_PREVIEW_CHARS =
  200`). cloudpid reads exactly that (`apps/web/src/chat/nested-calls.ts` `settledCalls`). A nested `write` with a long
  `content` or an `edit` with long `oldText`/`newText` is therefore cut, and there is no diff.
- Consequence: nested calls cannot be given a diff from the stored transcript. Only a capture at execution time can.

### If the record is not enough: hooks and cost

1. **Tool wrapper in `coding-tools.ts`** (narrowest). The file already wraps `bash` with `defineTool({ ...base, execute })`
   and uses `api.env` (`packages/extensions/src/coding-tools.ts`). Do the same for `write`: inside `execute`, read the
   old text with `api.env.readTextFile` (result is `Result<string, FileError>`; missing file → created), delegate to
   `createWriteTool().execute`, and return its result plus `details`. Because nested calls run the same registration,
   it also covers `tools.write(...)` in a script. For `edit` nothing is needed. Differences to note: `write` skips the
   BOM/line-ending normalisation `edit` does; treat text as-is, and that a read can fail or the file be binary
   (skip, `details: { binary: true }`).
   - What to record: a unified patch via `diff` (a dependency of pi-durable, `package.json` L158 `"diff": "8.0.4"`;
     `generateUnifiedPatch` is **not** exported from `@earendil-works/pi-durable/tools`, `tools/index.ts`, so
     cloudpid would add `diff` itself or copy the six-line helper) with the same 4 context lines, or `{ created: true }`
     for a new file.
2. **`ExecutionEnv` wrapper** (`packages/computer-env/src/env.ts` `writeFile`, L194-207): sees every write including
   `bash`-free ones from `edit`/`write`, but has no call ID (it gets a `Context`), so tying a diff to a card is harder;
   and `bash`/Container writes bypass it anyway. Broader than needed.
3. **Per-call snapshots outside the transcript** (Container git, working tree) don't give a per-call diff.

**Storage cost.** `details` rides in the `pi.tool-result` entry in the Session's history. `edit` already stores
`diff` + `patch`, each about the changed text plus 4 lines of context per hunk, so about twice the edit plus overhead,
no whole-file copy. A `write` patch for a new file need not be stored (the arguments hold the content: `{ created: true }`
is a few bytes); for an overwrite it is the changed hunks plus context, and in the worst case (a full rewrite) about
old plus new size. Storing the whole old content instead would cost the file size per overwrite.
Neither goes to the model if toolResult `details` are not rendered into the request, which I did not verify in
the provider path.

## Open questions

1. **Nested persistence.** To show diffs for `edit`/`write` made by a script after the run: either keep `details` in
   cloudpid's reducer while the run lasts (live only, lost on reload), or persist them outside the cut `calls` list.
   Candidates: an extension entry written by the wrapper keyed by the nested call ID (`<callId>/c<id>`), or an
   `afterTool` hook on the parent (cloudpid already uses `afterTool` hooks in `secrets/extension.ts` and
   `todo/projection.ts`) copying the nested details into the parent's result details. Not prototyped; the API for
   writing an entry from a nested tool's `api` was not checked.
2. Does `details` count against the model's context? The `toolResult` message holds it, but I did not trace the
   provider request path to confirm `details` is excluded.
3. Is a diff for a `write` that overwrote a very large or binary file worth capturing (size cap)? Ties to the map's
   "big and noisy diffs" item.
4. Writes by `bash` or from the Container are not recorded by either tool; that is Changes' job (#99), not this
   record's.
