import type {
  ReasoningMessagePartComponent,
  ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import * as Arr from "effect/Array";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { Check, ChevronRight, Loader, X } from "lucide-react";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { duration } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { changeFieldText, changeValueText } from "../environments.ts";
import { changeOf, type ShownChange } from "./agent-change.ts";
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

const Disclosure = ({
  summary,
  open,
  children,
}: {
  summary: React.ReactNode;
  open?: boolean | undefined;
  children: React.ReactNode;
}) => (
  <details open={open} className="group my-2 rounded-md border">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
      {summary}
    </summary>
    <div className="border-t px-3 py-2">{children}</div>
  </details>
);

/** The model's thinking: open while it streams, folded away once it is done. */
export const ReasoningPart: ReasoningMessagePartComponent = ({ text, status }) => (
  <Disclosure
    open={status.type === "running" ? true : undefined}
    summary={status.type === "running" ? "Thinking…" : "Thought"}
  >
    <p className="text-sm whitespace-pre-wrap text-muted-foreground">{text}</p>
  </Disclosure>
);

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

/** The calls a tool made, such as a script's, in the order they started: live while it runs, then as it recorded them. */
const NestedCalls = ({ calls }: { calls: readonly NestedCall[] }) => (
  <div className="mt-2 first:mt-0">
    <div className="text-xs font-medium text-muted-foreground">Calls</div>
    <ul className="mt-1 space-y-1">
      {Arr.map(calls, (call) => {
        const summary = toolSummary(call.name, call.args);

        return (
          <li key={call.id}>
            <div className="flex items-center gap-2 text-xs">
              <StateIcon status={call.status} />
              <span className="font-mono text-[0.8125rem] text-foreground">{call.name}</span>
              {summary !== undefined && (
                <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
              )}
              {call.durationMs !== undefined && (
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {duration(call.durationMs)}
                </span>
              )}
            </div>
            {call.error !== undefined && (
              <div className="mt-0.5 ml-5.5 truncate text-xs text-destructive">{call.error}</div>
            )}
          </li>
        );
      })}
    </ul>
  </div>
);

/** The Agent change a call made: the Environment and field, and its value before and after, in full. */
const Change = ({ change }: { change: ShownChange }) => (
  <div className="mt-2 first:mt-0">
    <div className="text-xs font-medium text-muted-foreground">
      {changeFieldText(change.field)} in {change.environment.name}
    </div>
    <Output label="Before" text={changeValueText(change.before)} />
    <Output label="After" text={changeValueText(change.after)} />
  </div>
);

/**
 * A tool call: its name and state on one line, its arguments, the Agent change it made, streamed output, and result
 * when opened.
 */
export const ToolCallCard: ToolCallMessagePartComponent = ({
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
  const change = changeOf(artifact);

  // The screenshots a call returned, which show beside its card rather than inside it.
  const images = Option.getOrElse(
    Option.map(decodeImages(artifact), (found) => found.images),
    () => [],
  );

  const card = (
    <Disclosure
      // The calls of a script that is running show as they start.
      open={running && calls.length > 0 ? true : undefined}
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
        </>
      }
    >
      <Output label="Arguments" text={shownArgs} />
      {change !== undefined && <Change change={change} />}
      {calls.length > 0 && <NestedCalls calls={calls} />}
      {streamed !== undefined && result === undefined && <Output label="Output" text={streamed} />}
      {result !== undefined && (
        <Output
          label={isError === true ? "Error" : "Result"}
          text={Predicate.isString(result) ? result : JSON.stringify(result, null, 2)}
          error={isError === true}
        />
      )}
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
