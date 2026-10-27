// What a GitHub token looks like (ADR-0025): what the Session refuses in a plain value, though it never sees the tokens
// the Workspaces mint, and what a log line about a Container is cleared of before its Workspace DO can take its own
// tokens out. Classic and app tokens are a prefix and at least 36 letters and digits; fine-grained ones are
// `github_pat_` and at least 22 more.

/**
 * Every GitHub token in a text: `ghp_` (personal), `gho_` (OAuth), `ghu_`/`ghs_`/`ghr_` (an app's), `github_pat_`. No
 * word boundary before one: a token run on from a name (`FOO_ghs_…`) or an escape (`%3Dghs_…`) is one too.
 */
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g;

/** `text` with everything shaped like a GitHub token replaced by `***`. */
export const maskGitHubTokens = (text: string): string => text.replaceAll(GITHUB_TOKEN, "***");

/** Whether `text` holds anything shaped like a GitHub token. */
export const holdsGitHubToken = (text: string): boolean => maskGitHubTokens(text) !== text;
