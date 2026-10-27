// @effect-diagnostics missingPipeableSignature:off
// What a Skill may hold (ADR-0026, docs/spec.md → Agent changes → Skills): the checks a Skill's files pass before they
// are saved, by the Registry and by `environment_skill_save`, and the Agent Skills name rules. The bundle in `skills/`
// passes the same checks: `scripts/sync-skills.mjs` refuses what they forbid at sync time, and
// `apps/server/src/workspace/bundled-skills.test.ts` in CI, until the bundle is removed. Plain TypeScript with no
// imports, which Node runs by type stripping.

/** A Skill's file this large is refused: every Workspace holds a copy of its Skill set. */
export const MAX_FILE_BYTES = 128 * 1024;

/** A Skill, all its files together, may be this large. */
export const MAX_SKILL_BYTES = 1024 * 1024;

/** The bundle in `skills/` as a whole may be this large: the files ship inside the Workspaces Worker's upload. */
export const MAX_TOTAL_BYTES = 1024 * 1024;

/** The longest name a Skill may have (Agent Skills). */
export const MAX_SKILL_NAME_LENGTH = 64;

/** The longest description a Skill may have (Agent Skills). */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** What looks like a credential or a path on somebody's machine. */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{20,}["']/i,
  /\/Users\/[a-z][a-z0-9_-]*\//,
  /\/home\/[a-z][a-z0-9_-]*\//,
];

/** Why `bytes`, the contents of a Skill's file at `path`, may not be saved: none when it may. */
export const problemsIn = (path: string, bytes: Uint8Array): string[] => {
  const problems: string[] = [];

  if (bytes.length > MAX_FILE_BYTES) {
    problems.push(
      `${path}: ${bytes.length} bytes, more than the ${MAX_FILE_BYTES} a Skill's file may be`,
    );
  }

  if (bytes.includes(0)) return [...problems, `${path}: a binary file; a Skill holds text only`];

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return [...problems, `${path}: not UTF-8 text; a Skill holds text only`];
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`${path}: matches ${pattern}, which looks like a credential or a local path`);
    }
  }

  return problems;
};

/**
 * Why `name` is not a Skill's name by the Agent Skills rules: 1 to 64 characters, lowercase letters, digits and hyphens,
 * not starting or ending with a hyphen and with no two in a row. Undefined when it is one.
 */
export const skillNameProblem = (name: string): string | undefined => {
  if (name.length === 0) return "a Skill's name may not be empty";

  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `${JSON.stringify(name)} is ${name.length} characters, more than the ${MAX_SKILL_NAME_LENGTH} a Skill's name may be`;
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return `${JSON.stringify(name)} may hold only lowercase letters, digits and hyphens`;
  }

  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return `${JSON.stringify(name)} may not start or end with a hyphen, or hold two in a row`;
  }

  return undefined;
};
