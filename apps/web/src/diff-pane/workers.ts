// The Diff pane's workers (`docs/spec.md` → Diffs and review → Diff pane), made when the Pane opens and shut 30 s after
// it closes (`keeper.ts`): the `@pierre/diffs` Worker Pool that highlights, sized to half the cores and kept between 2
// and 4, and the dedicated worker that lines file pairs up (`line-up.worker.ts`). Part of the Pane's lazy chunk.
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
// Vite bundles the library's highlighting worker as a module of its own and hands its URL.
import highlightWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { DIFF_THEME } from "../diff-theme.ts";
import { keeperOf } from "./keeper.ts";
import type { LineUp, LineUpRequest } from "./line-up.ts";
import { poolSize } from "./loading.ts";

/**
 * The library's limits, the Pane's and its pool's: lines over 1,000 characters and files over 100,000 lines are shown
 * plain.
 */
export const DIFF_LIMITS = {
  tokenizeMaxLineLength: 1000,
  maxLineDiffLength: 1000,
  tokenizeMaxLength: 100_000,
} as const;

const timers = {
  setTimer: (run: () => void, ms: number) => window.setTimeout(run, ms),
  clearTimer: (timer: number) => {
    window.clearTimeout(timer);
  },
};

/** The highlighting Worker Pool, shared by every Diff pane open on the page. */
export const workerPool = keeperOf<WorkerPoolManager, number>({
  create: () =>
    getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new Worker(highlightWorkerUrl, { type: "module" }),
        poolSize: poolSize(navigator.hardwareConcurrency),
      },
      highlighterOptions: {
        theme: DIFF_THEME,
        lineDiffType: "word",
        maxLineDiffLength: DIFF_LIMITS.maxLineDiffLength,
        tokenizeMaxLineLength: DIFF_LIMITS.tokenizeMaxLineLength,
      },
    }),
  dispose: () => {
    terminateWorkerPoolSingleton();
  },
  ...timers,
});

/** Lines file pairs up off the page, one at a time. */
export interface LineUpWorker {
  readonly lineUp: (request: LineUpRequest) => Promise<LineUp>;
  readonly terminate: () => void;
}

const startLineUpWorker = (): LineUpWorker => {
  const worker = new Worker(new URL("./line-up.worker.ts", import.meta.url), { type: "module" });

  const waiting = new Map<
    number,
    { readonly resolve: (result: LineUp) => void; readonly reject: (error: Error) => void }
  >();

  let asked = 0;

  const failAll = (error: Error) => {
    for (const { reject } of waiting.values()) reject(error);

    waiting.clear();
  };

  worker.addEventListener("message", (event: MessageEvent<{ id: number; result: LineUp }>) => {
    const answer = waiting.get(event.data.id);

    waiting.delete(event.data.id);
    answer?.resolve(event.data.result);
  });
  worker.addEventListener("error", () => {
    failAll(new Error("The line-up worker failed."));
  });

  return {
    lineUp: (request) =>
      // @effect-diagnostics-next-line newPromise:off -- a worker's answer, for React callers.
      new Promise((resolve, reject) => {
        asked += 1;
        waiting.set(asked, { resolve, reject });
        worker.postMessage({ id: asked, request });
      }),
    terminate: () => {
      worker.terminate();
      failAll(new Error("The line-up worker was shut."));
    },
  };
};

/** The line-up worker, shared by every Diff pane open on the page. */
export const lineUpWorker = keeperOf<LineUpWorker, number>({
  create: startLineUpWorker,
  dispose: (worker) => {
    worker.terminate();
  },
  ...timers,
});
