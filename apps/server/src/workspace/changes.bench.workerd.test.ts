// The Changes measurements (docs/spec.md → Known risks and spikes): isomorphic-git's `statusMatrix({ refresh: false })`
// and `readBlob`, and the whole listing, in a Workspace DO, on repos real git made of 1,000, 5,000 and 20,000 tracked
// files (`changes.setup.ts`). Skipped unless `CHANGES_BENCH=1`. Times are taken here, around each call: workerd's clock
// stands still while code runs. The heap is sampled from outside (`scripts/heap-poll.mjs`), so each phase is logged
// with its start and end and kept apart by idle gaps:
//
//   CHANGES_BENCH=1 pnpm exec vitest run --project workerd-workspace --inspect --no-file-parallelism \
//     src/workspace/changes.bench.workerd.test.ts
//   node scripts/heap-poll.mjs core:user:vitest-plugin-runner-workerd-workspace 20 > heap.log
// @effect-diagnostics asyncFunction:off globalConsole:off globalDate:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { BENCH_EDITED, BENCH_SIZES, benchEdit, benchEdited, benchFile } from "./changes.repos.ts";

const repos = inject("changesRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** The idle time between phases, so the heap samples tell them apart. */
const GAP_MS = 1_500;

const gap = () => new Promise((resolve) => setTimeout(resolve, GAP_MS));

/** How many reads the heap's pass makes between turns of the event loop. */
const YIELD_EVERY = 20;

/** Run `phase`, logging when it started and ended, and how long it took. */
const timed = async <A>(label: string, phase: () => Promise<A>): Promise<{ result: A; ms: number }> => {
  const start = Date.now();
  const result = await phase();
  const end = Date.now();

  console.log(`PHASE ${JSON.stringify({ label, start, end, ms: end - start, result })}`);

  return { result, ms: end - start };
};

describe.skipIf(repos["bench-1000"] === undefined)("the Changes measurements", () => {
  for (const count of BENCH_SIZES) {
    it(`lists a repo of ${count} tracked files`, { timeout: 1_800_000 }, async () => {
      const stub = env.WORKSPACES.getByName(`changes-bench-${count}-${Date.now()}`);
      const dir = `/workspace/bench${count}`;
      const edited = new Set(benchEdited(count));

      const tree = Array.from({ length: count }, (_, index) => {
        const [path, content] = benchFile(index);

        return [`${dir}/${path}`, edited.has(index) ? benchEdit(index) : content] as const;
      });

      const dotGit = Object.entries(repos[`bench-${count}`] ?? {}).map(
        ([path, base64]) => [`${dir}/${path}`, bytesOf(base64)] as const,
      );

      // In batches, so no call carries megabytes.
      const put = async (files: ReadonlyArray<readonly [string, Uint8Array | string]>) => {
        for (let index = 0; index < files.length; index += 1_000) {
          await stub.putFiles(files.slice(index, index + 1_000));
        }
      };

      await timed(`put-${count}`, async () => {
        await put(dotGit);
        await put(tree);
      });
      await gap();
      await timed(`idle-${count}`, async () => gap());

      const status = await timed(`status-${count}`, () => stub.measureStatus(dir));

      expect(status.result).toEqual({ tracked: count, changed: BENCH_EDITED });
      await gap();

      const paths = Array.from({ length: Math.min(count, 100) }, (_, index) => benchFile(index)[0]);

      await timed(`blobs-${count}`, () => stub.measureBlobs(dir, paths));
      await gap();

      const listed = await timed(`listing-${count}`, () => stub.measureListing(dir));

      expect(listed.result).toBe(BENCH_EDITED);
      await gap();
      await stub.releaseMeasured();
      await gap();

      // Stat drift: every file written again with the same bytes, as a sync that rewrites them would. Every stat already
      // differs from what git recorded (the Workspace's files have their own inodes and times), so nothing is trusted
      // and nothing changes: still only the edited files, in about the same time.
      await timed(`touch-${count}`, () => put(tree));
      await gap();

      const drifted = await timed(`drifted-${count}`, () => stub.measureStatus(dir));

      expect(drifted.result).toEqual({ tracked: count, changed: BENCH_EDITED });
      await stub.releaseMeasured();
      await gap();

      // Again for the heap: each phase waits a turn every `YIELD_EVERY` reads, so the samples see it while it runs.
      await timed(`status-heap-${count}`, () => stub.measureStatus(dir, YIELD_EVERY));
      await stub.releaseMeasured();
      await gap();
      await timed(`blobs-heap-${count}`, () => stub.measureBlobs(dir, paths, YIELD_EVERY));
      await stub.releaseMeasured();
      await gap();
      await timed(`listing-heap-${count}`, () => stub.measureListing(dir, YIELD_EVERY));
      await stub.releaseMeasured();
      await gap();
    });
  }
});
