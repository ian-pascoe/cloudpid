// Throwaway probe for #409 (Verify MCP host ↔ engine RPC on a deployed stage). Not part of cloudpid; never merged.
//
// Stands in for `McpWorker` (ADR-0038): a plain Worker whose `McpEngine` entrypoint the probe's host object binds one
// way. The engine keeps nothing between calls; what it sees is written to a `Recorder` DO of its own script (so it
// survives a reset of the host's script), read back from `/records?run=…`. `/slow?ms=…` answers after `ms`, with its
// headers delayed, for the six-connection checks.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import * as workers from "cloudflare:workers";

interface Env {
  readonly VERSION: string;
  readonly PROBE_KEY: string;
  readonly SELF_URL: string;
  readonly RECORDER: DurableObjectNamespace<Recorder>;
}

export class Recorder extends DurableObject {
  async record(event: Record<string, unknown>): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
    await this.ctx.storage.put("seq", seq);
    await this.ctx.storage.put(`e:${String(seq).padStart(6, "0")}`, event);
  }

  async list(): Promise<unknown[]> {
    const map = await this.ctx.storage.list({ prefix: "e:" });
    return [...map.values()];
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorText = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** The trace context this invocation runs under, and that of a custom span opened in it. */
export const traceOf = (label: string) => {
  const tracing = (workers as unknown as { tracing?: any }).tracing;
  if (tracing === undefined) return { label, tracing: "absent" };
  const active = tracing.getActiveSpan?.();
  const custom = tracing.enterSpan(`probe.${label}`, (span: any) => ({
    isTraced: span.isTraced,
    ...span.spanContext(),
  }));
  return {
    label,
    active: active === undefined ? null : { isTraced: active.isTraced, ...active.spanContext() },
    custom,
    startSpanArity: tracing.startSpan?.length,
    enterSpanArity: tracing.enterSpan?.length,
  };
};

const memory = () => {
  try {
    const process = (globalThis as any).process;
    return process?.memoryUsage?.() ?? "unavailable";
  } catch (error) {
    return errorText(error);
  }
};

interface CallRequest {
  readonly run: string;
  /** onProgress calls to make, at `progressEveryMs` apart, before asking for input. */
  readonly progress?: number;
  readonly progressEveryMs?: number;
  /** Ask the caller a question through `onInput` after the progress. */
  readonly input?: boolean;
  /** After that, hold the call this long (or until aborted), recording a tick every `tickMs`. */
  readonly holdMs?: number;
  readonly tickMs?: number;
  /** Also call onProgress at each tick (to see whether a callback still works after a reset or deploy). */
  readonly progressOnTick?: boolean;
  /** Hold a streaming fetch to `/hang` open throughout (does the server request end when the call is cut?). */
  readonly fetchHang?: boolean;
  /** Run the hold inside `ctx.waitUntil` as well (does it outlive a caller that died?). */
  readonly useWaitUntil?: boolean;
}

interface Hooks {
  onProgress(progress: Record<string, unknown>): unknown;
  onInput(question: Record<string, unknown>): unknown;
  untilAborted(): unknown;
}

export class McpEngine extends WorkerEntrypoint<Env> {
  private async record(run: string, event: string, data: Record<string, unknown> = {}) {
    try {
      await this.env.RECORDER.getByName(run).record({
        t: Date.now(),
        hop: "engine",
        version: this.env.VERSION,
        event,
        ...data,
      });
    } catch (error) {
      console.log(`record failed ${run} ${event}: ${errorText(error)}`);
    }
  }

  /** The stub of `McpEngine.call`: progress, a question, then a held call, with the abort callback raced throughout. */
  async call(request: CallRequest, hooks: Hooks) {
    const started = Date.now();
    const run = request.run;
    await this.record(run, "call.start", {
      hooksKind: hooks instanceof RpcTarget ? "RpcTarget" : typeof hooks,
      onProgressType: typeof hooks.onProgress,
      trace: traceOf("engine.call"),
    });

    let aborted:
      | { how: "resolved" | "rejected"; at: number; value?: unknown; error?: string }
      | undefined;
    const abortPromise = Promise.resolve()
      .then(() => hooks.untilAborted())
      .then(
        (value) => {
          aborted = { how: "resolved", at: Date.now() - started, value };
          return aborted;
        },
        (error) => {
          aborted = { how: "rejected", at: Date.now() - started, error: errorText(error) };
          return aborted;
        },
      );
    void abortPromise.then((outcome) => this.record(run, "untilAborted.settled", outcome));

    if (request.fetchHang === true) {
      const hang = (async () => {
        let bytes = 0;
        try {
          const response = await fetch(`${this.env.SELF_URL}/hang?key=${this.env.PROBE_KEY}&run=${run}`);
          const reader = response.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
          }
          await this.record(run, "hang.client.end", { bytes, elapsed: Date.now() - started });
        } catch (error) {
          await this.record(run, "hang.client.error", { bytes, error: errorText(error) });
        }
      })();
      void hang;
    }

    const progressTimes: number[] = [];
    const progressErrors: string[] = [];
    const count = request.progress ?? 0;
    const every = request.progressEveryMs ?? 100;
    const progressCalls: Promise<unknown>[] = [];
    for (let i = 0; i < count && aborted === undefined; i++) {
      const sent = Date.now();
      progressCalls.push(
        Promise.resolve(hooks.onProgress({ i, sent })).then(
          () => progressTimes.push(Date.now() - sent),
          (error) => progressErrors.push(errorText(error)),
        ),
      );
      await sleep(every);
    }
    await Promise.allSettled(progressCalls);

    let answer: unknown;
    let inputMs: number | undefined;
    if (request.input === true && aborted === undefined) {
      const asked = Date.now();
      try {
        answer = await Promise.race([hooks.onInput({ question: "proceed?" }), abortPromise]);
      } catch (error) {
        answer = { error: errorText(error) };
      }
      inputMs = Date.now() - asked;
    }

    const holdMs = request.holdMs ?? 0;
    const tickMs = request.tickMs ?? 1000;
    let ticks = 0;
    const holdStarted = Date.now();
    let holdDone: () => void = () => {};
    if (request.useWaitUntil === true) {
      this.ctx.waitUntil(
        new Promise<void>((resolve) => (holdDone = resolve)).then(() =>
          this.record(run, "waitUntil.end", { elapsed: Date.now() - started }),
        ),
      );
    }
    while (aborted === undefined && Date.now() - holdStarted < holdMs) {
      await Promise.race([sleep(tickMs), abortPromise]);
      if (aborted !== undefined) break;
      ticks++;
      let progressResult: string | undefined;
      if (request.progressOnTick === true) {
        try {
          await hooks.onProgress({ tick: ticks });
          progressResult = "ok";
        } catch (error) {
          progressResult = errorText(error);
        }
      }
      await this.record(run, "tick", {
        tick: ticks,
        elapsed: Date.now() - started,
        progressResult,
      });
    }

    holdDone();
    const result = {
      version: this.env.VERSION,
      trace: traceOf("engine.call.end"),
      elapsed: Date.now() - started,
      progress: {
        sent: progressCalls.length,
        acked: progressTimes.length,
        errors: progressErrors,
        rttMs: summarize(progressTimes),
      },
      answer,
      inputMs,
      ticks,
      aborted,
    };
    await this.record(run, "call.end", result);
    return result;
  }

  /** A byte stream of `mib` MiB in 64 KiB chunks, made as it is pulled. */
  big(run: string, mib: number) {
    const chunk = 64 * 1024;
    const total = mib * 1024 * 1024;
    let sent = 0;
    const record = (event: string, data: Record<string, unknown>) => this.record(run, event, data);
    void record("big.start", { mib, memory: memory() });
    return new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        if (sent >= total) {
          controller.close();
          void record("big.end", { sent, memory: memory() });
          return;
        }
        const bytes = new Uint8Array(Math.min(chunk, total - sent));
        bytes.fill(sent / chunk);
        sent += bytes.length;
        if (sent % (1024 * 1024) === 0) void record("big.produced", { mib: sent / (1024 * 1024) });
        controller.enqueue(bytes);
      },
    });
  }

  /** Answers after `ms`: a slow RPC call for the six-connection checks. */
  async sleep(ms: number) {
    await sleep(ms);
    return { ms, trace: traceOf("engine.sleep") };
  }

  version() {
    return this.env.VERSION;
  }

  async fetch(request: Request): Promise<Response> {
    return handle(request, this.env, this.ctx);
  }
}

const summarize = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
};

const handle = async (request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/slow") {
    const ms = Number(url.searchParams.get("ms") ?? "3000");
    await sleep(ms);
    return new Response(`slow ${ms}`, { headers: { "cache-control": "no-store" } });
  }
  if (url.searchParams.get("key") !== env.PROBE_KEY) return new Response("no", { status: 403 });
  if (url.pathname === "/hang") {
    const run = url.searchParams.get("run") ?? "";
    const started = Date.now();
    const recordHang = (event: string, data: Record<string, unknown>) =>
      env.RECORDER.getByName(run).record({ t: Date.now(), hop: "mcp-server", event, ...data });
    let timer: ReturnType<typeof setInterval> | undefined;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          if (Date.now() - started > 120_000) {
            clearInterval(timer);
            controller.close();
            ctx?.waitUntil(recordHang("hang.server.closed", { sent }));
            return;
          }
          sent++;
          controller.enqueue(new TextEncoder().encode("."));
        }, 1000);
      },
      cancel(reason) {
        clearInterval(timer);
        ctx?.waitUntil(
          recordHang("hang.server.cancelled", { sent, elapsed: Date.now() - started, reason: String(reason) }),
        );
      },
    });
    ctx?.waitUntil(recordHang("hang.server.start", {}));
    return new Response(body, { headers: { "content-type": "text/plain" } });
  }
  if (url.pathname === "/records") {
    const run = url.searchParams.get("run") ?? "";
    return Response.json(await env.RECORDER.getByName(run).list());
  }
  if (url.pathname === "/version") return Response.json({ version: env.VERSION });
  return new Response("probe-409 engine", { status: 404 });
};

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
