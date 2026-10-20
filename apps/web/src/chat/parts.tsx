import {
  useAuiState,
  type ReasoningMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { Check, ChevronRight, Loader, X } from "lucide-react";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { cn } from "../lib/utils.ts";

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

/** A tool call: its name and state on one line, its arguments, streamed output, and result when opened. */
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

  const shownArgs = argsText !== "" ? argsText : JSON.stringify(args, null, 2);

  return (
    <Disclosure
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
        </>
      }
    >
      <Output label="Arguments" text={shownArgs} />
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
};

/** Whether this message is the one streaming now, for a caret or a spinner. */
export const useIsStreaming = (): boolean =>
  useAuiState((state) => state.message.status?.type === "running");
