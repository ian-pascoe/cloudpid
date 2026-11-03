// @effect-diagnostics *:off -- a build script on the owner's machine, not Effect code (the bundle carries only `effect/Predicate`).
/**
 * What the build checks of the bundle (docs/architecture/mcp-endpoint.md → The `/cloudpid` command): it runs on the
 * owner's laptop, so nothing of the Workers side may be in it, and what it leaves external must be there to find: Node's
 * own modules and the pi host packages it declares as peers. The oxlint `no-restricted-imports` in `.oxlintrc.json` says
 * the same of the source; this reads what the bundler actually included, which a dependency's own imports can change.
 */

/** The part of `bun build --metafile` the check reads. */
export interface Metafile {
  readonly inputs: {
    readonly [path: string]: { readonly imports?: ReadonlyArray<MetafileImport> };
  };
  readonly outputs: {
    readonly [path: string]: { readonly imports?: ReadonlyArray<MetafileImport> };
  };
}

interface MetafileImport {
  readonly path: string;
  readonly external?: boolean;
}

/** Modules the bundle must never hold or import: [what to look for in a path, why]. */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(^|[/\\])cloudflare:|[/\\]@cloudflare[/\\]|^@cloudflare\//,
    "Workers code (cloudflare:*, @cloudflare/*)",
  ],
  [/(^|[/\\])workerd([/\\]|$)/, "workerd"],
  [/(^|[/\\])alchemy([/\\]|$)|@alchemy\.run/, "alchemy"],
  [/@earendil-works[/\\]pi-durable/, "pi-durable"],
  [/@cloudpid[/\\]extensions|packages[/\\]extensions[/\\]/, "@cloudpid/extensions"],
];

/** Whether an external import is Node's own. */
const isNodeBuiltin = (path: string): boolean => path.startsWith("node:");

/** The package an import path names: `@scope/name` or `name`. */
const packageOf = (path: string): string => {
  const parts = path.split("/");

  return path.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? path);
};

/**
 * What is wrong with the bundle, one sentence each (none when it is fine): a forbidden module among its inputs or
 * imports, and an external import that is neither a Node module nor one of `peers` (it would fail to load on the owner's
 * machine, where only the host's own packages are there).
 */
export const bundleProblems = (
  metafile: Metafile,
  peers: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];

  const paths = [
    ...Object.keys(metafile.inputs),
    ...Object.values(metafile.inputs).flatMap((input) =>
      (input.imports ?? []).map((item) => item.path),
    ),
    ...Object.values(metafile.outputs).flatMap((output) =>
      (output.imports ?? []).map((item) => item.path),
    ),
  ];

  for (const path of new Set(paths)) {
    for (const [pattern, name] of FORBIDDEN) {
      if (pattern.test(path)) problems.push(`the bundle reaches ${name}: ${path}`);
    }
  }

  // Bun lists an external import on the input that makes it, esbuild on the output: look in both.
  const external = new Set(
    [...Object.values(metafile.inputs), ...Object.values(metafile.outputs)].flatMap((file) =>
      (file.imports ?? []).flatMap((item) => (item.external === true ? [item.path] : [])),
    ),
  );

  for (const path of external) {
    if (isNodeBuiltin(path) || peers.includes(packageOf(path))) continue;

    problems.push(
      `the bundle leaves ${path} external, and it is neither a Node module nor a declared peer dependency`,
    );
  }

  return problems;
};
