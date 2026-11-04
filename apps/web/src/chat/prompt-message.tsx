// @effect-diagnostics missingPipeableSignature:off -- a component, not a combinator.

// An MCP prompt in the owner's message, as the transcript shows it (`docs/architecture/mcp-in-a-session.md` → Into the
// conversation, The transcript): a chip line above the typed text, "MCP prompt · docs · Review PR" with its arguments, and the block the
// model got closed under it, as the Session wrote it, so what the server said stays in sight. The assistant's messages in
// the prompt are quoted as the prompt's, never as the model's.

import * as Arr from "effect/Array";
import { ChevronRight, Sparkles } from "lucide-react";
import { KeptDetails } from "./parts.tsx";
import {
  promptArgumentLines,
  promptHead,
  promptSegments,
  promptUnseenDeclines,
} from "./prompt-disclosure.ts";
import type { ShownMcpPrompt } from "../session/thread-messages.ts";

/**
 * The chip line of the MCP prompt a message got, with its arguments and a line for each question its server asked that
 * cloudpid ended unseen: above the typed text, where the owner's chip was.
 */
export const McpPromptChipLine = ({ prompt }: { prompt: ShownMcpPrompt }) => {
  const argumentLines = promptArgumentLines(prompt);
  const declines = promptUnseenDeclines(prompt);

  return (
    <div className="mb-1.5 flex flex-col gap-1 text-sm">
      <div className="flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5">
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate" title={prompt.command}>
          {promptHead(prompt)}
        </span>
      </div>
      {argumentLines.length > 0 && (
        <ul aria-label="Prompt arguments" className="text-xs text-muted-foreground">
          {Arr.map(argumentLines, (line) => (
            <li key={line} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {declines.length > 0 && (
        <ul aria-label="Questions cloudpid ended" className="text-xs text-muted-foreground">
          {Arr.map(declines, (line, index) => (
            <li key={index} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** What the prompt's result said of itself, and the block the model got, closed, under the typed text of message `messageId`. */
export const McpPromptDisclosure = ({
  prompt,
  messageId,
}: {
  prompt: ShownMcpPrompt;
  messageId: string;
}) => {
  const segments = promptSegments(prompt.text);

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-sm">
      {prompt.description !== undefined && (
        <p className="text-xs text-muted-foreground">{prompt.description}</p>
      )}
      <KeptDetails disclosure={{ kind: "mcp-prompt", messageId }} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 transition-transform group-open:rotate-90"
            aria-hidden
          />
          What the model got
        </summary>
        <div className="mt-1.5 flex max-h-96 flex-col gap-1.5 overflow-auto">
          {Arr.map(segments, (segment, index) =>
            segment.role === "assistant" ? (
              <figure key={index} className="rounded-md border-l-2 bg-background px-3 py-2">
                <figcaption className="mb-1 text-xs text-muted-foreground">
                  Assistant (from the prompt)
                </figcaption>
                <pre className="font-mono text-xs whitespace-pre-wrap">{segment.text}</pre>
              </figure>
            ) : (
              <pre
                key={index}
                className="rounded-md border bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap"
              >
                {segment.text}
              </pre>
            ),
          )}
          {prompt.resources.length > 0 && (
            <ul aria-label="Prompt resources" className="text-xs text-muted-foreground">
              {Arr.map(prompt.resources, (resource) => (
                <li key={resource.uri} className="truncate" title={resource.uri}>
                  {resource.kind} · {resource.uri}
                  {resource.path === undefined ? "" : ` → ${resource.path}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </KeptDetails>
    </div>
  );
};
