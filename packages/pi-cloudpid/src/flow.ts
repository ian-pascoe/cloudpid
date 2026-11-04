// @effect-diagnostics preferEffectArray:off asyncFunction:off missingPipeableSignature:off cryptoRandomUUID:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as pi's extension API and child processes give them; plain functions over values, called directly; the request_id of begin.
/**
 * `/cloudpid [instruction]` (docs/architecture/mcp-endpoint.md → Session import → The `/cloudpid` command, The working
 * tree): refuse unless idle and saved, match the checkout to an Environment, say what will go and ask, then begin, push
 * (the branch, and the uncommitted Changes to `carry_ref`), send the file in slices, and finish. It never follows the
 * Run the instruction starts.
 */
import type { Config, Env } from "./config.ts";
import { readConfig } from "./config.ts";
import {
  IMPORT_MARKER,
  MAX_IMPORT_BYTES,
  MAX_SLICE_BYTES,
  MAX_TITLE_LENGTH,
  PI_SESSION_FORMAT,
  THINKING_LEVELS,
} from "./constants.ts";
import {
  type BeginInput,
  type BeginResult,
  branchTakenOf,
  type Endpoint,
  type Environment,
  type FinishResult,
  receivedOf,
} from "./endpoint.ts";
import { ApiFailure, Refusal } from "./errors.ts";
import {
  branchNameProblem,
  type Carry,
  type Checkout,
  checkoutOf,
  commitCarry,
  defaultBranchOf,
  deleteRemoteRef,
  expandedOriginOf,
  type Git,
  GitMissing,
  headOf,
  planPush,
  type PushPlan,
  pushBranch,
  pushCarry,
  readCarry,
  stashAll,
  switchNew,
} from "./git.ts";
import { matchEnvironments, normalizeRepoUrl } from "./origin.ts";
import type { SessionSnapshot } from "./session.ts";
import { fileBytes, sha256Hex, sliceAt } from "./slices.ts";

/** What of pi's UI the command uses (`ctx.ui`). */
export interface Ui {
  readonly select: (title: string, options: string[]) => Promise<string | undefined>;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly editor: (title: string, prefill?: string) => Promise<string | undefined>;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  readonly setStatus: (key: string, text: string | undefined) => void;
}

/** What `pi.appendEntry("cloudpid-import", …)` records. */
export interface ImportRecord {
  readonly session: string;
  readonly url: string;
  readonly branch: string;
  readonly environment: string;
}

/** pi, as the command sees it. */
export interface Host {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly isIdle: () => boolean;
  readonly session: () => SessionSnapshot;
  /** The model as `provider/id`. */
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly ui: Ui;
  readonly appendEntry: (customType: string, data: ImportRecord) => void;
}

/** What the command reaches outside pi: the environment, git, the endpoint, the disk. */
export interface Deps {
  readonly env: Env;
  readonly git: (cwd: string) => Git;
  readonly endpoint: (config: Config) => Promise<Endpoint>;
  readonly exists: (file: string) => boolean;
}

export type Outcome =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "imported" | "importing";
      readonly url: string;
      readonly branch: string;
      readonly stashed: boolean;
    };

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const STATUS_KEY = "cloudpid";

const MAX_LISTED_FILES = 8;

const MAX_NAME_TRIES = 5;

/** `text` as a branch name: lower-case words joined by `-`, at most 40 characters. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** `1.5 MiB`, `812 KiB`, `40 B`. */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;

  return `${String(bytes)} B`;
};

const plural = (count: number, word: string, many = `${word}s`): string =>
  `${String(count)} ${count === 1 ? word : many}`;

/** The files of the Changes, the first few by name. */
export const listFiles = (files: ReadonlyArray<string>): string => {
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");

  return files.length > MAX_LISTED_FILES
    ? `${shown}, and ${String(files.length - MAX_LISTED_FILES)} more`
    : shown;
};

/** What the Session was told to call itself, else its first message, as a branch name to offer. */
const suggestedBranch = (session: SessionSnapshot): string => {
  const fromTitle = slugify(session.name ?? "");

  if (fromTitle !== "") return fromTitle;

  const fromMessage = slugify(session.firstMessage ?? "");

  return fromMessage === "" ? "pi-session" : fromMessage;
};

const chooseEnvironment = async (
  ui: Ui,
  environments: ReadonlyArray<Environment>,
  origin: string,
): Promise<Environment | undefined> => {
  const matches = matchEnvironments(environments, origin);

  const [only, ...others] = matches;

  if (only === undefined) {
    throw new Refusal(
      `No Environment has this Repo (${normalizeRepoUrl(origin) ?? origin}): add this Repo to an Environment first, in cloudpid's settings, then run /cloudpid again.`,
    );
  }

  if (others.length === 0) return only;

  const labels = matches.map((environment) => `${environment.name} (${environment.id})`);
  const picked = await ui.select("Import into which Environment?", labels);
  const index = picked === undefined ? -1 : labels.indexOf(picked);

  return matches[index];
};

/** Asks for a branch name until git accepts one nothing else has; none when the owner gives up. */
const askBranchName = async (
  ui: Ui,
  git: Git,
  defaultBranch: string | undefined,
  prefill: string,
  why: string,
): Promise<string | undefined> => {
  let current = prefill;

  for (let tries = 0; tries < MAX_NAME_TRIES; tries += 1) {
    const answer = await ui.editor(why, current);

    if (answer === undefined) return undefined;

    const name = (answer.split("\n")[0] ?? "").trim();

    if (name === "") return undefined;

    const problem =
      name === defaultBranch
        ? `${name} is the default branch: pick another name`
        : await branchNameProblem(git, name);

    if (problem === undefined) return name;

    ui.notify(`cloudpid: ${problem}.`, "warning");
    current = name;
  }

  return undefined;
};

interface Target {
  readonly name: string;
  /** Whether the branch is made here (`git switch -c`) once the import begins. */
  readonly create: boolean;
}

const confirmText = (
  environment: Environment,
  target: Target,
  plan: PushPlan,
  carry: Carry | undefined,
  size: number,
  entries: number,
  model: string | undefined,
  thinking: string | undefined,
  instruction: string,
): string => {
  const commits =
    plan.count === 0
      ? plan.remote === undefined
        ? "none new (HEAD is on origin already)"
        : "none (origin has them)"
      : `${plural(plan.count, "commit")}${plan.commits.length > 0 ? `: ${plan.commits.join("; ")}` : ""}`;

  return [
    `Environment: ${environment.name}`,
    `Branch: ${target.name} (${target.create ? "made here with git switch -c; " : ""}${plan.remote === undefined ? "new on origin" : "fast-forward push"})`,
    `Commits to push: ${commits}`,
    `Carried changes: ${carry === undefined ? "none" : `${plural(carry.files.length, "file")}: ${listFiles(carry.files)} (uncommitted; ignored files stay behind)`}`,
    `Session: ${formatSize(size)}, ${plural(entries, "entry", "entries")}`,
    `Model: ${model ?? "not known"}${thinking === undefined ? "" : `, thinking ${thinking}`}`,
    `Instruction: ${instruction === "" ? "none (the Session waits for you)" : instruction}`,
  ].join("\n");
};

/** What the owner chooses when another Workspace holds the branch. */
type TakenChoice = "retry" | "rename" | "cancel";

const askTaken = async (
  ui: Ui,
  name: string,
  sessions: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly status: string;
  }>,
): Promise<TakenChoice> => {
  const held =
    sessions.length === 0
      ? "another Workspace"
      : sessions
          .map(
            (session) =>
              `${session.title === "" ? "untitled" : session.title} (${session.status}) ${session.url}`,
          )
          .join("\n  ");

  const retry = "I removed the Workspace in cloudpid: retry";
  const rename = "Import onto a new branch name";
  const cancel = "Cancel";

  const picked = await ui.select(
    [
      `Branch ${name} is held by ${sessions.length === 0 ? held : `a Workspace with:\n  ${held}`}`,
      "Removing that Workspace in the cloudpid web app deletes its Sessions, for good.",
    ].join("\n"),
    [retry, rename, cancel],
  );

  if (picked === retry) return "retry";

  return picked === rename ? "rename" : "cancel";
};

const beginInput = (
  environment: Environment,
  session: SessionSnapshot,
  size: number,
  name: string,
  host: Host,
  instruction: string,
): BeginInput => {
  const input: Writable<BeginInput> = {
    environment: environment.id,
    format: PI_SESSION_FORMAT,
    size_bytes: size,
    branch: name,
    request_id: crypto.randomUUID(),
  };

  if (session.name !== undefined && session.name.trim() !== "") {
    input.title = session.name.trim().slice(0, MAX_TITLE_LENGTH);
  }

  if (host.model !== undefined) input.model = host.model;

  const level = THINKING_LEVELS.find((candidate) => candidate === host.thinking);

  if (level !== undefined) input.thinking = level;

  if (instruction !== "") input.text = instruction;

  return input;
};

/** Sends the file from `begun.received` on, as slices, until the endpoint holds every byte. */
export const upload = async (
  endpoint: Endpoint,
  begun: BeginResult,
  bytes: Uint8Array,
  progress: (sent: number) => void,
): Promise<void> => {
  const max = Math.min(
    begun.maxSliceBytes > 0 ? begun.maxSliceBytes : MAX_SLICE_BYTES,
    MAX_SLICE_BYTES,
  );

  let offset = begun.received;
  let stalls = 0;

  while (offset < bytes.length) {
    const slice = sliceAt(bytes, offset, max);

    if (slice === undefined) break;

    let received: number;

    try {
      received = await endpoint.append(begun.importId, offset, slice.data);
    } catch (error) {
      // The endpoint holds a different number of bytes than this thinks (a slice sent twice, a retry that did arrive):
      // go on from where it says it is.
      const held = error instanceof ApiFailure ? receivedOf(error) : undefined;

      if (held === undefined) throw error;

      received = held;
    }

    if (received > bytes.length) {
      throw new Refusal(
        `the endpoint holds ${String(received)} bytes of a ${String(bytes.length)}-byte file.`,
      );
    }

    stalls = received > offset ? 0 : stalls + 1;

    if (stalls > 2)
      throw new Refusal(
        "the endpoint is not taking the file (it holds the same bytes after three tries).",
      );

    offset = received;
    progress(offset);
  }
};

/** What an import that ended says. */
export const describeResult = (
  result: FinishResult,
  instruction: string,
  comeBack: ReadonlyArray<string>,
): string => {
  const lines = [
    result.status === "importing"
      ? `cloudpid: still importing; it will ${instruction === "" ? "wait for you" : "start on your instruction"} when done: ${result.url}`
      : `cloudpid: imported: ${result.url}`,
  ];

  const { summary } = result;

  if (summary !== undefined) {
    const dropped = summary.dropped.map(([kind, count]) => `${kind} ${String(count)}`).join(", ");

    const parts = [
      summary.cut > 0 ? `cut ${String(summary.cut)}` : "",
      dropped === "" ? "" : `dropped ${dropped}`,
      summary.closed > 0 ? `closed ${String(summary.closed)} unfinished tool calls` : "",
    ].filter((part) => part !== "");

    if (parts.length > 0) lines.push(`  translation: ${parts.join("; ")}`);
  }

  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);

  lines.push(...comeBack);

  return lines.join("\n");
};

/** What failed when an import was abandoned, so the owner can tidy by hand. */
const abandon = async (
  endpoint: Endpoint,
  git: Git,
  begun: BeginResult,
): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = [];

  try {
    await endpoint.cancel(begun.importId);
  } catch (error) {
    problems.push(
      `could not cancel the import (${error instanceof Error ? error.message : "unknown error"}); it expires in an hour (${begun.url})`,
    );
  }

  try {
    await deleteRemoteRef(git, begun.carryRef);
  } catch {
    problems.push(`could not delete ${begun.carryRef} from origin`);
  }

  return problems;
};

/** `/cloudpid [instruction]`: see the module's comment. Failures the owner can act on are {@link Refusal}s. */
export const importSession = async (
  host: Host,
  instruction: string,
  deps: Deps,
): Promise<Outcome> => {
  const { ui } = host;
  const cancelled: Outcome = { kind: "cancelled" };

  if (!host.hasUI)
    throw new Refusal("/cloudpid asks before it imports: run it in pi's interactive mode.");

  if (!host.isIdle()) {
    throw new Refusal("pi is still working: let it finish (or stop it), then run /cloudpid again.");
  }

  const session = host.session();

  if (session.file === undefined || !deps.exists(session.file)) {
    throw new Refusal(
      "This pi session is not saved yet (pi writes its file with the first message): send a message, then run /cloudpid again.",
    );
  }

  const bytes = fileBytes(session.text);

  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new Refusal(
      `This session is ${formatSize(bytes.length)}, over cloudpid's limit of ${formatSize(MAX_IMPORT_BYTES)}: /compact it, or /tree to a shorter branch, then run /cloudpid again.`,
    );
  }

  const config = readConfig(deps.env);

  if (
    session.marker !== undefined &&
    !(await ui.confirm(
      "Import again?",
      `already imported as ${session.marker.url}; import again as a new Session?`,
    ))
  ) {
    return cancelled;
  }

  const here = deps.git(host.cwd);
  let checkout: Checkout | undefined;

  try {
    checkout = await checkoutOf(here);
  } catch (error) {
    if (error instanceof GitMissing) {
      throw new Refusal(
        `${error.message}, so /cloudpid cannot tell which Repo this is: install git, and add this Repo to an Environment first.`,
      );
    }

    throw error;
  }

  if (checkout === undefined) {
    throw new Refusal(
      `${host.cwd} is not in a git repository: run /cloudpid from the Repo's checkout, and add this Repo to an Environment first.`,
    );
  }

  if (checkout.origin === undefined) {
    throw new Refusal(
      `${checkout.root} has no \`origin\` remote: push it to GitHub, then add this Repo to an Environment first.`,
    );
  }

  const git = deps.git(checkout.root);
  const endpoint = await deps.endpoint(config);

  try {
    const environments = await endpoint.environments();
    let origin = checkout.origin;

    // The URL as the config has it matches nothing: try the one git resolves (`url.<base>.insteadOf`) before refusing.
    if (matchEnvironments(environments, origin).length === 0) {
      const expanded = await expandedOriginOf(git);

      if (expanded !== undefined && matchEnvironments(environments, expanded).length > 0) {
        origin = expanded;
      }
    }

    const environment = await chooseEnvironment(ui, environments, origin);

    if (environment === undefined) return cancelled;

    const head = await headOf(git);

    if (head.commit === undefined) {
      throw new Refusal("This repo has no commit yet: commit, then run /cloudpid again.");
    }

    const { commit } = head;
    const defaultBranch = await defaultBranchOf(git, head);
    const onDefault = head.branch === undefined || head.branch === defaultBranch;

    let target: Target;

    if (onDefault) {
      const name = await askBranchName(
        ui,
        git,
        defaultBranch,
        suggestedBranch(session),
        `${head.branch === undefined ? "HEAD is detached" : `You are on ${head.branch}, the default branch`}: name the branch cloudpid will work on (made here with git switch -c).`,
      );

      if (name === undefined) return cancelled;

      target = { name, create: true };
    } else {
      // The branch is the upstream's name on origin when the local branch tracks another, else its own.
      const upstream =
        head.upstream !== undefined && head.upstream !== defaultBranch ? head.upstream : undefined;

      target = { name: upstream ?? head.branch ?? "", create: false };
    }

    let plan = await planPush(git, commit, target.name);

    if (plan.behind) {
      throw new Refusal(
        `origin's ${target.name} has commits this checkout lacks: pull first, then run /cloudpid again.`,
      );
    }

    const carry = await readCarry(git, commit);

    const confirmed = await ui.confirm(
      "Import this pi session into cloudpid?",
      confirmText(
        environment,
        target,
        plan,
        carry,
        bytes.length,
        session.entries,
        host.model,
        host.thinking,
        instruction,
      ),
    );

    if (!confirmed) return cancelled;

    let begun: BeginResult | undefined;

    while (begun === undefined) {
      try {
        begun = await endpoint.begin(
          beginInput(environment, session, bytes.length, target.name, host, instruction),
        );
      } catch (error) {
        const taken = error instanceof ApiFailure ? branchTakenOf(error) : undefined;

        if (taken === undefined) throw error;

        const choice = await askTaken(ui, target.name, taken.sessions);

        if (choice === "cancel") return cancelled;

        if (choice === "rename") {
          const name = await askBranchName(
            ui,
            git,
            defaultBranch,
            `${target.name}-2`,
            `Branch ${target.name} is held by another Workspace: name the branch cloudpid will work on.`,
          );

          if (name === undefined) return cancelled;

          target = { name, create: true };
          plan = await planPush(git, commit, name);

          if (plan.behind) {
            throw new Refusal(
              `origin's ${name} has commits this checkout lacks: pull first, then run /cloudpid again.`,
            );
          }
        }
      }
    }

    const imported = begun;
    let switched = false;
    let finished: FinishResult;

    try {
      if (target.create) {
        await switchNew(git, target.name);
        switched = true;
      }

      ui.setStatus(STATUS_KEY, `cloudpid: pushing ${target.name}`);

      if (plan.remote !== commit) await pushBranch(git, commit, target.name);

      if (carry === undefined) {
        await deleteRemoteRef(git, imported.carryRef);
      } else {
        await pushCarry(git, await commitCarry(git, carry, commit, target.name), imported.carryRef);
      }

      await upload(endpoint, imported, bytes, (sent) => {
        ui.setStatus(
          STATUS_KEY,
          `cloudpid: sending the session ${String(Math.round((sent / bytes.length) * 100))}%`,
        );
      });

      ui.setStatus(STATUS_KEY, "cloudpid: finishing");

      finished = await endpoint.finish(imported.importId, sha256Hex(bytes), carry !== undefined);
    } catch (error) {
      ui.setStatus(STATUS_KEY, undefined);

      const problems = await abandon(endpoint, git, imported);

      for (const problem of problems) ui.notify(`cloudpid: ${problem}.`, "warning");

      if (switched) {
        ui.notify(
          `cloudpid: you are now on ${target.name} (was ${head.branch ?? `a detached HEAD at ${commit.slice(0, 8)}`}); \`git switch ${head.branch ?? commit}\` goes back.`,
          "warning",
        );
      }

      throw error;
    }

    // The import is made: nothing after this cancels it (that would delete the new Session and the carry ref).
    ui.setStatus(STATUS_KEY, undefined);

    return await afterImport(host, git, finished, instruction, {
      branch: target.name,
      // The branch to come back to: the one made here, else the one the owner is on.
      local: target.create ? target.name : (head.branch ?? target.name),
      environment: environment.name,
      carried: carry !== undefined,
      // `git pull --ff-only` must pull the branch just pushed: a branch made here, or one that tracks another.
      setUpstream: target.create || head.upstream !== target.name,
    });
  } finally {
    ui.setStatus(STATUS_KEY, undefined);

    await endpoint.close().catch(() => undefined);
  }
};

interface Landed {
  readonly branch: string;
  /** The local branch to come back to. */
  readonly local: string;
  readonly environment: string;
  readonly carried: boolean;
  /** The local branch does not track `origin/<branch>` yet: set it, so `git pull --ff-only` pulls that branch. */
  readonly setUpstream: boolean;
}

/**
 * The import is in: the upstream, the stash, the marker, and what the owner reads. None of it can undo the import, so
 * a step that fails is told in the notice and the rest goes on.
 */
const afterImport = async (
  host: Host,
  git: Git,
  finished: FinishResult,
  instruction: string,
  landed: Landed,
): Promise<Outcome> => {
  const { ui } = host;
  const trouble: Array<string> = [];

  let pull = "git pull --ff-only";

  if (landed.setUpstream) {
    // Best effort: a branch pushed by commit id has no upstream, and `git pull --ff-only` needs one.
    const set = await git([
      "branch",
      `--set-upstream-to=origin/${landed.branch}`,
      landed.local,
    ]).then(
      (result) => result.code === 0,
      () => false,
    );

    // Without it, a plain pull would pull what the branch tracked before (if anything).
    if (!set) pull = `git pull --ff-only origin ${landed.branch}`;
  }

  let stashed = false;

  if (landed.carried) {
    const message = `cloudpid: imported as ${finished.url}`;

    try {
      const wants = await ui.confirm(
        "Put your uncommitted changes aside?",
        `The work goes on in cloudpid, with these changes. \`git stash push -u -m "${message}"\` keeps your copy out of the way here.`,
      );

      if (wants) {
        try {
          await stashAll(git, message);
          stashed = true;
        } catch (error) {
          trouble.push(
            `could not stash: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
    } catch (error) {
      trouble.push(
        `could not ask about the stash: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  try {
    host.appendEntry(IMPORT_MARKER, {
      session: finished.sessionId,
      url: finished.url,
      branch: landed.branch,
      environment: landed.environment,
    });
  } catch (error) {
    trouble.push(
      `could not record the import in this pi session: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  for (const problem of trouble) ui.notify(`cloudpid: ${problem}.`, "warning");

  const comeBack = [
    `To come back: git switch ${landed.local} && ${pull}${stashed ? ", then git stash drop" : ""}`,
  ];

  ui.notify(describeResult(finished, instruction, comeBack), "info");

  return {
    kind: finished.status === "importing" ? "importing" : "imported",
    url: finished.url,
    branch: landed.branch,
    stashed,
  };
};
