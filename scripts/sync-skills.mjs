#!/usr/bin/env node
// Copies the headless-safe skills from the owner's local config into `skills/` and regenerates what the Workspace DO
// mounts (`apps/server/src/workspace/bundled-skills.generated.ts`) and the attribution (`skills/NOTICE.md`). Run it to
// refresh the bundle:
//
//   node scripts/sync-skills.mjs                 # sources: ~/.pi/agent/skills, then ~/.agents/skills
//   node scripts/sync-skills.mjs --source <dir>  # a source directory (repeatable; first match wins)
//
// A skill is copied whole (symbolic links followed, so the copy holds contents, not links) minus the paths in
// `EXCLUDED_PATHS`. Only text is bundled (`skills-checks.ts`: no binaries, no large files, nothing that looks like a
// credential), and every skill must name the upstream it comes from, whose licence text is kept in `skills/LICENSES/`.
// A skill whose provenance and licence cannot be established is not bundled.
// docs/spec.md → Filesystem and tools, AGENTS.md → Skills.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TOTAL_BYTES, problemsIn } from "./skills-checks.ts";

/** Where the bundled skills come from, and the licence text kept in `skills/LICENSES/` (vendored by hand). */
export const SOURCES = {
  mattpocock: {
    repo: "mattpocock/skills",
    license: "MIT, Copyright (c) 2026 Matt Pocock",
    file: "mattpocock-skills.LICENSE",
  },
  humanlayer: {
    repo: "humanlayer/skills",
    license: "MIT, Copyright (c) 2026 HumanLayer",
    file: "humanlayer-skills.LICENSE",
  },
  shadcn: {
    repo: "shadcn/improve",
    license: "MIT, Copyright (c) 2026 shadcn",
    file: "shadcn-improve.LICENSE",
  },
  firecrawl: {
    repo: "firecrawl/anydoc",
    license: "MIT, Copyright (c) 2026 Sideguide Technologies Inc.",
    file: "firecrawl-anydoc.LICENSE",
  },
  astgrep: {
    repo: "ast-grep/agent-skill",
    license:
      "MIT, Copyright (c) 2022 Herrington Darkholme (ast-grep's licence, which the skill follows)",
    file: "ast-grep.LICENSE",
  },
  pstack: {
    repo: "backnotprop/pstack",
    license: "MIT, Copyright (c) 2026 Lauren Tan (a mirror of cursor/plugins' `pstack`)",
    file: "pstack.LICENSE",
  },
  cursorTeamKit: {
    repo: "cursor/plugins",
    license: "MIT, Copyright (c) 2026 Cursor (its `cursor-team-kit` plugin)",
    file: "cursor-team-kit.LICENSE",
  },
};

// Excluded pending the owner's confirmation of their provenance (no public upstream was found, so no licence to keep):
// address-pr-review, ast-grep-outline. If they are the owner's own, add them here with a `source` of the owner's own
// (a `SOURCES` entry and a licence text) and sync again.
// Excluded as unsafe headless: impeccable (its launcher downloads an engine binary with curl, which the image lacks, and
// its flows assume a local browser; 500 KB of the bundle).

/**
 * The skills the cloud agent gets: why, and which of `SOURCES` it comes from. Anything that needs a local app, terminal,
 * GUI or local-only tool is left out, and so is anything whose upstream and licence are not known: see the PR that added
 * this file for what was excluded and why.
 */
export const INCLUDED_SKILLS = {
  "ast-grep": {
    source: ["astgrep"],
    reason: "structural code search; the Container installs ast-grep with mise",
  },
  "code-review": { source: ["mattpocock"], reason: "two-axis diff review that runs sub-agents" },
  "codebase-design": { source: ["mattpocock"], reason: "deep-module vocabulary for design work" },
  "convert-documents-to-markdown": {
    source: ["firecrawl"],
    reason: "office documents and PDFs to Markdown with npx on the Container",
  },
  bro: { source: ["pstack"], reason: "restate the last message in plain language (user-named)" },
  deslop: { source: ["cursorTeamKit"], reason: "remove AI-generated slop from a branch's diff" },
  "diagnosing-bugs": { source: ["mattpocock"], reason: "diagnosis loop for hard bugs" },
  "domain-modeling": { source: ["mattpocock"], reason: "GLOSSARY.md and ADR upkeep" },
  "grill-me": { source: ["mattpocock"], reason: "interview to sharpen a plan" },
  "grill-with-docs": {
    source: ["mattpocock"],
    reason: "interview that records the glossary and ADRs",
  },
  grilling: { source: ["mattpocock"], reason: "relentless questioning about a plan" },
  implement: { source: ["mattpocock"], reason: "implement a spec or tickets" },
  "implement-spec": {
    source: ["mattpocock"],
    reason: "implement a spec with subagents on an integration branch",
  },
  improve: { source: ["shadcn"], reason: "audit a codebase into handoff plans" },
  pr: { source: ["mattpocock", "humanlayer"], reason: "PR body template" },
  prototype: { source: ["mattpocock"], reason: "throwaway prototypes for design questions" },
  research: { source: ["mattpocock"], reason: "primary-source research notes" },
  "setup-matt-pocock-skills": {
    source: ["mattpocock"],
    reason: "per-repo issue tracker, labels and domain docs setup",
  },
  tdd: { source: ["mattpocock"], reason: "test-driven development" },
  "to-questionnaire": {
    source: ["mattpocock"],
    reason: "a questionnaire for someone else to fill in",
  },
  "to-spec": { source: ["mattpocock"], reason: "publish a spec to the issue tracker" },
  "to-tickets": {
    source: ["mattpocock"],
    reason: "break a spec into tickets on the issue tracker",
  },
  triage: { source: ["mattpocock"], reason: "move issues through triage roles" },
  unslop: { source: ["pstack"], reason: "cut AI tells from writing (user-named)" },
  "wait-what": { source: ["mattpocock"], reason: "re-pitch a message that did not land" },
  wayfinder: { source: ["mattpocock"], reason: "plan a large piece of work as decision tickets" },
  "writing-for-agents": {
    source: ["mattpocock"],
    reason: "writing skills, AGENTS.md and CLAUDE.md",
  },
};

/** Paths (relative to the skill, `*` within a segment) left out of every copy. */
const EXCLUDED_PATHS = [
  // Harness metadata for other agents (Codex's `agents/openai.yaml` and the like); pi does not read it.
  "agents/**",
  // diagnosing-bugs: a template that blocks on a human's terminal, which a headless `bash` call would hang on.
  "scripts/hitl-loop.template.sh",
  // research: sub-skills from another upstream whose scripts need python3, which the Container only has through mise.
  "blocked-page-recovery/**",
  "rss-feeds/**",
  "DESCRIPTION.md",
];

/**
 * Text edits to files that point at what is left out above (`skill/path`: `[from, to]` pairs), so a bundled skill never
 * refers to a file that is not there. A `from` that no longer occurs fails the sync: the upstream changed, look again.
 */
const PATCHES = {
  "diagnosing-bugs/SKILL.md": [
    [
      "10. **HITL bash script.** Last resort. If a human must click, drive _them_ with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you.",
      "10. **Ask the human.** Last resort. If a human must click, ask them for each step and what they saw, so the loop is still structured. (The interactive HITL script is not bundled: it needs a terminal.)",
    ],
    [
      "a human in the loop only via `scripts/hitl-loop.template.sh`",
      "a human in the loop only by asking them, step by step",
    ],
  ],
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const licensesDir = join(skillsDir, "LICENSES");
const manifestPath = join(root, "apps/server/src/workspace/bundled-skills.generated.ts");

const matches = (path, pattern) =>
  new RegExp(
    `^${pattern
      .split("/")
      .map((segment) =>
        segment === "**"
          ? ".*"
          : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
      )
      .join("/")}$`,
  ).test(path);

const isExcluded = (path) =>
  path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules") ||
  EXCLUDED_PATHS.some((pattern) => matches(path, pattern));

/** The files below `directory` (symbolic links followed) that are bundled, as `/`-separated relative paths. */
const bundledFiles = (directory, base = directory) =>
  readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      const relativePath = relative(base, path).split(sep).join("/");

      if (isExcluded(relativePath)) return [];

      const info = statSync(path);

      return info.isDirectory() ? bundledFiles(path, base) : info.isFile() ? [relativePath] : [];
    });

const arguments_ = process.argv.slice(2);
const sources = [];

for (let index = 0; index < arguments_.length; index++) {
  if (arguments_[index] !== "--source" || arguments_[index + 1] === undefined) {
    throw new Error("usage: node scripts/sync-skills.mjs [--source <dir>]...");
  }

  sources.push(resolve(arguments_[++index]));
}

if (sources.length === 0) {
  sources.push(join(homedir(), ".pi/agent/skills"), join(homedir(), ".agents/skills"));
}

const sourceOf = (name) => {
  for (const source of sources) {
    const candidate = join(source, name);

    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }

  throw new Error(`skill ${name}: no ${name}/SKILL.md in ${sources.join(", ")}`);
};

for (const [name, { source }] of Object.entries(INCLUDED_SKILLS)) {
  for (const id of source) {
    const entry = SOURCES[id];

    if (entry === undefined) throw new Error(`skill ${name}: unknown source ${id}`);

    if (!existsSync(join(licensesDir, entry.file))) {
      throw new Error(
        `skill ${name}: skills/LICENSES/${entry.file} (the licence of ${entry.repo}) is missing`,
      );
    }
  }
}

// Read and check everything before touching `skills/`, so a failed run leaves the last good copy.
const problems = [];

const copies = Object.keys(INCLUDED_SKILLS).map((name) => {
  const source = sourceOf(name);

  return {
    name,
    source,
    files: bundledFiles(source).map((path) => {
      const bytes = readFileSync(join(source, path));

      problems.push(...problemsIn(`${name}/${path}`, bytes));

      const patches = PATCHES[`${name}/${path}`] ?? [];

      const text = patches.reduce((current, [from, to]) => {
        if (!current.includes(from)) {
          throw new Error(`${name}/${path}: the text to patch is gone upstream: ${from}`);
        }

        return current.replace(from, () => to);
      }, new TextDecoder().decode(bytes));

      return { path, text, patched: patches.length > 0 };
    }),
  };
});

const bundledBytes = copies.reduce(
  (total, { files }) =>
    total + files.reduce((sum, { text }) => sum + new TextEncoder().encode(text).length, 0),
  0,
);

if (bundledBytes > MAX_TOTAL_BYTES) {
  problems.push(
    `the skills are ${bundledBytes} bytes, more than the ${MAX_TOTAL_BYTES} the bundle may be`,
  );
}

if (problems.length > 0) throw new Error(`nothing was copied:\n${problems.join("\n")}`);

mkdirSync(skillsDir, { recursive: true });

// The licence texts are kept; every other directory is a skill, and is replaced.
for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== "LICENSES") {
    rmSync(join(skillsDir, entry.name), { recursive: true });
  }
}

for (const { name, source, files } of copies) {
  for (const { path, text, patched } of files) {
    const target = join(skillsDir, name, path);

    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, path), target, { dereference: true });

    if (patched) writeFileSync(target, text);
  }
}

const bundled = copies.flatMap(({ name, files }) =>
  files.map(({ path, text }) => ({ key: `${name}/${path}`, text })),
);

const version = createHash("sha256");

for (const { key, text } of bundled) version.update(`${key}\0${text}\0`);

const identifier = (index) => `file${index}`;

const lines = [
  "// Generated by `node scripts/sync-skills.mjs` from the skills in `skills/`: do not edit.",
  "// The files `WorkerBundle` mounts at `/workspace/.agents/skills` (docs/spec.md → Filesystem and tools). Each one is a",
  "// `?raw` import, which the Workers' bundler (alchemy's rolldown) and Vitest inline as a string. `version` is the",
  "// sha256 of the files in this order (`key`, NUL, text, NUL): computer copies the mount into a Workspace again only",
  "// when it changes, and `bundled-skills.test.ts` recomputes it.",
  // The `?raw` module declaration, for the packages (the stack's) that type-check this file without the Server's tsconfig.
  "// oxlint-disable-next-line typescript/triple-slash-reference",
  '/// <reference path="../raw.d.ts" />',
  'import type { WorkerBundleSource } from "@cloudflare/computer";',
  "",
  ...bundled.map(
    ({ key }, index) => `import ${identifier(index)} from "../../../../skills/${key}?raw";`,
  ),
  "",
  "export const BUNDLED_SKILLS: WorkerBundleSource = {",
  `  version: "sha256:${version.digest("hex")}",`,
  "  files: {",
  ...bundled.map(({ key }, index) => `    ${JSON.stringify(key)}: ${identifier(index)},`),
  "  },",
  "};",
  "",
];

writeFileSync(manifestPath, lines.join("\n"));

const notice = [
  "# Notices",
  "",
  "<!-- Generated by `node scripts/sync-skills.mjs`: do not edit. -->",
  "",
  "These skills are copies of the owner's local pi skills (`~/.pi/agent/skills`, which links into `~/.agents/skills`),",
  "refreshed with `node scripts/sync-skills.mjs`. Do not edit them here: the next sync overwrites the change. Each skill",
  "is the upstream's, minus each skill's `agents/` metadata and the paths in the script's `EXCLUDED_PATHS`. Upstream",
  "licences are kept in `skills/LICENSES/`, and a skill is bundled only when its upstream and licence are known.",
  "",
  "| Upstream | Licence | Licence text | Skills |",
  "| --- | --- | --- | --- |",
  ...Object.entries(SOURCES).flatMap(([id, entry]) => {
    const names = Object.entries(INCLUDED_SKILLS)
      .filter(([, { source }]) => source.includes(id))
      .map(([name]) => `\`${name}\``);

    return names.length === 0
      ? []
      : [
          `| [${entry.repo}](https://github.com/${entry.repo}) | ${entry.license} | [LICENSES/${entry.file}](LICENSES/${entry.file}) | ${names.join(", ")} |`,
        ];
  }),
  "",
  "`pr`: its Summary section's visuals come from Dex Horthy's `show-me` (HumanLayer's `humanlayer/skills`); see `pr/CREDITS.md`.",
  "",
];

writeFileSync(join(skillsDir, "NOTICE.md"), notice.join("\n"));

console.log(
  `${copies.length} skills, ${bundled.length} files, ${(bundledBytes / 1024).toFixed(0)} KB -> ${relative(root, skillsDir)}/`,
);
