// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What a call of an MCP tool does with the questions its server asks (`docs/architecture/mcp-server-requests.md` →
// Questions, Elicitation requests; ADR-0041): the hooks the host passes on to the engine (`onInput`, `onInputEnded`),
// and what the model and `details` read of the answers.
//
// A form is normalized into cloudpid's own (`normalizeElicitationForm`) and shown to the owner through `McpQuestions`,
// whose wait is the call's: the call's own clock is stopped while it lasts (`pause`, `resume`) and Stop interrupts it
// (`signal`), which withdraws the card. A form that asks for a credential is declined unseen, a malformed one refused
// with `-32602`; the owner and the agent both learn of every one, in `details.elicitation` and a diagnostic line.
// Nothing here keeps what the owner entered: the content goes from the answer to the server and nowhere else.
import {
  answeredFields,
  decodeElicitParams,
  isJsonObject,
  type McpInputAnswer,
  type McpInputRequest,
  messageIsCut,
  normalizeElicitationForm,
  plainLine,
  plainMessage,
  quote,
} from "@cloudpid/mcp/types";
import type { ElicitationContent, ElicitationForm, McpElicitationSource } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  ToolDiagnostic,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { McpElicitationDetail } from "./details.ts";
import {
  MCP_ELICITATION_CAP_REASON,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionsService,
  type McpQuestionUnseen,
} from "./questions.ts";

/** What a form that asks for the credential `field` is declined with: the server is told, the agent reads why. */
export const credentialReason = (field: string): string =>
  `it asked for a credential (${quote(field)}), which MCP servers must not ask for in a form; the user can give the server a key through its MCP server definition (a Secret as \`\${NAME}\`), or the server can ask on its own page.`;

/** The call that asks, as the tool knows it. */
export type ElicitingCall = {
  readonly questions: McpQuestionsService;
  readonly server: string;
  /** The model-facing name of the tool. */
  readonly tool: string;
  readonly callId: string;
  readonly conversationId: ConversationId;
  /** Where the server's definition is. */
  readonly source?: McpElicitationSource | undefined;
  /** Aborts when Stop does: a question waiting then is withdrawn. */
  readonly signal: AbortSignal | undefined;
  /** Stop the call's own clock while a question waits, and start it again. */
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
};

/** The hooks of a call that may be asked questions, and the questions it was asked. */
export type Eliciting = {
  readonly onInput: (
    request: typeof McpInputRequest.Encoded,
  ) => Promise<typeof McpInputAnswer.Encoded>;
  readonly onInputEnded: (key: string) => Promise<void>;
  /** Resolves once every question the call asked has been answered and noted, however it ended. */
  readonly idle: () => Promise<void>;
  /** What happened to each question, in order; read when the call ends. */
  readonly asked: Array<McpElicitationDetail>;
};

/** The question's words for the server: `-32602`, as the spec has it for a form cloudpid cannot take. */
const unsupported = (reason: string): typeof McpInputAnswer.Encoded => ({
  kind: "refused",
  message: `unsupported elicitation form: ${reason}`,
  code: -32602,
});

/** What the server is told of a request past the call's cap. */
const CANCELLED: typeof McpInputAnswer.Encoded = { kind: "answered", result: { action: "cancel" } };

/** The note that says a message was cut, when it was. */
const cutNotes = (message: string): ReadonlyArray<string> =>
  messageIsCut(message) ? ["the message was cut at 4,000 characters"] : [];

/** `content` for the wire, whose lists are mutable. */
const mutableContent = (content: ElicitationContent) =>
  Record.map(content, (value) =>
    Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
      ? value
      : [...value],
  );

/** The hooks a call of the tool `call.tool` takes for its server's questions. */
export const elicitingHooks = (call: ElicitingCall): Eliciting => {
  const asked: Array<McpElicitationDetail> = [];

  const note = (
    action: McpElicitationDetail["action"],
    by: McpElicitationDetail["by"],
    fields: Array<string>,
    reason?: string,
  ) => {
    const detail: Mutable<McpElicitationDetail> = {
      server: call.server,
      mode: "form",
      action,
      by,
      fields,
    };

    if (reason !== undefined) detail.reason = reason;

    asked.push(detail);
  };

  /**
   * A form cloudpid ends unseen: recorded for the owner and the agent. It counts toward the call's cap like any request;
   * `true` says the call was past it, and the server is to be told `cancel` whatever cloudpid would have said.
   */
  const endUnseen = (
    message: string,
    action: "decline" | "cancel",
    reason: string,
    form?: ElicitationForm,
  ): Promise<boolean> => {
    const unseen: Mutable<McpQuestionUnseen> = {
      callId: call.callId,
      conversationId: call.conversationId,
      server: call.server,
      tool: call.tool,
      message: plainMessage(message),
      notes: cutNotes(message),
      action,
      reason,
    };

    if (form !== undefined) unseen.form = form;

    return Effect.runPromise(call.questions.unseen(unseen)).then((recorded) => {
      if (recorded === "capped") {
        note("cancel", "cloudpid", [], MCP_ELICITATION_CAP_REASON);

        return true;
      }

      note(action, "cloudpid", [], reason);

      return false;
    });
  };

  const answering = new Set<Promise<unknown>>();

  const answerInput: Eliciting["onInput"] = async (request) => {
    if (request.kind !== "elicitation") return unsupported("only forms are taken");

    const params = decodeElicitParams(request.params);

    if (Option.isNone(params)) {
      const capped = await endUnseen("", "cancel", "the request is malformed");

      return capped ? CANCELLED : unsupported("the request is malformed");
    }

    const { message, mode, requestedSchema } = params.value;

    if (mode !== undefined && mode !== "form") {
      const reason = `${quote(mode)} mode is not supported`;
      const capped = await endUnseen(message, "decline", reason);

      return capped ? CANCELLED : unsupported(reason);
    }

    const normalized = normalizeElicitationForm(requestedSchema);

    if (Result.isFailure(normalized)) {
      const capped = await endUnseen(message, "cancel", normalized.failure);

      return capped ? CANCELLED : unsupported(normalized.failure);
    }

    const { form, notes, credential } = normalized.success;

    if (credential !== undefined) {
      const capped = await endUnseen(message, "decline", credentialReason(credential), form);

      return capped ? CANCELLED : { kind: "answered", result: { action: "decline" } };
    }

    await Effect.runPromise(call.pause);

    const question: Mutable<McpQuestionAsk> = {
      key: request.key,
      callId: call.callId,
      conversationId: call.conversationId,
      server: call.server,
      tool: call.tool,
      message: plainMessage(message),
      form,
      notes: [...notes, ...cutNotes(message)],
    };

    if (call.source !== undefined) question.source = call.source;

    const outcome: McpQuestionOutcome = await Effect.runPromise(
      call.questions.ask(question),
      call.signal === undefined ? undefined : { signal: call.signal },
    )
      .catch(
        // Stop interrupted the wait (the question is withdrawn): nobody answers, the server may ask again.
        (): McpQuestionOutcome => ({ action: "cancel", by: "cloudpid", reason: "Run stopped" }),
      )
      .finally(() => Effect.runPromise(call.resume));

    if (outcome.action === "accept") {
      note("accept", "owner", [...answeredFields(form, outcome.content)]);

      return {
        kind: "answered",
        result: { action: "accept", content: mutableContent(outcome.content) },
      };
    }

    note(outcome.action, outcome.by, [], outcome.reason);

    return { kind: "answered", result: { action: outcome.action } };
  };

  const onInput: Eliciting["onInput"] = (request) => {
    const running = answerInput(request);

    answering.add(running);
    void running.finally(() => answering.delete(running)).catch(() => undefined);

    return running;
  };

  return {
    onInput,
    idle: () => Promise.allSettled(answering).then(() => undefined),
    onInputEnded: (key) =>
      Effect.runPromise(
        call.questions.withdraw(call.callId, key, `${call.server} stopped waiting`),
      ),
    get asked() {
      return asked;
    },
  };
};

/** What the model is told of one question that was not answered by the owner's submit. */
const lineOf = (detail: McpElicitationDetail): string | undefined => {
  if (detail.action === "accept") return undefined;

  if (detail.by === "owner") {
    return `The user ${detail.action === "decline" ? "declined" : "cancelled"} ${detail.server}'s request for input. Don't repeat the call unless the user asks.`;
  }

  return `cloudpid ${detail.action === "decline" ? "declined" : "cancelled"} ${detail.server}'s request for input: ${plainLine(detail.reason ?? "no reason given", 400).replace(/[<>]/g, "")}`;
};

/**
 * `result` of a call whose server asked questions: `details.elicitation` says what became of each (never a value), and
 * a diagnostic line tells the agent of each one that was not accepted. The server's own result is untouched.
 */
export const withElicitation = (
  result: ToolExecutionResult<JsonValue>,
  asked: Array<McpElicitationDetail>,
): ToolExecutionResult<JsonValue> => {
  if (asked.length === 0) return result;

  const lines = Arr.filterMap(asked, (detail) => {
    const line = lineOf(detail);

    return line === undefined ? Result.failVoid : Result.succeed(line);
  });

  const diagnostics: ReadonlyArray<ToolDiagnostic> = [
    ...(result.diagnostics ?? []),
    ...Arr.map(lines, (message): ToolDiagnostic => ({
      severity: "info",
      code: "elicitation",
      message,
    })),
  ];

  const details: { [key: string]: Schema.Json } = isJsonObject(result.details)
    ? { ...result.details, elicitation: asked }
    : { elicitation: asked };

  // SAFETY: a `Schema.Json` is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
  return { ...result, details: details as JsonValue, diagnostics };
};
