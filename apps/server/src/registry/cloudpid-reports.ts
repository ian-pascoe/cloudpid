// cloudpid reports, as the Registry files them (`docs/architecture/agent-capabilities.md` → cloudpid reports, ADR-0051):
// a Session's `cloudpid_report` call asks `agentFileReport`, and the Registry, which alone holds the GitHub App's key,
// refuses a title or body that names the owner's Repos (`namedRepoTerms`), counts the caps every Session shares, claims the
// call by its Session and task before it posts, and posts the issue once (`../github/issues.ts`), with cloudpid's footer
// and its mentions defused. A claim is `claimed`, then `filed`, `failed` (released: it counts no cap) or `unknown` (GitHub
// was asked and never answered: it counts, and is never posted again). The rows (`cloudpid_reports`, migration 40) keep no
// title or body, only a hash of the title, and are pruned after 30 days, never with their Session. Posts are paced a
// second apart, and a `retry-after` GitHub sends is kept, so every call until then is refused.
// @effect-diagnostics asyncFunction:off globalDate:off globalFetch:off globalTimers:off newPromise:off preferEffectArray:off missingPipeableSignature:off -- GitHub is asked with Promise APIs (`fetch`, a timer between posts), over the object's synchronous SQLite and native arrays.
import { sha256Hex } from "@cloudpid/config/sha256";
import type {
  CloudpidReportAnswer,
  CloudpidReportRequest,
} from "@cloudpid/extensions/cloudpid-report";
import type { EnvironmentRepo } from "@cloudpid/protocol";
import { CLOUDPID_REPO, CLOUDPID_REPORT_LABEL } from "../deployment.ts";
import {
  addLabels,
  CLOUDPID_REPO_OWNER,
  createIssue,
  type IssueCallFailure,
  labelExists,
  reportToken,
  reportTokens,
  type ReportTokens,
} from "../github/issues.ts";
import type { GitHubAppSecrets } from "../github/config.ts";
import type { GithubFetch } from "../github/request.ts";
import type { RegistryStorage, RegistryStore } from "./store.ts";

/** What a Session asks the Registry to file: the call's request, its Session, and the Session's stage and version. */
export type AgentReportInput = CloudpidReportRequest & {
  readonly session: string;
  readonly footer: CloudpidReportRequest["footer"] & {
    /** `prod`, `pr-<n>`, a dev stage's label, or `local`. */
    readonly stage: string;
    /** The Worker version's id (`CF_VERSION_METADATA`); absent under `alchemy dev`. */
    readonly version?: string | undefined;
  };
};

/** The most reports one Session files, its subagents' included. */
export const SESSION_REPORT_CAP = 3;

/** The most reports a stage's Registry files in a UTC day: `prod`'s, and any other stage's. */
export const DAILY_REPORT_CAP = { prod: 10, other: 3 } as const;

/** How long a report's row is kept. */
export const REPORT_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

/** The least time between two posts. */
export const REPORT_POST_GAP_MS = 1_000;

/** How long a missing label is believed before GitHub is asked again. */
export const LABEL_MISSING_MEMORY_MS = 5 * 60_000;

/** The label every report is filed under too, best-effort: no precheck, and no warning when GitHub drops it. */
const TRIAGE_LABEL = "needs-triage";

/** The Registry document that keeps when GitHub lets reports be posted again (ms), after a `retry-after`. */
const BLOCKED_DOCUMENT = "cloudpid-reports-blocked-until";

/** What separates the agent's text from cloudpid's footer. */
export const REPORT_FOOTER_SEPARATOR = "\n\n---\n";

const DAY_MS = 24 * 60 * 60 * 1000;

/** cloudpid's own repo's owner, which is never a term by itself. */
const OWN_OWNER = CLOUDPID_REPO.split("/")[0] ?? "";

/** What a term may not touch on either side: a character of a name. */
const NAME_CHARACTER = /[A-Za-z0-9_-]/;

/** cloudpid's own paths in a Workspace, which name no Repo of the owner's whatever follows them. */
const OWN_PATHS = /\/workspace\/\.(?:cloudpid|agents)(?:\/[^\s`'"<>()[\]{}]*)?/gi;

/** A compound name: one holding `-`, `_`, `.` or a digit. */
const COMPOUND = /[-_.0-9]/;

/** A bare name long enough to be told from a word. */
const MIN_BARE_NAME = 6;

/** An owner long enough to be told from a word. */
const MIN_OWNER = 4;

/** The terms that name `repo`: none for a clone of cloudpid's own repo. */
const termsOf = (repo: EnvironmentRepo): ReadonlyArray<string> => {
  const url = URL.parse(repo.url);
  const directory = `/workspace/${repo.name}`;

  if (url === null) return [repo.url, directory];

  const segments = url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment));

  const host = url.hostname.toLowerCase();
  const [owner = "", name = ""] = segments;
  const github = host === "github.com";
  const path = github ? `${owner}/${name}` : `${host}/${segments.join("/")}`;

  if (github && path.toLowerCase() === CLOUDPID_REPO) return [];

  const last = segments.at(-1) ?? "";

  return [
    path,
    ...(owner.toLowerCase() !== OWN_OWNER && owner.length >= MIN_OWNER ? [owner] : []),
    directory,
    ...[...new Set([last, repo.name])].filter(
      (bare) => COMPOUND.test(bare) && bare.length >= MIN_BARE_NAME,
    ),
  ];
};

/** Whether `text` (lower case) holds `term` (lower case) with no name character on either side. */
const holdsTerm = (text: string, term: string): boolean => {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + term.length] ?? "";

    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
  }

  return false;
};

/**
 * The terms of `repos` that `texts` name, each once, in the Repos' order: a Repo's `owner/name` (`host/path` off GitHub),
 * its owner (not cloudpid's own, and of 4 or more characters), its `/workspace/<dir>`, and its bare name or directory
 * when compound and of 6 or more characters. Case-insensitive, at name boundaries; nothing of a clone of cloudpid's own
 * repo, and nothing inside cloudpid's own paths (`/workspace/.cloudpid/…`, `/workspace/.agents/…`).
 */
export const namedRepoTerms = (
  repos: ReadonlyArray<EnvironmentRepo>,
  texts: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const read = texts.map((text) => text.replaceAll(OWN_PATHS, " ").toLowerCase());
  const named: string[] = [];

  for (const repo of repos) {
    for (const term of termsOf(repo)) {
      const lower = term.toLowerCase();

      if (
        !named.some((kept) => kept.toLowerCase() === lower) &&
        read.some((text) => holdsTerm(text, lower))
      ) {
        named.push(term);
      }
    }
  }

  return named;
};

/** Code in Markdown: a fenced block, or an inline span. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

/** `text` with a zero-width space after each `@` outside code, so a report mentions no one on GitHub. */
export const defuseMentions = (text: string): string =>
  text
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : part.replaceAll("@", "@\u200b")))
    .join("");

/** cloudpid's footer: what filed the report, never an Environment, Repo, branch, title or directory. */
const footerOf = (input: AgentReportInput, origin: string | undefined): string => {
  const { kind, tool, footer, session } = input;

  return [
    `Filed by cloudpid's \`cloudpid_report\` tool (${kind}${tool === undefined ? "" : `, about \`${tool}\``}).`,
    "",
    `- Stage: ${footer.stage}`,
    `- Version: ${footer.version ?? "unknown"}`,
    `- Model: ${footer.model} (thinking: ${footer.thinking})`,
    `- Conversation: ${footer.agent}`,
    `- Session: ${origin === undefined ? session : `${origin}/sessions/${session}`}`,
  ].join("\n");
};

/** A title as repeats are found: lower case, its runs of white space as one space, trimmed. */
const titleHash = (title: string): string =>
  sha256Hex(title.toLowerCase().replaceAll(/\s+/g, " ").trim());

/** The states a claim counts toward the caps in: all but `failed`. */
const COUNTED = "state IN ('claimed', 'filed', 'unknown')";

type ReportRow = { state: string; number: number | null; url: string | null };

/** What the reports are made with. */
export type CloudpidReportsDeps = {
  readonly storage: RegistryStorage;
  readonly store: Pick<RegistryStore, "listEnvironments" | "getDocument" | "putDocument">;
  /** The GitHub App's tokens for reports (`reportTokens`). */
  readonly tokens: ReportTokens;
  readonly fetch: GithubFetch;
  /** The most reports a UTC day: `DAILY_REPORT_CAP`'s, by this stage. */
  readonly dailyCap: number;
  /** This stage's app origin, which the footer's Session link is on; absent under `alchemy dev`. */
  readonly origin: string | undefined;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

type Refused = Extract<CloudpidReportAnswer, { readonly status: "refused" }>;

/** A refusal: nothing is posted. */
const refused = (code: Refused["code"], message: string): Refused => ({
  status: "refused",
  code,
  message: `Nothing was filed: ${message}`,
});

const labelRefusal = (): Refused =>
  refused(
    "label_missing",
    `the label \`${CLOUDPID_REPORT_LABEL}\` doesn't exist on ${CLOUDPID_REPO}; the owner creates it once (\`gh label create ${CLOUDPID_REPORT_LABEL}\`).`,
  );

const blockedRefusal = (until: number): Refused =>
  refused(
    "rate_limited",
    `GitHub asked cloudpid to wait before it posts again, until ${new Date(until).toISOString()}.`,
  );

/**
 * The Registry object's reports over GitHub itself, the clock and timers: `stageLabel` is the stage's label (none on
 * `prod`, whose daily cap is higher), and `origin` its app origin.
 */
export const registryCloudpidReports = (options: {
  readonly storage: RegistryStorage;
  readonly store: CloudpidReportsDeps["store"];
  readonly github: GitHubAppSecrets;
  readonly stageLabel: string | undefined;
  readonly origin: string | undefined;
}) =>
  openCloudpidReports({
    storage: options.storage,
    store: options.store,
    tokens: reportTokens(options.github),
    fetch: (url, init) => fetch(url, init),
    dailyCap: options.stageLabel === undefined ? DAILY_REPORT_CAP.prod : DAILY_REPORT_CAP.other,
    origin: options.origin,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

/** The reports of one Registry object: `file` claims, checks and posts one Session's call. */
export const openCloudpidReports = (deps: CloudpidReportsDeps) => {
  const { sql } = deps.storage;
  const calls = { fetch: deps.fetch, now: deps.now };

  /** The label was found: never asked again by this object. */
  let labelSeen = false;
  /** Until when the label is believed missing. */
  let labelMissingUntil = 0;
  /** The posts, one at a time, and when the last ended. */
  let queue: Promise<unknown> = Promise.resolve();
  let lastPost = Number.NEGATIVE_INFINITY;

  const rowOf = (session: string, task: number): ReportRow | undefined =>
    sql
      .exec<ReportRow>(
        "SELECT state, number, url FROM cloudpid_reports WHERE session = ? AND task = ?",
        session,
        task,
      )
      .toArray()[0];

  const settle = (session: string, task: number, state: "failed" | "unknown") => {
    sql.exec(
      "UPDATE cloudpid_reports SET state = ? WHERE session = ? AND task = ?",
      state,
      session,
      task,
    );
  };

  const blockedUntil = (): number => Number(deps.store.getDocument(BLOCKED_DOCUMENT) ?? 0);

  const block = (until: number) => {
    deps.store.putDocument(BLOCKED_DOCUMENT, String(until), deps.now());
  };

  /** A GitHub failure as the answer, the claim released; a rate limit is kept until it is over. */
  const failedWith = (
    session: string,
    task: number,
    failure: IssueCallFailure,
  ): CloudpidReportAnswer => {
    settle(session, task, "failed");

    if (failure.kind !== "rate_limited") return { status: "failed", message: failure.message };

    block(failure.until);

    return {
      status: "failed",
      message: `GitHub limited cloudpid's posts (${failure.message}); it posts no report until ${new Date(failure.until).toISOString()}.`,
    };
  };

  /**
   * Claim the call, after the caps: a refusal claims nothing. In one transaction, so two calls never pass one cap
   * together.
   */
  const claim = (input: AgentReportInput, hash: string, now: number): Refused | undefined =>
    deps.storage.transactionSync(() => {
      const { inSession } = sql
        .exec<{ inSession: number }>(
          `SELECT count(*) AS inSession FROM cloudpid_reports WHERE session = ? AND ${COUNTED}`,
          input.session,
        )
        .one();

      if (inSession >= SESSION_REPORT_CAP) {
        return refused(
          "session_cap",
          `this Session has filed ${String(SESSION_REPORT_CAP)} cloudpid reports, the most one Session files.`,
        );
      }

      const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

      const { today } = sql
        .exec<{ today: number }>(
          `SELECT count(*) AS today FROM cloudpid_reports WHERE at >= ? AND ${COUNTED}`,
          dayStart,
        )
        .one();

      if (today >= deps.dailyCap) {
        return refused(
          "daily_cap",
          `${String(deps.dailyCap)} cloudpid reports were filed today (UTC), the most this stage files in a day.`,
        );
      }

      const repeated = sql
        .exec(
          `SELECT 1 FROM cloudpid_reports WHERE session = ? AND title_hash = ? AND ${COUNTED}`,
          input.session,
          hash,
        )
        .toArray();

      if (repeated.length > 0) {
        return refused("repeated", "this Session filed a cloudpid report with this title already.");
      }

      sql.exec(
        `INSERT INTO cloudpid_reports (session, task, state, kind, at, title_hash)
         VALUES (?, ?, 'claimed', ?, ?, ?)`,
        input.session,
        input.task,
        input.kind,
        now,
        hash,
      );

      return undefined;
    });

  /** One at a time, at least `REPORT_POST_GAP_MS` after the last. */
  const paced = <A>(work: () => Promise<A>): Promise<A> => {
    const run = queue.then(async () => {
      const wait = lastPost + REPORT_POST_GAP_MS - deps.now();

      if (wait > 0) await deps.sleep(wait);

      try {
        return await work();
      } finally {
        lastPost = deps.now();
      }
    });

    queue = run.catch(() => undefined);

    return run;
  };

  /** Post the claimed call's issue, settling its claim. */
  const post = async (input: AgentReportInput): Promise<CloudpidReportAnswer> => {
    const { session, task } = input;
    const until = blockedUntil();

    if (until > deps.now()) {
      settle(session, task, "failed");

      return blockedRefusal(until);
    }

    if (!labelSeen && labelMissingUntil > deps.now()) {
      settle(session, task, "failed");

      return labelRefusal();
    }

    const minted = await reportToken(deps.tokens);

    if ("problem" in minted) {
      settle(session, task, "failed");

      if (minted.problem.notInstalled) {
        const warning = `The GitHub App is not installed on ${CLOUDPID_REPO_OWNER}, so cloudpid cannot file its reports: the owner installs it there (ADR-0025's setup).`;

        return { status: "failed", message: warning, warning };
      }

      return {
        status: "failed",
        message: `No GitHub token for ${CLOUDPID_REPO}: ${minted.problem.message}.`,
      };
    }

    const { token } = minted;

    /** A refusal of a call, the token dropped first when GitHub refused it. */
    const refusedWith = (failure: IssueCallFailure) => {
      if (failure.kind === "refused_token") deps.tokens.invalidate(token);

      return failedWith(session, task, failure);
    };

    if (!labelSeen) {
      const label = await labelExists(calls, token, CLOUDPID_REPORT_LABEL);

      if (label === "missing") {
        labelMissingUntil = deps.now() + LABEL_MISSING_MEMORY_MS;
        settle(session, task, "failed");

        return labelRefusal();
      }

      if (label !== "exists") return refusedWith(label);

      labelSeen = true;
    }

    const labels = [CLOUDPID_REPORT_LABEL, TRIAGE_LABEL];

    const made = await createIssue(calls, token, {
      title: defuseMentions(input.title),
      body: `${defuseMentions(input.body)}${REPORT_FOOTER_SEPARATOR}${footerOf(input, deps.origin)}`,
      labels,
    });

    if ("sent" in made) {
      settle(session, task, "unknown");

      return { status: "unknown" };
    }

    if ("refused" in made) return refusedWith(made.refused);

    const { number, url } = made.created;

    // Filed: whatever follows, the call answers the issue.
    sql.exec(
      "UPDATE cloudpid_reports SET state = 'filed', number = ?, url = ? WHERE session = ? AND task = ?",
      number,
      url,
      session,
      task,
    );

    const dropped = labels.filter((label) => !made.created.labels.includes(label));

    if (dropped.length === 0) return { status: "filed", number, url, labelled: true };

    const added = await addLabels(calls, token, number, dropped);

    if ("kind" in added && added.kind === "rate_limited") block(added.until);

    const labelled =
      !dropped.includes(CLOUDPID_REPORT_LABEL) ||
      ("labels" in added && added.labels.includes(CLOUDPID_REPORT_LABEL));

    return { status: "filed", number, url, labelled };
  };

  return {
    /** File `input`'s report, or answer what an earlier attempt of its call came to. */
    file: async (input: AgentReportInput): Promise<CloudpidReportAnswer> => {
      const now = deps.now();

      sql.exec("DELETE FROM cloudpid_reports WHERE at <= ?", now - REPORT_MEMORY_MS);

      const earlier = rowOf(input.session, input.task);

      if (earlier !== undefined) {
        if (earlier.state === "filed" && earlier.number !== null && earlier.url !== null) {
          return { status: "filed", number: earlier.number, url: earlier.url, labelled: true };
        }

        if (earlier.state === "failed") {
          return { status: "failed", message: "An earlier attempt of this call was not filed." };
        }

        // `claimed` (an attempt cut off) or `unknown`: it may have been filed.
        return { status: "unknown" };
      }

      const named = namedRepoTerms(
        deps.store.listEnvironments().flatMap(({ repos }) => repos),
        [input.title, input.body],
      );

      if (named.length > 0) {
        return refused(
          "names",
          `the report names the owner's Repos: ${named.map((term) => `\`${term}\``).join(", ")}. The issue is public; describe it without them and file again.`,
        );
      }

      const until = blockedUntil();

      if (until > now) return blockedRefusal(until);

      const capped = claim(input, titleHash(input.title), now);

      if (capped !== undefined) return capped;

      return paced(() => post(input));
    },
  };
};
