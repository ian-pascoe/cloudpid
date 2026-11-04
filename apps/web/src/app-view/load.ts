// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting), Socket messages. Loading an App View's data
// for a card: its record (`mcp_app_mount`), then its page and origin (`mcp_app_html`), kept in memory by (server, hash) so a
// card that remounts, or another call of the same App, does not fetch the HTML again.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- the cache is a native map in one module-level scope.
import type { McpAppHtmlAnswer, McpAppRecord, McpAppStub } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type { SessionClient } from "../session/client.ts";

/** What loading needs of the Session's client: its two App commands. */
export type AppClient = Pick<SessionClient, "mountApp" | "appPage">;

import { isSandboxOrigin } from "./frame-url.ts";

/** A page the View is mounted with, and the origin it is served on. */
export interface AppPage {
  readonly html: string;
  /** The page's `_meta.ui`: `csp`, `permissions`, `domain` and `prefersBorder`, as the host keeps it. */
  readonly meta: Extract<McpAppHtmlAnswer, { readonly status: "html" }>["meta"];
  readonly origin: string;
}

/** What loading a card's View comes to. */
export type AppLoad =
  /** A record and its page: the View mounts. */
  | { readonly status: "view"; readonly record: McpAppRecord; readonly page: AppPage }
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

/** The key a page is kept under: a page is by content, but its origin is its server's, so two servers' copies are two entries. */
const keyOf = (record: McpAppRecord): string | undefined =>
  record.htmlHash === undefined ? undefined : `${record.server}\0${record.htmlHash}`;

/**
 * The page of `record`: from memory when its server's copy under its hash is held, else the Session's (`mcp_app_html` by
 * the call, which reads and pins a page the record lacks). A page with no origin to frame it at, or at an origin that
 * is not a sandbox's, is a failure, never a frame.
 */
const pageOf = (client: AppClient, record: McpAppRecord): Effect.Effect<AppLoad> =>
  Effect.gen(function* () {
    const key = keyOf(record);
    const held = key === undefined ? undefined : pages.get(key);

    if (held !== undefined) return { status: "view", record, page: held } as const;

    const answer = yield* client.appPage(record.callId);

    if (answer.status !== "html" || !("html" in answer)) {
      const why =
        "message" in answer && answer.message !== undefined ? answer.message : answer.status;

      return { status: "failed", reason: why } as const;
    }

    if (!("origin" in answer) || answer.origin === undefined) {
      return { status: "failed", reason: "The host named no sandbox origin for this App" } as const;
    }

    if (!isSandboxOrigin(answer.origin)) {
      return { status: "failed", reason: "The sandbox origin is not one the page frames" } as const;
    }

    const page: AppPage = { html: answer.html, meta: answer.meta, origin: answer.origin };

    remember(`${record.server}\0${answer.hash}`, page);

    return { status: "view", record, page } as const;
  }).pipe(
    Effect.catchTag("SessionCommandError", (error) =>
      Effect.succeed<AppLoad>({ status: "failed", reason: error.message }),
    ),
  );

/** Load call `callId`'s View: mount its record, then its page. Never fails: how it ended is the value. */
export const loadAppView = (client: AppClient, callId: string): Effect.Effect<AppLoad> =>
  client.mountApp(callId).pipe(
    Effect.flatMap((mounted): Effect.Effect<AppLoad> => {
      if (mounted.status === "stub" && "stub" in mounted) {
        return Effect.succeed({ status: "stub", stub: mounted.stub });
      }

      return mounted.status === "record" && "record" in mounted
        ? pageOf(client, mounted.record)
        : Effect.succeed({ status: "none" });
    }),
    Effect.catchTag("SessionCommandError", (error) =>
      Effect.succeed<AppLoad>({ status: "failed", reason: error.message }),
    ),
  );
