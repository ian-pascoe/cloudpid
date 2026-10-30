/* oxlint-disable -- PROTOTYPE: throwaway code, never merged */
/**
 * PROTOTYPE (throwaway, branch `prototype/384-mcp-app`): where an MCP App's View lives in the Session page, for
 * https://github.com/ian-pascoe/cloudpid/issues/384. Three variants on `/prototype/mcp-app?variant=A|B|C`:
 *
 * - A. Inline card: every View is live in its tool call's card; a View's fullscreen request opens it in a Pane.
 * - B. Pane-first: the card is a chip; Views live in `app:<callId>` Panes; a new App result opens its Pane.
 * - C. Latest-live hybrid: only the newest View is live inline; older ones collapse to a summary; "Pop out" → Pane.
 *
 * The state panel on the right shows the bridge log and what the model would see at the next request.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader,
  Maximize2,
  RotateCcw,
  Smartphone,
  X,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import { AppFrame, type DisplayMode } from "./app-frame.tsx";
import {
  agentCallsApp,
  closePane,
  log,
  openPane,
  reset,
  sendOwnerMessage,
  setState,
  useStore,
  type Entry,
  type State,
  type ToolEntry,
} from "./store.ts";

type Variant = "A" | "B" | "C";

const VARIANTS: readonly { key: Variant; name: string; rules: string }[] = [
  {
    key: "A",
    name: "Inline card",
    rules:
      "Every View is live inside its tool call's card and grows with size-changed (≤420px). Only the View's own fullscreen request moves it to a Pane; exiting returns it inline. Moving it remounts it.",
  },
  {
    key: "B",
    name: "Pane-first",
    rules:
      "The card shows a chip. Each View lives in an app:<callId> Pane (like a Live View). A new App result opens its Pane. Inline display is refused.",
  },
  {
    key: "C",
    name: "Latest-live hybrid",
    rules:
      "Only the newest App call's View is live inline. Older ones collapse to a summary (their model context, else the result text) with Reopen. Pop out or fullscreen → Pane.",
  },
];

const variantOf = (): Variant => {
  const found = new URLSearchParams(window.location.search).get("variant");
  return found === "B" || found === "C" ? found : "A";
};

const appCalls = (state: State): ToolEntry[] =>
  state.transcript.filter((entry): entry is ToolEntry => entry.kind === "tool");

const latestAppCall = (state: State): string | undefined => appCalls(state).at(-1)?.id;

const inPane = (state: State, callId: string) => state.panes.includes(`app:${callId}`);

// --- The card -------------------------------------------------------------------------------------------------------

const CardHeader = ({ entry, children }: { entry: ToolEntry; children?: ReactNode }) => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground">
    {entry.result === undefined ? (
      <Loader className="size-3.5 motion-safe:animate-spin" />
    ) : (
      <Check className="size-3.5 text-success" />
    )}
    <span className="font-mono text-[0.8125rem] text-foreground">{entry.tool}</span>
    <span className="font-mono">{JSON.stringify(entry.args)}</span>
    <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.6875rem]">
      <AppWindow className="size-3" /> App · {entry.title}
    </span>
    <span className="ml-auto flex items-center gap-1">{children}</span>
  </div>
);

const CardDetails = ({ entry, state }: { entry: ToolEntry; state: State }) => (
  <details className="mt-1 text-xs text-muted-foreground">
    <summary className="cursor-pointer select-none">
      Arguments, result{entry.appCalls.length > 0 && `, ${entry.appCalls.length} app calls`}
      {state.modelContext[entry.id] !== undefined && ", app context"}
    </summary>
    <pre className="mt-1 rounded bg-muted p-2 whitespace-pre-wrap">
      {`Arguments: ${JSON.stringify(entry.args)}\nResult (to the model): ${entry.result?.text ?? "…"}`}
    </pre>
    {entry.appCalls.length > 0 && (
      <ul className="mt-1 space-y-0.5 font-mono">
        {entry.appCalls.map((call, index) => (
          <li key={index}>
            ↳ View called {call.name}({JSON.stringify(call.args)}) → {call.text}
          </li>
        ))}
      </ul>
    )}
    {state.modelContext[entry.id] !== undefined && (
      <p className="mt-1">App context for the model: “{state.modelContext[entry.id]?.text}”</p>
    )}
  </details>
);

const IconButton = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent"
  >
    {children}
  </button>
);

/** Fullscreen in the inline variants means the Pane; inline means back in the card. */
const paneDisplay =
  (callId: string) =>
  (mode: DisplayMode): DisplayMode => {
    if (mode === "fullscreen") openPane(callId);
    else closePane(`app:${callId}`);
    return mode;
  };

const CardA = ({ entry, state }: { entry: ToolEntry; state: State }) => (
  <div className="my-2 rounded-lg border p-2">
    <CardHeader entry={entry} />
    <div className="mt-2">
      {inPane(state, entry.id) ? (
        <ShownInPane callId={entry.id} />
      ) : (
        <AppFrame
          key={`${entry.id}:${state.epoch}`}
          callId={entry.id}
          displayMode="inline"
          onDisplayMode={paneDisplay(entry.id)}
        />
      )}
    </div>
    <CardDetails entry={entry} state={state} />
  </div>
);

const ShownInPane = ({ callId }: { callId: string }) => (
  <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
    <AppWindow className="size-4" /> Shown in a Pane.
    <IconButton onClick={() => openPane(callId)} title="Show the Pane">
      Show
    </IconButton>
    <IconButton onClick={() => closePane(`app:${callId}`)} title="Back in the card">
      Back in the card
    </IconButton>
  </div>
);

const CardB = ({ entry, state }: { entry: ToolEntry; state: State }) => (
  <div className="my-2 rounded-lg border p-2">
    <CardHeader entry={entry}>
      <IconButton onClick={() => openPane(entry.id)} title="Open the app in a Pane">
        <AppWindow className="size-3" />
        {inPane(state, entry.id)
          ? state.shownPane === `app:${entry.id}`
            ? "Showing"
            : "Show"
          : "Open app"}
      </IconButton>
    </CardHeader>
    <CardDetails entry={entry} state={state} />
  </div>
);

const CardC = ({ entry, state }: { entry: ToolEntry; state: State }) => {
  const latest = latestAppCall(state) === entry.id;
  const live = latest || state.reopened.includes(entry.id);
  const summary = state.modelContext[entry.id]?.text ?? entry.result?.text ?? "Running…";

  return (
    <div className="my-2 rounded-lg border p-2">
      <CardHeader entry={entry}>
        {live && !inPane(state, entry.id) && (
          <IconButton onClick={() => openPane(entry.id)} title="Pop out to a Pane">
            <Maximize2 className="size-3" /> Pop out
          </IconButton>
        )}
        {!latest && live && (
          <IconButton
            onClick={() =>
              setState((current) => ({
                ...current,
                reopened: current.reopened.filter((id) => id !== entry.id),
              }))
            }
            title="Collapse"
          >
            Collapse
          </IconButton>
        )}
      </CardHeader>
      <div className="mt-2">
        {inPane(state, entry.id) ? (
          <ShownInPane callId={entry.id} />
        ) : live ? (
          <AppFrame
            key={`${entry.id}:${state.epoch}`}
            callId={entry.id}
            displayMode="inline"
            onDisplayMode={paneDisplay(entry.id)}
          />
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-muted p-2 text-xs">
            <AppWindow className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">{summary}</span>
            <IconButton
              onClick={() =>
                setState((current) => ({ ...current, reopened: [...current.reopened, entry.id] }))
              }
              title="Reopen the app (it starts again from the tool result)"
            >
              <RotateCcw className="size-3" /> Reopen
            </IconButton>
          </div>
        )}
      </div>
      <CardDetails entry={entry} state={state} />
    </div>
  );
};

// --- The transcript, composer and Pane area -------------------------------------------------------------------------

const EntryView = ({ entry, state, variant }: { entry: Entry; state: State; variant: Variant }) => {
  if (entry.kind === "owner")
    return (
      <div className="my-3 ml-auto max-w-[85%] rounded-2xl bg-muted px-3 py-2 text-sm">
        {entry.via !== undefined && (
          <div className="mb-1 inline-flex items-center gap-1 rounded-full border bg-background px-1.5 text-[0.6875rem] text-muted-foreground">
            <AppWindow className="size-3" /> sent from the {entry.via}
          </div>
        )}
        <div>{entry.text}</div>
      </div>
    );

  if (entry.kind === "assistant") return <p className="my-2 text-sm">{entry.text}</p>;

  if (variant === "A") return <CardA entry={entry} state={state} />;
  if (variant === "B") return <CardB entry={entry} state={state} />;
  return <CardC entry={entry} state={state} />;
};

const Composer = ({ state }: { state: State }) => {
  const [text, setText] = useState("");
  const shown = state.draft?.text ?? text;

  return (
    <div className="border-t p-2">
      {state.draft !== undefined && (
        <div className="mb-1 flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
          <AppWindow className="size-3" /> Draft from the {state.draft.via}: send it, edit it, or
          discard it.
          <button
            type="button"
            className="ml-auto underline"
            onClick={() => setState((current) => ({ ...current, draft: undefined }))}
          >
            Discard
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          rows={2}
          value={shown}
          onChange={(event) => {
            if (state.draft !== undefined)
              setState((current) => ({
                ...current,
                draft: current.draft && { ...current.draft, text: event.target.value },
              }));
            else setText(event.target.value);
          }}
          placeholder="Message the agent…"
          className="min-w-0 flex-1 resize-none rounded-md border bg-background p-2 text-sm"
        />
        <button
          type="button"
          disabled={shown.trim() === ""}
          onClick={() => {
            sendOwnerMessage(shown, state.draft?.via);
            setText("");
          }}
          className="rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
};

const PaneArea = ({ state, variant }: { state: State; variant: Variant }) => {
  const shown = state.shownPane;
  if (shown === undefined) return null;
  const callId = shown.slice("app:".length);
  const entry = appCalls(state).find((found) => found.id === callId);

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col bg-background",
        state.phone ? "absolute inset-0 z-10" : "w-[48%] border-l",
      )}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        {state.panes.map((key) => {
          const id = key.slice("app:".length);
          const pane = appCalls(state).find((found) => found.id === id);
          return (
            <button
              type="button"
              key={key}
              onClick={() => setState((current) => ({ ...current, shownPane: key }))}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1",
                key === shown ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              <AppWindow className="size-3" />
              {pane?.server} · {pane?.title} ({String(pane?.args.flight ?? pane?.args.range)})
              <X
                className="size-3"
                onClick={(event) => {
                  event.stopPropagation();
                  closePane(key);
                }}
              />
            </button>
          );
        })}
        {state.phone && (
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-muted-foreground"
            onClick={() => setState((current) => ({ ...current, shownPane: undefined }))}
          >
            Back to chat
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 p-2">
        {entry !== undefined && (
          <AppFrame
            key={`${callId}:pane:${state.epoch}`}
            callId={callId}
            displayMode="fullscreen"
            fill
            onDisplayMode={(mode) => {
              if (mode === "fullscreen") return "fullscreen";
              if (variant === "B") return "fullscreen";
              closePane(shown);
              return "inline";
            }}
          />
        )}
      </div>
    </section>
  );
};

const SessionMock = ({ state, variant }: { state: State; variant: Variant }) => {
  // B: a new App result opens its Pane.
  const resolved = appCalls(state)
    .filter((entry) => entry.result !== undefined)
    .map((entry) => entry.id)
    .join(",");
  useEffect(() => {
    if (variant !== "B") return;
    const latest = appCalls(state)
      .filter((entry) => entry.result !== undefined)
      .at(-1);
    if (latest !== undefined) openPane(latest.id);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, variant]);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-medium">Trip planning</span>
        <span className="text-xs text-muted-foreground">· Staging environment</span>
        {state.phone && state.panes.length > 0 && state.shownPane === undefined && (
          <button
            type="button"
            className="ml-auto flex items-center gap-1 rounded border px-2 py-0.5 text-xs"
            onClick={() => setState((current) => ({ ...current, shownPane: current.panes.at(-1) }))}
          >
            <AppWindow className="size-3" /> {state.panes.length} Pane
            {state.panes.length > 1 && "s"}
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
            {state.transcript.map((entry) => (
              <EntryView key={entry.id} entry={entry} state={state} variant={variant} />
            ))}
          </div>
          <Composer state={state} />
        </div>
        <PaneArea state={state} variant={variant} />
      </div>
    </div>
  );
};

// --- The state panel ------------------------------------------------------------------------------------------------

const modelSees = (state: State): string[] => {
  const lines: string[] = [];
  for (const entry of state.transcript) {
    if (entry.kind === "owner")
      lines.push(
        entry.via === undefined
          ? `user: ${entry.text}`
          : `user (sent from the ${entry.via} View, untrusted): ${entry.text}`,
      );
    else if (entry.kind === "assistant") lines.push(`assistant: ${entry.text}`);
    else
      lines.push(
        `tool_result ${entry.tool}: ${entry.result?.text ?? "(running)"}${
          entry.appCalls.length > 0 ? ` [+${entry.appCalls.length} app-only calls: not shown]` : ""
        }`,
      );
  }
  for (const [callId, context] of Object.entries(state.modelContext))
    lines.push(`+ app context (${context.server} View, ${callId}, untrusted): ${context.text}`);
  return lines;
};

const StatePanel = ({ state, variant }: { state: State; variant: Variant }) => {
  const shown = VARIANTS.find((found) => found.key === variant);

  return (
    <aside className="flex w-[400px] shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3 text-xs">
      <div>
        <h2 className="text-sm font-semibold">
          Variant {variant}: {shown?.name}
        </h2>
        <p className="mt-1 text-muted-foreground">{shown?.rules}</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <IconButton onClick={agentCallsApp} title="The agent calls another App tool">
          <ExternalLink className="size-3" /> Agent calls another app
        </IconButton>
        <IconButton
          onClick={() => {
            setState((current) => ({ ...current, epoch: current.epoch + 1 }));
            log(
              "host",
              "Reload / a client that connects later: every View remounts from the transcript",
            );
          }}
          title="Remount every View, as a reload or a second device would"
        >
          <RotateCcw className="size-3" /> Reload page (late client)
        </IconButton>
        <IconButton
          onClick={() => setState((current) => ({ ...current, phone: !current.phone }))}
          title="Phone width"
        >
          <Smartphone className="size-3" /> {state.phone ? "Desktop" : "Phone"}
        </IconButton>
        <IconButton onClick={reset} title="Start over">
          Reset
        </IconButton>
      </div>

      <label className="flex items-center gap-2">
        <span>ui/message lands as</span>
        <select
          value={state.messageMode}
          onChange={(event) =>
            setState((current) => ({
              ...current,
              messageMode: event.target.value === "draft" ? "draft" : "send",
            }))
          }
          className="rounded border bg-background px-1 py-0.5"
        >
          <option value="send">an owner message, sent at once</option>
          <option value="draft">a composer draft the owner sends</option>
        </select>
      </label>

      <div>
        <h3 className="font-semibold">What the model sees at its next request</h3>
        <ol className="mt-1 space-y-1 font-mono text-[0.6875rem]">
          {modelSees(state).map((line, index) => (
            <li
              key={index}
              className={cn(line.startsWith("+") && "text-amber-600 dark:text-amber-400")}
            >
              {line}
            </li>
          ))}
        </ol>
      </div>

      <div className="min-h-0">
        <h3 className="font-semibold">Bridge log (newest first)</h3>
        <ol className="mt-1 space-y-0.5 font-mono text-[0.6875rem]">
          {state.log.map((line) => (
            <li key={line.id}>
              <span className="text-muted-foreground">
                {line.dir}
                {line.callId !== undefined && ` ${line.callId}`}
              </span>{" "}
              {line.text}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
};

// --- The switcher ---------------------------------------------------------------------------------------------------

const Switcher = ({ variant, go }: { variant: Variant; go: (next: Variant) => void }) => {
  const index = VARIANTS.findIndex((found) => found.key === variant);
  const step = (by: number) => go(VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]!.key);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-3 py-1.5 text-sm text-white shadow-lg">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        <ChevronLeft className="size-4" />
      </button>
      <span>
        {variant} ({VARIANTS[index]?.name})
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
};

export const McpAppPrototype = () => {
  const state = useStore();
  const [variant, setVariant] = useState<Variant>(variantOf);

  const go = (next: Variant) => {
    const params = new URLSearchParams(window.location.search);
    params.set("variant", next);
    window.history.replaceState(null, "", `?${params.toString()}`);
    // Each variant starts from the same Panes: none open.
    setState((current) => ({ ...current, panes: [], shownPane: undefined, reopened: [] }));
    setVariant(next);
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 items-center justify-center bg-muted/40">
        <div
          className={cn(
            "overflow-hidden bg-background",
            state.phone
              ? "h-[780px] w-[390px] rounded-[2rem] border-4 border-foreground/80"
              : "h-full w-full",
          )}
        >
          <SessionMock key={variant} state={state} variant={variant} />
        </div>
      </div>
      <StatePanel state={state} variant={variant} />
      <Switcher variant={variant} go={go} />
    </div>
  );
};
