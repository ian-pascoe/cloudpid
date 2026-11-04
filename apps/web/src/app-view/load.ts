// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting), Socket messages. Loading an App View's data
// for a card: its record (`mcp_app_mount`), then its page and origin (`mcp_app_html`), kept in memory by the record's `viewHash`
// (which names its Environment, source and server, so the origin) and the page's hash, so a card that remounts, or another
// call of the same App, does not fetch the HTML again, and a page is never handed to a server whose origin is another.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- the cache is a native map in one module-level scope.
import type { McpAppHtmlAnswer, McpAppRecord, McpAppStub } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type { SessionClient } from "../session/client.ts";
import { isSandboxOrigin } from "./frame-url.ts";

/** What loading needs of the Session's client: its two App commands. */
export type AppClient = Pick<SessionClient, "mountApp" | "appPage" | "appToolPage">;

/** A page the View is mounted with, and the origin it is served on. */
export interface AppPage {
  readonly html: string;
  /** The page's `_meta.ui`: `csp`, `permissions`, `domain` and `prefersBorder`, as the host keeps it. */
  readonly meta: Extract<McpAppHtmlAnswer, { readonly status: "html" }>["meta"];
  readonly origin: string;
  /** What names the origin of the server this page is of (`viewHash`), when the Session said: a record of another is not its. */
  readonly view?: string;
}

/** What loading a card's View comes to. */
export type AppLoad =
  /** A record and its page: the View mounts. */
  | { readonly status: "view"; readonly record: McpAppRecord; readonly page: AppPage }
  /** A call that is still running has no record yet: the page of its tool's View, which mounts as the call streams. */
  | { readonly status: "running"; readonly page: AppPage }
  /** The call's server is no longer the one that made it (shadowed): "App unavailable", no mount. */
  | { readonly status: "unavailable" }
  /** The record was evicted: the call's summary only. */
  | { readonly status: "stub"; readonly stub: McpAppStub }
  /** The Session has no record of the call (it came before records were kept): an ordinary card. */
  | { readonly status: "none" }
  /** It could not load: "App couldn't load: <why>", with Retry. */
  | { readonly status: "failed"; readonly reason: string };

/** The most pages kept, and the most characters of HTML (about 16 MiB of UTF-16 at 2 bytes, 4 MiB each at most). */
const MAX_PAGES = 8;
const MAX_PAGE_CHARACTERS = 8 * 1024 * 1024;

const pages = new Map<string, AppPage>();

const remember = (key: string, page: AppPage): void => {
  pages.delete(key);
  pages.set(key, page);

  let weight = 0;

  for (const each of pages.values()) weight += each.html.length;

  for (const oldest of pages.keys()) {
    if (pages.size <= MAX_PAGES && weight <= MAX_PAGE_CHARACTERS) break;

    if (oldest === key) continue;

    weight -= pages.get(oldest)?.html.length ?? 0;
    pages.delete(oldest);
  }
};

/** Forget every page: a test's. */
export const forgetPages = (): void => {
  pages.clear();
};

/**
 * The key a page is kept under: a page is by content, but its origin is its server's (and its Environment's, and its
 * source's), which is what `viewHash` names; the same page of two servers, or of one server in two Environments, is two
 * entries. A record that pins no `viewHash` has no key: its page is fetched each time, never shared.
 */
const keyOf = (record: McpAppRecord, hash: string | undefined): string | undefined =>
  record.viewHash === undefined || hash === undefined ? undefined : `${record.viewHash}\0${hash}`;

/** A page the Session answered, checked and ready to frame, with its hash; or why it is not (an `AppLoad` of no View). */
type Framed =
  | { readonly status: "page"; readonly page: AppPage; readonly hash: string }
  | Exclude<AppLoad, { readonly status: "view" | "running" }>;

/**
 * What the Session's answer for a page comes to: a page to frame, or no View. `expectedView` is the `viewHash` its call
 * pinned: a page of another server than the call's is never framed, whoever says it is not (the Session checks this too). A
 * page with no origin to frame it at, or at an origin that is not a sandbox's, is a failure, never a frame.
 */
const framed = (
  answer: McpAppHtmlAnswer,
  pageOrigin: string,
  expectedView: string | undefined,
): Framed => {
  if (answer.status === "unavailable") return { status: "unavailable" };

  if (answer.status !== "html" || !("html" in answer)) {
    const why =
      "message" in answer && answer.message !== undefined ? answer.message : answer.status;

    return { status: "failed", reason: why };
  }

  const view = "view" in answer ? answer.view : undefined;

  if (expectedView !== undefined && view !== undefined && view !== expectedView) {
    return { status: "unavailable" };
  }

  if (!("origin" in answer) || answer.origin === undefined) {
    return { status: "failed", reason: "The host named no sandbox origin for this App" };
  }

  if (!isSandboxOrigin(answer.origin, pageOrigin)) {
    return { status: "failed", reason: "The sandbox origin is not one the page frames" };
  }

  const page: AppPage = { html: answer.html, meta: answer.meta, origin: answer.origin };

  return {
    status: "page",
    page: view === undefined ? page : { ...page, view },
    hash: answer.hash,
  };
};

/**
 * The page of `record`: from memory when its server's copy under its hash is held, else the Session's (`mcp_app_html` by
 * the call, which reads and pins a page the record lacks).
 */
const pageOf = (
  client: AppClient,
  record: McpAppRecord,
  pageOrigin: string,
): Effect.Effect<AppLoad> =>
  Effect.gen(function* () {
    const key = keyOf(record, record.htmlHash);
    const held = key === undefined ? undefined : pages.get(key);

    if (held !== undefined) return { status: "view", record, page: held } as const;

    const made = framed(yield* client.appPage(record.callId), pageOrigin, record.viewHash);

    if (made.status !== "page") return made;

    const kept = keyOf(record, made.hash);

    if (kept !== undefined) remember(kept, made.page);

    return { status: "view", record, page: made.page } as const;
  }).pipe(
    Effect.catchTag("SessionCommandError", (error) =>
      Effect.succeed<AppLoad>({ status: "failed", reason: error.message }),
    ),
  );

/**
 * The page of the View of App tool `toolName` (as the model names it), for call `callId` of it that is running
 * (`mcp_app_html` by the tool): there is no record to say which server's, so the Session reads the page of the one the
 * inventory names, and the page keeps the `view` that names it (`AppPage.view`), for the record's check when it comes. `none`
 * when the Session says `missing` or `unsupported` (it predates this, or the host serves no pages): the View mounts when the
 * call has finished, as it did. A page is kept in memory as a finished call's of the same server is, so the two share it.
 */
export const loadRunningView = (
  client: AppClient,
  toolName: string,
  callId: string,
  pageOrigin: string,
): Effect.Effect<AppLoad> =>
  client.appToolPage(toolName, callId).pipe(
    Effect.map((answer): AppLoad => {
      if (answer.status === "missing" || answer.status === "unsupported") return { status: "none" };

      const made = framed(answer, pageOrigin, undefined);

      if (made.status !== "page") return made;

      if (made.page.view !== undefined) remember(`${made.page.view}\0${made.hash}`, made.page);

      return { status: "running", page: made.page };
    }),
    Effect.catchTag("SessionCommandError", (error) =>
      Effect.succeed<AppLoad>({ status: "failed", reason: error.message }),
    ),
  );

/** Load call `callId`'s View: mount its record, then its page. Never fails: how it ended is the value. */
export const loadAppView = (
  client: AppClient,
  callId: string,
  pageOrigin: string,
): Effect.Effect<AppLoad> =>
  client.mountApp(callId).pipe(
    Effect.flatMap((mounted): Effect.Effect<AppLoad> => {
      if (mounted.status === "stub" && "stub" in mounted) {
        return Effect.succeed({ status: "stub", stub: mounted.stub });
      }

      return mounted.status === "record" && "record" in mounted
        ? pageOf(client, mounted.record, pageOrigin)
        : Effect.succeed({ status: "none" });
    }),
    Effect.catchTag("SessionCommandError", (error) =>
      Effect.succeed<AppLoad>({ status: "failed", reason: error.message }),
    ),
  );
