// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off globalTimers:off -- pi-durable's task seam is Promise-based.
// What the inline window, the follower and the agent's MCP task tools share (`docs/architecture/mcp-server-requests.md` →
// MCP tasks): the Session's options for them, the context of a `tasks/*` request, and the waits that end early.
import type { McpHostRequestContext } from "@cloudpid/mcp/types";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { InboxDoc, type ConversationId, type DocumentObserver } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import type { Mutable } from "effect/Types";
import type { McpCallOrigin } from "./exchange.ts";
import type { McpAppRecorder } from "./apps.ts";
import type { McpNotices } from "./notices.ts";
import type { ViewTaskStore } from "./task-view-store.ts";
import type { McpTaskLimits } from "./task-poll.ts";
import type { McpTaskStorage } from "./task-results.ts";
import type { McpTaskRecord } from "./task-state.ts";

/** The times a test shortens; each defaults to the spec's (`./task-policy.ts`). */
export type McpTasksTiming = McpTaskLimits & {
  /** The inline window, instead of `min(timeout, 10 min)`. */
  readonly windowMs?: number;
  /** The wait between polls, instead of the cadence. */
  readonly pollMs?: number;
  /** How long an ignored cancel is waited for before cloudpid stops following, instead of 2 minutes. */
  readonly cancelGraceMs?: number;
  /** How long an App View's request waits for its MCP task, instead of 15 minutes. */
  readonly viewWindowMs?: number;
};

/** What the Session gives the `mcp` extension to follow MCP tasks. */
export type McpTasksOptions = {
  /** The object's key-value storage, where results are pooled. */
  readonly storage: McpTaskStorage;
  readonly timing?: McpTasksTiming | undefined;
  /**
   * A submission the follower made to the root conversation, whose Run the owner is told the end of: the host records it
   * for its notification (`notify-submissions`). Absent: nobody is told.
   */
  readonly submitted?: ((id: SubmissionId) => void) | undefined;
  /**
   * Called after each phase of a follower, which may have ended it or moved the time it sleeps to: the host settles, so
   * the alarm and the Registry's count follow (`docs/architecture/mcp-server-requests.md` → MCP tasks, Following, not
   * running). Absent: the next settle does.
   */
  readonly changed?: (() => void) | undefined;
  /** Where a note for an end the owner caused is written (`McpNotices.write`); absent: no note. */
  readonly write?: McpNotices["write"] | undefined;
  /**
   * Redacts the Session's held Secrets from a text a server wrote (a task's `statusMessage`, a `failed` task's message)
   * before it is stored or shown. Absent: nothing is held.
   */
  readonly redact?: ((text: string) => Promise<string>) | undefined;
  /**
   * Where the record of an App tool's call is kept when its MCP task completes (`McpToolOptions.apps`): the View of the
   * original call gets the result whenever it arrives. Absent: none is kept.
   */
  readonly apps?: McpAppRecorder | undefined;
  /**
   * The App Views' tasks and the places held for calls offered one, which count toward the caps beside the agent's: an
   * agent's offer takes a place from it too (`./task-view-store.ts`). Present when the Session follows Views' tasks.
   */
  readonly views?: Pick<ViewTaskStore, "offer"> | undefined;
};

/**
 * The context of a `tasks/*` request for `record`: the agent's, in the conversation that started it, and for a stdio
 * server's task in the Workspace whose Container runs it.
 */
export const taskContext = (
  origin: McpCallOrigin,
  record: Pick<McpTaskRecord, "callId" | "conversation" | "workspace">,
): McpHostRequestContext => {
  const ctx: Mutable<McpHostRequestContext> = {
    origin: "agent",
    callId: record.callId,
    conversation: String(record.conversation),
  };

  if (origin.session !== undefined) ctx.session = origin.session;

  // A stdio server's task is the Workspace's it started in, not the Session's.
  const workspace = record.workspace ?? origin.workspace;

  if (workspace !== undefined) ctx.workspace = workspace;

  return ctx;
};

/** A promise that resolves when any of `signals` aborts, and never without one. */
export const abortedBy = (signals: ReadonlyArray<AbortSignal>) =>
  new Promise<void>((resolve) => {
    for (const signal of signals) {
      if (signal.aborted) return resolve();

      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });

/** Whether a steer is queued for a conversation: its owner sent something the Run should take now. */
export const steerQueued = (
  inbox: { readonly items: ReadonlyArray<{ readonly mode: string }> } | null | undefined,
): boolean => Arr.some(inbox?.items ?? [], (item) => item.mode === "steer");

/** Why a wait ended. */
export type Woke = "time" | "steered" | "stopped" | "changed";

/**
 * Wait `ms`, ending early when a steer is queued for `conversation`, when `stop` aborts, or, with `changed`, when
 * `changed` resolves. Watches the conversation's inbox for the wait only.
 */
export const sleepUntilWoken = async (
  observer: DocumentObserver,
  conversation: ConversationId,
  context: Context,
  ms: number,
  stop: AbortSignal | undefined,
  changed?: Promise<void>,
): Promise<Woke> => {
  if (stop?.aborted === true) return "stopped";

  const inbox = await observer.watchDoc(InboxDoc, conversation, context);

  try {
    if (steerQueued(inbox?.value)) return "steered";

    const done = new AbortController();
    const waits: Array<Promise<Woke>> = [];

    waits.push(
      new Promise<Woke>((resolve) => {
        const timer = setTimeout(() => resolve("time"), Math.max(0, ms));

        done.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      }),
    );

    if (stop !== undefined) waits.push(abortedBy([stop]).then(() => "stopped" as const));

    if (changed !== undefined) waits.push(changed.then(() => "changed" as const));

    if (inbox !== undefined) {
      waits.push(
        new Promise<Woke>((resolve) => {
          inbox.start(() => {
            if (steerQueued(inbox.value)) resolve("steered");

            return Promise.resolve();
          });
        }),
      );
    }

    const woke = await Promise.race(waits);

    done.abort();

    return woke;
  } finally {
    await inbox?.stop();
  }
};
