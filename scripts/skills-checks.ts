// @effect-diagnostics missingPipeableSignature:off
// What may be bundled from `skills/`, shared by `scripts/sync-skills.mjs` (which refuses it at sync time) and
// `apps/server/src/workspace/bundled-skills.test.ts` (which refuses it in CI, so a hand edit is checked too). Plain
// TypeScript that Node runs by type stripping.

/** A bundled file this large is refused: the files ship inside the Workspaces Worker's upload. */
export const MAX_FILE_BYTES = 128 * 1024;

/** The bundle as a whole may be this large. */
export const MAX_TOTAL_BYTES = 1024 * 1024;

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

/** Why `bytes`, the contents of the bundled file at `path`, may not be bundled: none when it may. */
export const problemsIn = (path: string, bytes: Uint8Array): string[] => {
  const problems: string[] = [];

  if (bytes.length > MAX_FILE_BYTES) {
    problems.push(
      `${path}: ${bytes.length} bytes, more than the ${MAX_FILE_BYTES} a bundled file may be`,
    );
  }

  if (bytes.includes(0)) return [...problems, `${path}: binary files are not bundled`];

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return [...problems, `${path}: not UTF-8 text`];
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      problems.push(`${path}: matches ${pattern}, which looks like a credential or a local path`);
    }
  }

  return problems;
};
