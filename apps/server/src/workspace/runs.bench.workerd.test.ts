// The Run copy measurements (docs/architecture/risks-and-spikes.md): the copy before a Run, the copy and the frozen list at
// its end, and a live Run diff, in a Workspace DO, on the repos of 1,000, 5,000 and 20,000 tracked files the Changes
// measurements use (`changes.setup.ts`), ten files edited before the Run and ten during it. Skipped unless
// `CHANGES_BENCH=1`. Times are taken here, around each call: workerd's clock stands still while code runs.
//
//   CHANGES_BENCH=1 pnpm exec vitest run --project workerd-workspace --no-file-parallelism \
//     src/workspace/runs.bench.workerd.test.ts
// @effect-diagnostics asyncFunction:off globalConsole:off globalDate:off preferEffectArray:off preferEffectRecord:off
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { MAX_TRACKED_FILES } from "./changes.ts";
import { BENCH_EDITED, BENCH_SIZES, benchEdit, benchEdited, benchFile } from "./changes.repos.ts";

const repos = inject("changesRepos");

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** Run `phase`, logging how long it took. */
const timed = async <A>(label: string, phase: () => Promise<A>): Promise<A> => {
  const start = Date.now();
  const result = await phase();

  console.log(`RUNBENCH ${JSON.stringify({ label, ms: Date.now() - start })}`);

  return result;
};

describe.skipIf(repos["bench-1000"] === undefined)("the Run copy measurements", () => {
  for (const count of BENCH_SIZES) {
    it(`copies a repo of ${count} tracked files`, { timeout: 1_800_000 }, async () => {
      const stub = env.WORKSPACES.getByName(`runs-bench-${count}-${Date.now()}`);
      const name = `bench${count}`;
      const dir = `/workspace/${name}`;
      const edited = new Set(benchEdited(count));

      const tree = Array.from({ length: count }, (_, index) => {
        const [path, content] = benchFile(index);

        return [`${dir}/${path}`, edited.has(index) ? benchEdit(index) : content] as const;
      });

      const dotGit = Object.entries(repos[`bench-${count}`] ?? {}).map(
        ([path, base64]) => [`${dir}/${path}`, bytesOf(base64)] as const,
      );

      const put = async (files: ReadonlyArray<readonly [string, Uint8Array | string]>) => {
        for (let index = 0; index < files.length; index += 1_000) {
          await stub.putFiles(files.slice(index, index + 1_000));
        }
      };

      await put(dotGit);
      await put(tree);

      const request = { scope: "bench", conversationId: 1, firstCall: "call_1", keep: [] };

      const started = await timed(`start-${count}`, () =>
        stub.runStart({ ...request, run: "bench1abc", directory: dir }),
      );

      // A repo over `MAX_TRACKED_FILES` is the Container's git's, which a stopped Container cannot copy: nothing is started.
      if (count > MAX_TRACKED_FILES) {
        expect(started.repos[0]?.notCaptured).toBe("container_stopped");

        return;
      }

      expect(started.repos[0]?.start).toMatch(/^[0-9a-f]{40}$/);

      // Ten more files edited during the Run.
      const during = benchEdited(count).map((index) => index + 1);

      await put(
        during.map((index) => [`${dir}/${benchFile(index)[0]}`, `${benchFile(index)[1]}// run\n`]),
      );

      const live = await timed(`live-diff-${count}`, () => stub.runDiff("bench"));

      expect(live?.repos[0]?.files).toHaveLength(BENCH_EDITED);

      const ended = await timed(`end-${count}`, () =>
        stub.runEnd({ scope: "bench", run: "bench1abc", until: 1, keep: [] }),
      );

      expect(ended?.repos[0]?.end).toMatch(/^[0-9a-f]{40}$/);

      const frozen = await timed(`frozen-diff-${count}`, () => stub.runDiff("bench"));

      expect(frozen?.repos[0]?.files).toHaveLength(BENCH_EDITED);
    });
  }
});
