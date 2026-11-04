// @effect-diagnostics preferEffectArray:off -- JSX lists of lines and messages are native arrays.
// The Sampling requests on an MCP tool call's card (`docs/architecture/mcp-server-requests.md` → Sampling requests,
// Records): one line for each, from the call's `details.sampling`, which opens into the record `mcp_sampling_get` returns
// (what was asked, and the reply), fetched when it is first opened. A record the Session no longer keeps says so.
import type { McpSamplingRecordView } from "@cloudpid/protocol";
import { useAtomSet } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Exit from "effect/Exit";
import { useState } from "react";
import { getMcpSamplingAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import { SamplingAsked } from "./mcp-sampling-asked.tsx";
import { type ShownSampling, samplingLine } from "./mcp-sampling-detail.ts";

/** What the fetch of one record came to. */
type Fetched =
  | { readonly state: "idle" | "loading" | "gone" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "shown"; readonly record: McpSamplingRecordView };

/** The record, as far as the Session kept it (a stub has no content). */
export const SamplingRecord = ({ record }: { record: McpSamplingRecordView }) => (
  <div className="mt-1 mb-2 border-l pl-3">
    <SamplingAsked
      systemPrompt={record.systemPrompt}
      omitted={record.omitted}
      messages={record.messages}
      tools={record.tools}
      reply={record.reply}
      notes={record.notes}
    />
    {record.stub === true ? (
      <p className="mt-1 text-xs text-muted-foreground">
        The Session kept only a summary of this one.
      </p>
    ) : null}
  </div>
);

/** What the opened line shows of its record. */
const Fetching = ({ fetched }: { fetched: Fetched }) => {
  switch (fetched.state) {
    case "loading":
      return <p className="mt-1 text-xs text-muted-foreground">Loading…</p>;
    case "gone":
      return (
        <p className="mt-1 text-xs text-muted-foreground">
          The Session no longer keeps this record.
        </p>
      );
    case "failed":
      return (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {fetched.message}
        </p>
      );
    case "shown":
      return <SamplingRecord record={fetched.record} />;
    case "idle":
      return null;
  }
};

/** One request's line: with a record to read (`id`), it opens into it. */
const SamplingLine = ({ request }: { request: ShownSampling }) => {
  const sessionId = useShownSessionId();
  const get = useAtomSet(getMcpSamplingAtom(sessionId), { mode: "promiseExit" });
  const [fetched, setFetched] = useState<Fetched>({ state: "idle" });
  const { id } = request;

  if (id === undefined) return <li>{samplingLine(request)}</li>;

  const load = () => {
    if (fetched.state !== "idle" && fetched.state !== "failed") return;

    setFetched({ state: "loading" });
    void get(id).then((exit) => {
      if (!Exit.isSuccess(exit)) {
        setFetched({ state: "failed", message: "The Session did not answer; try again." });

        return;
      }

      setFetched(exit.value === null ? { state: "gone" } : { state: "shown", record: exit.value });
    });
  };

  return (
    <li>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) load();
        }}
      >
        <summary className="cursor-pointer break-words">{samplingLine(request)}</summary>
        <Fetching fetched={fetched} />
      </details>
    </li>
  );
};

/** The "Model use" block of a call's card. */
export const SamplingLines = ({ requests }: { requests: ReadonlyArray<ShownSampling> }) => (
  <div className="mt-2 first:mt-0">
    <div className="text-xs font-medium text-muted-foreground">Model use</div>
    <ul className="mt-1 text-xs break-words">
      {Arr.map(requests, (request, index) => (
        <SamplingLine key={request.id ?? index} request={request} />
      ))}
    </ul>
  </div>
);
