import {
  useAuiState,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { useAtom } from "@effect/atom-react";
import type { ReactNode } from "react";
import * as Arr from "effect/Array";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { Check, ChevronRight, Loader, X } from "lucide-react";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { duration } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { TranscriptDisclosure } from "../session-layout.ts";
import { disclosureOpenAtom } from "../session-layout-state.ts";
import { useShownLayoutKey, useThreadConversation } from "./conversation.ts";
import { ChangeDiff } from "../change-diff.tsx";
import { changeTitleText, fieldValueText } from "../environments.ts";
import { changeDiff } from "../line-diff.ts";
import { decodeCardDiff, diffTotals } from "../call-diff.ts";
import { DiffTally } from "../diff-pane/parts.tsx";
import { CallDiffBody, CallDiffStats } from "./call-diff-card.tsx";
import { changesOf, type ShownChange } from "./agent-change.ts";
import { NestedCall } from "./nested-calls.ts";
import { toolSummary } from "./tool-summary.ts";

/**
 * The model's markdown. Images are not loaded: the page would fetch whatever URL the model (or text it read from
 * a tool) names, which tells that host the reader's address and when the page was open. Streamdown shows a blocked
 * image as a placeholder.
 */
export const MarkdownText = () => (
  <StreamdownTextPrimitive
    caret="block"
    security={{ allowedImagePrefixes: [], allowDataImages: false }}
    className="max-w-none text-[0.9375rem] leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[0.8125rem] [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.85em] [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:underline [&_a]:underline-offset-2 [&_h1]:mt-6 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold"
  />
);

/** Content that may be given whether its `details` are open, for content that is only worth mounting while they are. */
type OpenContent = ReactNode | ((open: boolean) => ReactNode);

const shown = (content: OpenContent, open: boolean): ReactNode =>
  Predicate.isFunction(content) ? content(open) : content;

/**
 * A `details` of a thread whose open state is kept in the Session's layout, so it is open again when the owner comes
 * back to the Session. `held` holds it open whatever was kept, as while what it shows streams.
 */
export const KeptDetails = ({
  disclosure,
  held = false,
  className,
  children,
}: {
  disclosure: DistributiveOmit<TranscriptDisclosure, "conversationId">;
  held?: boolean | undefined;
  className?: string | undefined;
  children: OpenContent;
}) => {
  const conversationId = useThreadConversation();

  const [kept, setKept] = useAtom(
    disclosureOpenAtom(useShownLayoutKey(), { ...disclosure, conversationId }),
  );

  const open = held || kept;

  return (
    <details
      open={open}
      onToggle={(event) => {
        // A `details` rendered open fires a toggle too; only a change is kept.
        if (event.currentTarget.open !== open) setKept(event.currentTarget.open);
      }}
      className={className}
    >
      {shown(children, open)}
    </details>
  );
};

/** `Omit` over each member of a union, so each keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const Disclosure = ({
  disclosure,
  summary,
  held,
  children,
}: {
  disclosure: DistributiveOmit<TranscriptDisclosure, "conversationId">;
  summary: ReactNode;
  held?: boolean | undefined;
  children: OpenContent;
}) => (
  <KeptDetails disclosure={disclosure} held={held} className="group my-2 rounded-md border">
    {(open) => (
      <>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            aria-hidden
          />
          {summary}
        </summary>
        <div className="border-t px-3 py-2">{shown(children, open)}</div>
      </>
    )}
  </KeptDetails>
);

/** The model's thinking: open while it streams, then as the owner left it (folded away until they open it). */
export const ReasoningPart: ReasoningMessagePartComponent = ({ text, status }) => {
  const messageId = useAuiState((state) => state.message.id);

  // Its place among the message's parts tells it from the message's other thinking.
  const index = useAuiState((state) =>
    Option.getOrElse(
      Arr.findFirstIndex(
        [...state.message.content],
        (part) => part.type === "reasoning" && part.text === text,
      ),
      () => 0,
    ),
  );

  return (
    <Disclosure
      disclosure={{ kind: "thinking", messageId, index }}
      held={status.type === "running"}
      summary={status.type === "running" ? "Thinking…" : "Thought"}
    >
      <p className="text-sm whitespace-pre-wrap text-muted-foreground">{text}</p>
    </Disclosure>
  );
};

const Output = ({ label, text, error }: { label: string; text: string; error?: boolean }) => (
  <div className="mt-2 first:mt-0">
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <pre
      className={cn(
        "mt-1 max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap",
        error === true && "text-destructive",
      )}
    >
      {text}
    </pre>
  </div>
);

const StreamedOutput = Schema.Struct({ output: Schema.NonEmptyString });

const decodeStreamedOutput = Schema.decodeUnknownOption(StreamedOutput);

const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));

const decodeImages = Schema.decodeUnknownOption(
  Schema.Struct({
    images: Schema.Array(Schema.Struct({ mimeType: Schema.String, data: Schema.String })),
  }),
);

const decodeNested = Schema.decodeUnknownOption(
  Schema.Struct({ nested: Schema.Array(NestedCall) }),
);

/** The mark of a call's state, as on a tool card's own line. */
const StateIcon = ({ status }: { status: NestedCall["status"] }) => {
  switch (status) {
    case "running":
      return <Loader className="size-3.5 motion-safe:animate-spin" aria-label="Running" />;
    case "ok":
      return <Check className="size-3.5 text-success" aria-label="Done" />;
    case "error":
      return <X className="size-3.5 text-destructive" aria-label="Failed" />;
    case "cancelled":
      return <X className="size-3.5" aria-label="Stopped" />;
  }
};

/** One call of a script, on one line: its state, name, the argument that tells it apart, its change, and its time. */
const NestedLine = ({ call, path }: { call: NestedCall; path?: string | undefined }) => {
  // The arguments of a call are cut for display, and may not say the file; a Call diff does.
  const summary = toolSummary(call.name, call.args) ?? path;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
      <StateIcon status={call.status} />
      <span className="font-mono text-[0.8125rem] text-foreground">{call.name}</span>
      {summary !== undefined && (
        <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
      )}
      {call.diff !== undefined && <CallDiffStats diff={call.diff} />}
      {call.durationMs !== undefined && (
        <span className="ml-auto shrink-0 text-muted-foreground">{duration(call.durationMs)}</span>
      )}
    </div>
  );
};

/**
 * The calls a tool made, such as a script's, in the order they started: live while it runs, then as it recorded them.
 * An `edit` or `write` of a script that ended has its change on its line, and opens to its diff in place.
 */
const NestedCalls = ({
  parentId,
  calls,
}: {
  /** The call that made them: its `callId` keeps which of them are open. */
  parentId: string;
  calls: readonly NestedCall[];
}) => {
  // A line that opens has a chevron before it; the others keep its place.
  const opens = Arr.some(calls, (call) => call.diff !== undefined);

  return (
    <div className="mt-2 first:mt-0">
      <div className="text-xs font-medium text-muted-foreground">Calls</div>
      <ul className="mt-1 space-y-1">
        {Arr.map(calls, (call) => {
          const { diff } = call;

          // The script's arguments are cut for display, so the path is the one the diff was recorded with.
          const path =
            diff?.path ??
            Option.getOrUndefined(Option.map(decodePath(call.args), (found) => found.path));

          return (
            <li key={call.id}>
              {diff === undefined ? (
                <div className="flex items-center gap-2">
                  {opens && <span className="size-3.5 shrink-0" aria-hidden />}
                  <NestedLine call={call} />
                </div>
              ) : (
                <KeptDetails
                  disclosure={{ kind: "tool", callId: `${parentId}/c${call.id}` }}
                  className="group/call"
                >
                  {(open) => (
                    <>
                      <summary className="flex cursor-pointer list-none items-center gap-2 select-none [&::-webkit-details-marker]:hidden">
                        <ChevronRight
                          className="size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform group-open/call:rotate-90"
                          aria-hidden
                        />
                        <NestedLine call={call} path={path} />
                      </summary>
                      {open && (
                        <div className="mt-1.5 mb-1 ml-5.5">
                          <CallDiffBody diff={diff} path={path} />
                        </div>
                      )}
                    </>
                  )}
                </KeptDetails>
              )}
              {call.error !== undefined && (
                <div
                  className={cn(
                    "mt-0.5 truncate text-xs text-destructive",
                    opens ? "ml-11" : "ml-5.5",
                  )}
                >
                  {call.error}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/**
 * The Agent change a call made: the Environment (or the Settings) and field, and its value before and after, in full; a script's or the
 * Toolchains' as a diff.
 */
const Change = ({ change }: { change: ShownChange }) => {
  const diff = changeDiff(change.field, change.before, change.after);

  return (
    <div className="mt-2 first:mt-0">
      <div className="text-xs font-medium text-muted-foreground">
        {changeTitleText(change.field, change.environment?.name ?? "the Settings")}
        {change.approved === true && " · approved by you"}
      </div>
      {diff === undefined ? (
        <>
          <Output label="Before" text={fieldValueText(change.field, change.before)} />
          <Output label="After" text={fieldValueText(change.field, change.after)} />
        </>
      ) : (
        <div className="mt-1">
          <ChangeDiff rows={diff} />
        </div>
      )}
    </div>
  );
};

/**
 * A tool call: its name and state on one line, its arguments, the Agent change it made, streamed output, and result
 * when opened.
 */
export const ToolCallCard: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  args,
  argsText,
  result,
  isError,
  artifact,
  status,
}) => {
  // A call is running only while its message is; one in a message that ended (errored, cancelled, or cut off) is stopped.
  const running = result === undefined && status.type === "running";
  const stopped = result === undefined && !running;

  const streamed = Option.getOrUndefined(
    Option.map(decodeStreamedOutput(artifact), (found) => found.output),
  );

  const summary = toolSummary(toolName, args);

  const calls = Option.getOrElse(
    Option.map(decodeNested(artifact), (found) => found.nested),
    () => [],
  );

  const shownArgs = argsText !== "" ? argsText : JSON.stringify(args, null, 2);
  const changes = changesOf(artifact);

  // The Call diff of an `edit` or `write` that finished: only a call with a result has one.
  const diff = Option.getOrUndefined(Option.map(decodeCardDiff(artifact), (found) => found.diff));

  // A script's own: the lines its `edit` and `write` calls changed, together.
  const totals = diffTotals(Arr.map(calls, (nested) => nested.diff));

  const path = Option.getOrUndefined(Option.map(decodePath(args), (found) => found.path));

  // The screenshots a call returned, which show beside its card rather than inside it.
  const images = Option.getOrElse(
    Option.map(decodeImages(artifact), (found) => found.images),
    () => [],
  );

  // The card's arguments, the changes it made, the calls it made, and its output and result.
  const call = (
    <>
      <Output label="Arguments" text={shownArgs} />
      {Arr.map(changes, (change) => (
        <Change key={change.field} change={change} />
      ))}
      {calls.length > 0 && <NestedCalls parentId={toolCallId} calls={calls} />}
      {streamed !== undefined && result === undefined && <Output label="Output" text={streamed} />}
      {result !== undefined && (
        <Output
          label={isError === true ? "Error" : "Result"}
          text={Predicate.isString(result) ? result : JSON.stringify(result, null, 2)}
          error={isError === true}
        />
      )}
    </>
  );

  const card = (
    <Disclosure
      disclosure={{ kind: "tool", callId: toolCallId }}
      // The calls of a script that is running show as they start.
      held={running && calls.length > 0}
      summary={
        <>
          {running ? (
            <Loader className="size-3.5 motion-safe:animate-spin" aria-label="Running" />
          ) : isError === true ? (
            <X className="size-3.5 text-destructive" aria-label="Failed" />
          ) : stopped ? (
            <X className="size-3.5" aria-label="Stopped" />
          ) : (
            <Check className="size-3.5 text-success" aria-label="Done" />
          )}
          <span className="font-mono text-[0.8125rem] text-foreground">{toolName}</span>
          {summary !== undefined && (
            <span className="min-w-0 truncate font-mono text-xs">{summary}</span>
          )}
          {diff !== undefined && <CallDiffStats diff={diff} />}
          {totals !== undefined && <DiffTally counts={totals} />}
        </>
      }
    >
      {(open) => {
        if (diff === undefined) return call;

        // Mounted only while the card is open: the diff is drawn when the owner looks at it.
        return open ? <CallDiffBody diff={diff} path={path} call={call} /> : null;
      }}
    </Disclosure>
  );

  if (images.length === 0) return card;

  return (
    <>
      {card}
      {Arr.map(images, (image, index) => (
        <img
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt="Screenshot of the page"
          className="my-2 max-h-96 max-w-full rounded-md border"
        />
      ))}
    </>
  );
};
