// The repos the Changes tests read, shared by the Node set-up that makes them with real git (`changes.setup.ts`) and
// the workerd tests that write them into a Workspace (`changes.workerd.test.ts`, `changes.bench.workerd.test.ts`).
// Nothing here may import Node built-ins: the workerd tests import it too.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off

/** A repo as the set-up hands it over: each file's path (its `.git` included) and bytes, base64. */
export type RepoFiles = Readonly<Record<string, string>>;

declare module "vitest" {
  export interface ProvidedContext {
    /** The repos real git made, by name (`changes.setup.ts`). */
    readonly changesRepos: Readonly<Record<string, RepoFiles>>;
  }
}

/** `count` numbered lines that start with `prefix`. */
export const lines = (count: number, prefix = "line"): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

/** How many lines the rewritten file has: every line changes, far more edits than lining up looks for. */
export const REWRITE_LINES = 6_000;

/** The tracked-file counts the measurements use. */
export const BENCH_SIZES = [1_000, 5_000, 20_000] as const;

/** How many of a measured repo's files are edited after its commit. */
export const BENCH_EDITED = 10;

/** File `index` of a measured repo: 50 to a directory, a few hundred bytes each. */
export const benchFile = (index: number): readonly [string, string] => [
  `src/d${Math.floor(index / 50)}/f${index}.ts`,
  Array.from(
    { length: 6 },
    (_, line) => `export const value${index}_${line} = ${index * 7 + line}; // padding text\n`,
  ).join(""),
];

/** Which files of a measured repo of `count` files are edited. */
export const benchEdited = (count: number): number[] =>
  Array.from({ length: BENCH_EDITED }, (_, index) => index * Math.floor(count / BENCH_EDITED));

/** The working-tree content of an edited file of a measured repo. */
export const benchEdit = (index: number): string => `${benchFile(index)[1]}// edited\n`;
