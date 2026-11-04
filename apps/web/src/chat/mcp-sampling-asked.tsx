// @effect-diagnostics preferEffectArray:off -- JSX lists of messages and tools are native arrays.
// What an MCP server asked in a Sampling request, as plain text (`docs/architecture/mcp-server-requests.md` → Sampling
// requests): the system prompt, the messages, the tools it offers and what cloudpid changed. The waiting card and the
// record a call's card expands both show it, so both draw it here.
import type { McpSamplingMessage, McpSamplingTool } from "@cloudpid/protocol";
import * as Arr from "effect/Array";

/** One text block: a label and what it holds, scrolling when long. */
const Block = ({ label, children }: { label: string; children: string }) => (
  <div className="mt-2">
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <p className="max-h-40 overflow-y-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
      {children}
    </p>
  </div>
);

/** What a request asked, and what cloudpid said of it; the `reply`, once there is one, follows the tools. */
export const SamplingAsked = ({
  systemPrompt,
  omitted,
  messages,
  tools,
  reply,
  notes,
}: {
  systemPrompt?: string | undefined;
  omitted?: number | undefined;
  messages: ReadonlyArray<McpSamplingMessage>;
  tools: ReadonlyArray<McpSamplingTool>;
  reply?: string | undefined;
  notes: ReadonlyArray<string>;
}) => (
  <>
    {systemPrompt === undefined || systemPrompt === "" ? null : (
      <Block label="System prompt">{systemPrompt}</Block>
    )}
    {omitted === undefined || omitted === 0 ? null : (
      <p className="mt-2 text-xs text-muted-foreground">
        {omitted} earlier {omitted === 1 ? "message" : "messages"} left out
      </p>
    )}
    {Arr.map(messages, (message, index) => (
      <Block key={index} label={message.role === "user" ? "User message" : "Assistant message"}>
        {message.text}
      </Block>
    ))}
    {tools.length === 0 ? null : (
      <div className="mt-2">
        <div className="text-xs font-medium text-muted-foreground">
          {tools.length === 1 ? "1 tool offered" : `${tools.length} tools offered`}, never run by
          cloudpid
        </div>
        <ul className="mt-1 text-xs">
          {Arr.map(tools, (tool) => (
            <li key={tool.name} className="break-words">
              <span className="font-mono">{tool.name}</span>
              {tool.description === undefined ? null : (
                <span className="text-muted-foreground"> · {tool.description}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    )}
    {reply === undefined ? null : <Block label="Reply">{reply}</Block>}
    {Arr.map(notes, (note) => (
      <p key={note} className="mt-1 text-xs text-muted-foreground">
        {note}
      </p>
    ))}
  </>
);
