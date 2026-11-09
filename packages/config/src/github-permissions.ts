// The GitHub permissions cloudpid asks for (docs/architecture/workspace.md → Git, ADR-0025; docs/architecture/triggers.md →
// GitHub-managed hooks, ADR-0049): the App's, which its registration (`infra`) lists, and the Containers', which the
// Workspace DO mints every token with. Two lists, so a permission the App gains reaches a Container only by being added
// to the Containers' list on purpose.

/** A permission's level on a repository. */
export type GitHubPermissionLevel = "read" | "write";

/** A set of GitHub permissions: each permission's name and its level. */
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionLevel>>;

/**
 * The permissions the GitHub App asks for (ADR-0025): what the agent's git and gh need, CI's state to read, and the repo
 * webhooks a Trigger's object makes (`repository_hooks`, ADR-0049), which only its own token asks for.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  workflows: "write",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
  repository_hooks: "write",
} as const satisfies GitHubPermissions;

/**
 * The permissions of the tokens a Container's commands and the Diff pane's GitHub calls get: asked for explicitly, since
 * GitHub reads a request with none as all of the installation's. The App's, but `repository_hooks` (ADR-0049), which is
 * never listed here: a prompt-injected `gh api` could otherwise add a hook that sends a repo's events anywhere.
 */
export const CONTAINER_GITHUB_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  workflows: "write",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
} as const satisfies GitHubPermissions;
