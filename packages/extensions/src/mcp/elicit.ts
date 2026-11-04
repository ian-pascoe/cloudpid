// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- builders over plain values, and the hooks' Promise seam.
// What a call of an MCP tool does with the questions its server asks (`docs/architecture/mcp-server-requests.md` →
// Questions, Elicitation requests; ADR-0041): the hooks the host passes on to the engine (`onInput`, `onInputEnded`),
// and what the model and `details` read of the answers.
//
// A form is normalized into cloudpid's own (`normalizeElicitationForm`) and shown to the owner through `McpQuestions`,
// whose wait is the call's: the call's own clock is stopped while it lasts (`pause`, `resume`) and Stop interrupts it
// (`signal`), which withdraws the card. A form that asks for a credential is declined unseen, a malformed one refused
// with `-32602`; the owner and the agent both learn of every one, in `details.elicitation` and a diagnostic line.
// Nothing here keeps what the owner entered: the content goes from the answer to the server and nowhere else. A Modern
// server's form, on a call that defers (`defers`), is kept for later instead (`McpQuestions.defer`): the hook answers
// `defer`, and the call waits for the owner after its round (`./exchange.ts`).
import {
  answeredFields,
  decodeElicitParams,
  type McpElicitParams,
  isJsonObject,
  type McpInputAnswer,
  type McpInputRequest,
  messageIsCut,
  normalizeElicitationForm,
  plainLine,
  plainMessage,
  quote,
} from "@cloudpid/mcp/types";
import { checkElicitationUrl, type ElicitationPageProblem } from "@cloudpid/mcp/elicitation-url";
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
  MCP_QUESTION_UNRECORDED_REASON,
  MCP_RUN_STOPPED_REASON,
  type McpPageRef,
  type McpQuestionAsk,
  type McpQuestionOutcome,
  type McpQuestionsService,
  type McpQuestionUnseen,
  originOf,
} from "./questions.ts";
import { MCP_DECLINED_IN_SESSION_REASON, MCP_PAGE_NOT_KEPT_REASON } from "./question-records.ts";

/** What a form that asks for the credential `field` is declined with: the server is told, the agent reads why. */
export const credentialReason = (field: string): string =>
  `it asked for a credential (${quote(field)}), which MCP servers must not ask for in a form; the user can give the server a key through its MCP server definition (a Secret as \`\${NAME}\`), or the server can ask on its own page.`;

/** The call that asks, as the tool knows it. */
export type ElicitingCall = {
  readonly questions: McpQuestionsService;
  readonly server: string;
  /** The model-facing name of the tool; for a prompt send, the prompt's command. */
  readonly tool: string;
  /** The title of the MCP prompt whose `prompts/get` asks: its questions wait live for 5 min and tell the owner nothing. */
  readonly prompt?: string | undefined;
  /** The call is an App View's `tools/call`: its questions wait live for 5 min, tell the owner nothing and name the app. */
  readonly app?: true | undefined;
  /**
   * The handle of the MCP task whose questions these are: they are kept for the owner whatever the call does
   * (`callId` is then the task's key, `taskOwner`), a page's Open answers the server at once, and nothing is sent again.
   */
  readonly task?: string | undefined;
  readonly callId: string;
  readonly conversationId: ConversationId;
  /** Where the server's definition is. */
  readonly source?: McpElicitationSource | undefined;
  /** Aborts when Stop does: a question waiting then is withdrawn. */
  readonly signal: AbortSignal | undefined;
  /**
   * Whether a Modern server's form is kept for later (`ctx.answers.defer`): the call's round ends as `input_required`,
   * and the call waits for the owner after it. Otherwise it is answered live, as a Legacy one.
   */
  readonly defers?: boolean | undefined;
  /**
   * Whether a Legacy server's `-32042` pages are kept for later though a Modern form is not (a resource's read): the
   * round of pages ends the read as `pages_required`, and the read is sent again once they are done.
   */
  readonly keepsPages?: boolean | undefined;
  /** The call's own clock: stopped while a question waits, and started again. */
  readonly hold: ClockHold;
  /**
   * The call waits for the owner at a page live, with no resume (a prompt send's get): a Modern server's page, or a Legacy
   * `-32042`'s, is shown with Open and "Done, try again" and answered `accept` once the owner is done there, for as long as
   * the question's own wait. Otherwise such a page is turned away (`MCP_PAGE_NOT_KEPT_REASON`).
   */
  readonly livePages?: boolean | undefined;
};

/** What stops and starts a call's own clock. */
export type ClockHold = {
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
};

/** The hooks of a call that may be asked questions, and the questions it was asked. */
export type Eliciting = {
  readonly onInput: (
    request: typeof McpInputRequest.Encoded,
  ) => Promise<typeof McpInputAnswer.Encoded>;
  readonly onInputEnded: (key: string, reason?: string) => Promise<void>;
  /** The server says the owner finished at the page question `key` asked them to open: its card closes. */
  readonly onInputComplete: (key: string) => Promise<void>;
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
export const mutableContent = (content: ElicitationContent) =>
  Record.map(content, (value) =>
    Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
      ? value
      : [...value],
  );

/** The hooks a call of the tool `call.tool` takes for its server's questions. */
export const elicitingHooks = (call: ElicitingCall): Eliciting => {
  const asked: Array<McpElicitationDetail> = [];

  /** The line of each page question, by its key, and the keys the server said the owner finished at. */
  const pages = new Map<string, Mutable<McpElicitationDetail>>();
  const finished = new Set<string>();

  /** The line of each question the owner answered `accept`, by its key: the host may say it did not reach the server. */
  const accepted = new Map<string, Mutable<McpElicitationDetail>>();

  const note = (
    action: McpElicitationDetail["action"],
    by: McpElicitationDetail["by"],
    fields: Array<string>,
    reason?: string,
    about?: { readonly page: McpPageRef; readonly key: string },
  ) => {
    const detail: Mutable<McpElicitationDetail> = {
      server: call.server,
      mode: about === undefined ? "form" : "url",
      action,
      by,
      fields,
    };

    if (reason !== undefined) detail.reason = reason;

    if (about !== undefined) {
      detail.host = about.page.host;
      pages.set(about.key, detail);

      // The server said the owner finished there before the question's own answer was noted.
      if (finished.has(about.key)) detail.finished = true;
    }

    asked.push(detail);

    return detail;
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
    page?: McpPageRef,
    key?: string,
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

    if (page !== undefined) unseen.page = page;

    return Effect.runPromise(call.questions.unseen(unseen)).then((recorded) => {
      if (recorded === "capped") {
        note(
          "cancel",
          "cloudpid",
          [],
          MCP_ELICITATION_CAP_REASON,
          page === undefined ? undefined : { page, key: key ?? "" },
        );

        return true;
      }

      note(
        action,
        "cloudpid",
        [],
        reason,
        page === undefined ? undefined : { page, key: key ?? "" },
      );

      return false;
    });
  };

  /** `request` as the question the Session keeps and shows: what it says, and who asks it (the call, its server's source and era). */
  const askOf = (
    request: typeof McpInputRequest.Encoded,
    said: Pick<McpQuestionAsk, "message" | "form" | "notes" | "page">,
  ): Mutable<McpQuestionAsk> => {
    const question: Mutable<McpQuestionAsk> = {
      key: request.key,
      callId: call.callId,
      conversationId: call.conversationId,
      server: call.server,
      tool: call.tool,
      ...said,
    };

    if (call.source !== undefined) question.source = call.source;

    if (call.prompt !== undefined) question.prompt = call.prompt;

    if (call.app === true) question.app = true;

    if (call.task !== undefined) question.task = call.task;

    if (request.era !== undefined) question.era = request.era;

    return question;
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

    // "Decline in this Session": the server's requests are declined unseen, as a credential form is.
    if (call.questions.isDeclined(call.server)) {
      const capped = await endUnseen(message, "decline", MCP_DECLINED_IN_SESSION_REASON);

      return capped ? CANCELLED : { kind: "answered", result: { action: "decline" } };
    }

    if (mode === "url") return answerPage(request, params.value);

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

    const question = askOf(request, {
      message: plainMessage(message),
      form,
      notes: [...notes, ...cutNotes(message)],
    });

    return keepOrAsk(request, question, answeredFields);
  };

  /**
   * A question that passed its checks, kept for later or shown: a Modern server's, on a call that defers, is kept and
   * the round ends (`defer`); any other waits on a card while the call's clock stands still. `answeredFields` names what
   * an accepted form gave, `page` is set for a page question.
   */
  const keepOrAsk = async (
    request: typeof McpInputRequest.Encoded,
    question: McpQuestionAsk,
    fieldsOf: typeof answeredFields,
  ): Promise<typeof McpInputAnswer.Encoded> => {
    const { form, page } = question;

    const seen =
      page === undefined
        ? undefined
        : { page: { host: page.host, origin: originOf(page.url) }, key: question.key };

    // A Modern server's question, or a Legacy `-32042`'s, is kept for later: the round ends, and the call waits for the
    // owner after it. A call that keeps pages only (a read) keeps a Legacy server's, never a Modern one's.
    if (
      request.mode === "deferrable" &&
      (call.defers === true ||
        (call.keepsPages === true && page !== undefined && request.era !== "modern"))
    ) {
      const kept = await Effect.runPromise(call.questions.defer(question));

      if (kept === "deferred") return { kind: "defer" };

      note(
        "cancel",
        "cloudpid",
        [],
        kept === "capped" ? MCP_ELICITATION_CAP_REASON : MCP_QUESTION_UNRECORDED_REASON,
        seen,
      );

      return CANCELLED;
    }

    // A page of a Modern server's round answered on the spot would send the call again before the owner has been there:
    // a call that keeps no questions and does not wait at pages live is never offered one (`url` is declared only to a
    // caller that defers, or waits live), so a server that asks anyway is told `cancel`.
    if (request.mode === "deferrable" && page !== undefined && call.livePages !== true) {
      note("cancel", "cloudpid", [], MCP_PAGE_NOT_KEPT_REASON, seen);

      return CANCELLED;
    }

    await Effect.runPromise(call.hold.pause);

    const outcome: McpQuestionOutcome = await Effect.runPromise(
      call.questions.ask(question),
      call.signal === undefined ? undefined : { signal: call.signal },
    ).catch(
      // Stop interrupted the wait (the question is withdrawn): nobody answers, the server may ask again.
      (): McpQuestionOutcome => ({
        action: "cancel",
        by: "cloudpid",
        reason: MCP_RUN_STOPPED_REASON,
      }),
    );

    // A page the owner opened: the server goes on, and the call's clock stays stopped until the page is finished. A page the
    // call waits at to send again (`retry`) is not: the owner's Done answers it, and the call goes on at once.
    if (page !== undefined && outcome.action === "accept" && question.retry !== true) {
      void Effect.runPromise(call.questions.whileOpen(call.callId, question.key)).finally(() =>
        Effect.runPromise(call.hold.resume),
      );
    } else await Effect.runPromise(call.hold.resume);

    if (outcome.action === "accept") {
      accepted.set(
        request.key,
        note("accept", "owner", [...fieldsOf(form, outcome.content)], undefined, seen),
      );

      return {
        kind: "answered",
        result:
          page === undefined
            ? { action: "accept", content: mutableContent(outcome.content) }
            : { action: "accept" },
      };
    }

    note(outcome.action, outcome.by, [], outcome.reason, seen);

    return { kind: "answered", result: { action: outcome.action } };
  };

  /**
   * A URL-mode question: the page the server asks the owner to open. It is declined unseen, with the reason, when the
   * address is one cloudpid never sends the owner to (`checkElicitationUrl`), and refused `-32602` when it is not an
   * address; otherwise the owner is shown the page, and Open answers the server `accept` at once.
   */
  const answerPage = async (
    request: typeof McpInputRequest.Encoded,
    params: McpElicitParams,
  ): Promise<typeof McpInputAnswer.Encoded> => {
    const { message, url } = params;

    const checked =
      url === undefined
        ? Result.fail<ElicitationPageProblem>({
            kind: "malformed",
            reason: "the request has no page address",
          })
        : checkElicitationUrl(url, call.questions.isOwnHost);

    if (Result.isFailure(checked)) {
      const { kind, reason } = checked.failure;

      if (kind === "malformed") {
        const capped = await endUnseen(message, "cancel", reason);

        return capped ? CANCELLED : unsupported(reason);
      }

      const where = Option.liftThrowable(() => new URL(url ?? ""))();

      const capped = await endUnseen(
        message,
        "decline",
        reason,
        undefined,
        Option.isSome(where)
          ? { host: where.value.hostname, origin: where.value.origin }
          : undefined,
        request.key,
      );

      return capped ? CANCELLED : { kind: "answered", result: { action: "decline" } };
    }

    const question = askOf(request, {
      message: plainMessage(message),
      form: { fields: [] },
      page: checked.success,
      notes: cutNotes(message),
    });

    // A Legacy `-32042`, or a Modern server's page, is kept for later and the call is sent again once the owner is done:
    // "Done, try again".
    // A task's page is not sent again: its Open answers the server (`tasks/update`).
    if (request.mode === "deferrable" && call.task === undefined) question.retry = true;

    return keepOrAsk(request, question, answeredFields);
  };

  const onInput: Eliciting["onInput"] = (request) => {
    // A Modern server's question has no error to be told: a form cloudpid cannot take is a `cancel` there, never a
    // refusal, which would end the call (`docs/architecture/mcp-server-requests.md` → Elicitation requests, Answers).
    const running = answerInput(request).then((answer) =>
      request.mode === "deferrable" && answer.kind === "refused" ? CANCELLED : answer,
    );

    answering.add(running);
    void running.finally(() => answering.delete(running)).catch(() => undefined);

    return running;
  };

  return {
    onInput,
    idle: () => Promise.allSettled(answering).then(() => undefined),
    // The server's own cancellation, or the host's word that a set change ended the question (`reason`): then an answer
    // the owner gave first never reached the server (the host replaced it with `cancel`), and its record and line say so.
    onInputEnded: async (key, reason) => {
      await Effect.runPromise(
        call.questions.withdraw(call.callId, key, reason ?? stoppedWaiting(call.server)),
      );

      if (reason === undefined) return;

      const detail = accepted.get(key);

      if (detail !== undefined) {
        detail.action = "cancel";
        detail.by = "cloudpid";
        detail.reason = reason;
        detail.fields = [];
        accepted.delete(key);
      }

      await Effect.runPromise(call.questions.overturn(call.callId, key, reason));
    },
    onInputComplete: (key) => {
      // The record of the page says the owner finished there, whether the call's note of it came first or not.
      finished.add(key);

      const detail = pages.get(key);

      if (detail !== undefined) detail.finished = true;

      return Effect.runPromise(call.questions.complete(call.callId, key));
    },
    get asked() {
      return asked;
    },
  };
};

/** Why a question's card was withdrawn when its server stopped waiting for the answer (`onInputEnded`). */
export const stoppedWaiting = (server: string) => `${server} stopped waiting`;

/**
 * What became of a question that was not accepted, in `voice`'s words ("The user" to the model, "You" to the owner), with
 * no closing mark; absent for one that was accepted. Whatever the server wrote in the reason is cut to a line and kept
 * from reading as markup.
 */
export const notAcceptedWords = (
  detail: McpElicitationDetail,
  voice: "You" | "The user",
): string | undefined => {
  if (detail.action === "accept") return undefined;

  const ended = detail.action === "decline" ? "declined" : "cancelled";

  if (detail.by === "owner") return `${voice} ${ended} ${detail.server}'s request for input`;

  const why = plainLine(detail.reason ?? "no reason given", 400).replace(/[<>]/g, "");

  return `cloudpid ${ended} ${detail.server}'s request for input: ${why}`;
};

/** What the model is told of one question that was not answered by the owner's submit. */
const lineOf = (detail: McpElicitationDetail): string | undefined => {
  const words = notAcceptedWords(detail, "The user");

  if (words === undefined) return undefined;

  return detail.by === "owner" ? `${words}. Don't repeat the call unless the user asks.` : words;
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
