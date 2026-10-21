#!/usr/bin/env node
// Copies the headless-safe skills from the owner's local config into `skills/` and regenerates the manifest the
// Workspace DO mounts (`apps/server/src/workspace/bundled-skills.generated.ts`). Run it to refresh the bundle:
//
//   node scripts/sync-skills.mjs                 # sources: ~/.pi/agent/skills, then ~/.agents/skills
//   node scripts/sync-skills.mjs --source <dir>  # a source directory (repeatable; first match wins)
//
// A skill is copied whole (symbolic links followed, so the copy holds contents, not links) minus the paths in
// `EXCLUDED_PATHS`. Only text is bundled: `WorkerBundle` ships files as Worker modules, so a binary, a skill that
// would be mostly data, or anything that looks like a credential fails the run instead of being shipped.
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

/**
 * The skills the cloud agent gets, each with a one-line reason. Anything that needs a local app, terminal, GUI or
 * local-only tool is left out; see the PR that added this file for what was excluded and why.
 */
export const INCLUDED_SKILLS = {
  "address-pr-review": "work through unresolved PR review comments with gh",
  "ast-grep": "structural code search; the Container installs ast-grep with mise",
  "ast-grep-outline": "cheap structural map of files before reading them",
  bro: "restate the last message in plain language",
  "code-review": "two-axis diff review that runs sub-agents",
  "codebase-design": "deep-module vocabulary for design work",
  "convert-documents-to-markdown":
    "office documents and PDFs to Markdown with npx on the Container",
  deslop: "clean AI slop out of a diff",
  "diagnosing-bugs": "diagnosis loop for hard bugs",
  "domain-modeling": "GLOSSARY.md and ADR upkeep",
  "grill-me": "interview to sharpen a plan",
  "grill-with-docs": "interview that records the glossary and ADRs",
  grilling: "relentless questioning about a plan",
  impeccable: "frontend design, critique and polish",
  implement: "implement a spec or tickets",
  "implement-spec": "implement a spec with subagents on an integration branch",
  improve: "audit a codebase into handoff plans",
  pr: "PR body template",
  prototype: "throwaway prototypes for design questions",
  research: "primary-source research notes",
  "setup-matt-pocock-skills": "per-repo issue tracker, labels and domain docs setup",
  tdd: "test-driven development",
  "to-questionnaire": "a questionnaire for someone else to fill in",
  "to-spec": "publish a spec to the issue tracker",
  "to-tickets": "break a spec into tickets on the issue tracker",
  triage: "move issues through triage roles",
  unslop: "cut AI tells from writing",
  "wait-what": "re-pitch a message that did not land",
  wayfinder: "plan a large piece of work as decision tickets",
  "writing-for-agents": "writing skills, AGENTS.md and CLAUDE.md",
};

/** Paths (relative to the skill, `*` within a segment) left out of every copy. */
const EXCLUDED_PATHS = [
  // Harness metadata for other agents (Codex's `agents/openai.yaml` and the like); pi does not read it.
  "agents/**",
  // impeccable: a 1.1 MB font index, a 550 KB browser bundle for `live` mode and a screenshot library, which need a
  // local browser, and the Windows launcher. Its Markdown references and POSIX launcher stay.
  "scripts/data/**",
  "scripts/live-browser*.js",
  "scripts/modern-screenshot.umd.js",
  "scripts/impeccable.cmd",
];

/** A bundled file this large fails the run: the files ship inside the Workspaces Worker's upload. */
const MAX_FILE_BYTES = 128 * 1024;

const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{20,}["']/i,
  /\/Users\/[a-z][a-z0-9_-]*\//,
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
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

const readText = (path) => {
  const bytes = readFileSync(path);

  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(
      `${path}: ${bytes.length} bytes, more than the ${MAX_FILE_BYTES} a bundled file may be`,
    );
  }

  if (bytes.includes(0)) throw new Error(`${path}: binary files are not bundled`);

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text))
      throw new Error(`${path}: matches ${pattern}, which looks like a credential or a local path`);
  }

  return text;
};

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

// Read and check everything before touching `skills/`, so a failed run leaves the last good copy.
const copies = Object.keys(INCLUDED_SKILLS).map((name) => {
  const source = sourceOf(name);

  return {
    name,
    source,
    files: bundledFiles(source).map((path) => ({ path, text: readText(join(source, path)) })),
  };
});

mkdirSync(skillsDir, { recursive: true });

for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (entry.isDirectory()) rmSync(join(skillsDir, entry.name), { recursive: true });
}

for (const { name, files } of copies) {
  for (const { path } of files) {
    const target = join(skillsDir, name, path);

    mkdirSync(dirname(target), { recursive: true });
  }
}

for (const { name, source, files } of copies) {
  for (const { path } of files) {
    cpSync(join(source, path), join(skillsDir, name, path), { dereference: true });
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
  "// `?raw` import, which the Workers' bundler (alchemy's rolldown) and Vitest inline as a string.",
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

const bytes = bundled.reduce((total, { text }) => total + new TextEncoder().encode(text).length, 0);

console.log(
  `${copies.length} skills, ${bundled.length} files, ${(bytes / 1024).toFixed(0)} KB -> ${relative(root, skillsDir)}/`,
);
