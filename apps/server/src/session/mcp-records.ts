// What the Session does with the records of the questions its MCP calls asked, outside History (`docs/architecture/
// mcp-server-requests.md` → Elicitation requests, Records; Sampling requests, Records): `/export` puts a line for each
// under the call's result, and a Fork or Clone carries the settled question and Sampling records of the calls it copies.
// Never a value: the records keep none.
import {
  exportLinesOf,
  type McpQuestionCopies,
  type McpQuestionsService,
  type McpSamplingService,
} from "@cloudpid/extensions/mcp";
import * as Effect from "effect/Effect";
import type { McpExportLines } from "./commands.ts";

/** The Session's question records, as the host reads them. */
export type SessionMcpRecords = {
  /** The lines `/export` writes, by the ID of the call whose result they follow. */
  readonly exportLines: Effect.Effect<McpExportLines>;
  /** What a Fork or Clone carries of the settled question and Sampling records, and keeps of the ones it was sent. */
  readonly copies: McpQuestionCopies;
};

export const sessionMcpRecords = (services: {
  readonly questions: McpQuestionsService;
  readonly sampling: McpSamplingService;
}): SessionMcpRecords => ({
  exportLines: Effect.all([services.questions.records, services.sampling.records]).pipe(
    Effect.map(([questions, sampling]) => exportLinesOf(questions, sampling)),
  ),
  copies: services.questions.copies,
});
