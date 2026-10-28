// The Diff pane's workers (`docs/architecture/diffs-and-review.md` → Diff pane), made when the Pane opens and shut 30 s after
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
import { lineUpClient, type LineUpClient, type WorkerLike } from "./line-up-client.ts";
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

/** A line-up worker (`line-up.worker.ts`), as the client takes it. */
const spawnLineUpWorker = (): WorkerLike => {
  const worker = new Worker(new URL("./line-up.worker.ts", import.meta.url), { type: "module" });

  return {
    postMessage: (message) => {
      worker.postMessage(message);
    },
    terminate: () => {
      worker.terminate();
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        worker.addEventListener("message", (event) => {
          listener({ data: event.data });
        });
      } else {
        worker.addEventListener("error", () => {
          listener({});
        });
      }
    },
  };
};

/** The line-up worker's client, shared by every Diff pane open on the page. */
export const lineUpWorker = keeperOf<LineUpClient, number>({
  create: () => lineUpClient(spawnLineUpWorker),
  dispose: (worker) => {
    worker.terminate();
  },
  ...timers,
});
