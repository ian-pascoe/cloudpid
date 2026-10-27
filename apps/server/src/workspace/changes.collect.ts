// Reads a repo real git made into the files the workerd tests write into a Workspace (`changes.setup.ts`,
// `comparison.setup.ts`). Node only: it is not a global set-up itself, as vitest refuses a set-up module that exports more
// than its set-up.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { RepoFiles } from "./changes.repos.ts";

/** Every file below `root` (`.git` included), but those `skip` names, base64. */
export const collect = (root: string, skip: (path: string) => boolean): RepoFiles => {
  const files: Record<string, string> = {};

  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const path = relative(root, full);

      if (skip(path)) continue;

      if (statSync(full).isDirectory()) walk(full);
      else files[path] = readFileSync(full).toString("base64");
    }
  };

  walk(root);

  return files;
};
