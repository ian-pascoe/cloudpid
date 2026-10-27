// What the GitHub App's setup (`github-app-setup.ts`) computes without GitHub or the disk: the manifest the app is
// registered from (ADR-0025), and the dev.env the app's secrets are written into.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over text and native records, not combinators.

/** The permissions the app asks for (ADR-0025): what the agent's git and gh need, and CI's state to read. */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  workflows: "write",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
} as const;

/**
 * The manifest GitHub registers the app from: public (so it can be installed on the owner's organizations too), with
 * `GITHUB_APP_PERMISSIONS`, no webhook until the triggers need one, and back to the setup once registered.
 */
export const githubAppManifest = (options: {
  readonly name: string;
  readonly homepage: string;
  readonly redirect: string;
}) => ({
  name: options.name,
  url: options.homepage,
  redirect_url: options.redirect,
  public: true,
  default_permissions: GITHUB_APP_PERMISSIONS,
  default_events: [],
});

/** The manifest the setup posts to GitHub. */
export type GitHubAppManifest = ReturnType<typeof githubAppManifest>;

/** `value` as one single-quoted shell word, whatever it holds (line breaks included). */
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Whether `assignment` (`NAME=value`, maybe over several lines) leaves a single quote open, so bash reads its value on
 * into the next line.
 */
const quotesOpen = (assignment: string): boolean => {
  const value = assignment.slice(assignment.indexOf("=") + 1);

  // The quotes of `'\''` cancel out; what is left counts once per quote bash sees.
  return (value.replaceAll("'\\''", "").split("'").length - 1) % 2 === 1;
};

/**
 * `text`, a dev.env that `set -a; . dev.env` loads, with `values` set: each assignment it had replaced where it was (all
 * of its lines), the others added at its end, every value single-quoted. Every other line is kept as it is.
 */
export const withDevEnvValues = (
  text: string,
  values: Readonly<Record<string, string>>,
): string => {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  const written = new Set<string>();

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];

    if (name === undefined || !(name in values)) {
      out.push(line);

      continue;
    }

    // Skip the rest of a value that runs over several lines.
    for (let assignment = line; quotesOpen(assignment) && at + 1 < lines.length;) {
      at++;
      assignment = `${assignment}\n${lines[at] ?? ""}`;
    }

    if (!written.has(name)) out.push(`${name}=${shellWord(values[name] ?? "")}`);

    written.add(name);
  }

  for (const [name, value] of Object.entries(values)) {
    if (!written.has(name)) out.push(`${name}=${shellWord(value)}`);
  }

  return `${out.join("\n")}\n`;
};
