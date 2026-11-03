// The notice that the `mcp_servers` listing changed (`docs/architecture/mcp-in-a-session.md` → The prompt cache and the
// `mcp_servers` section). A conversation is told once for each change, by one pi-durable `write` submission: a user
// message and a titled notice, placed at the next boundary while the conversation is busy, at once when it is idle, and
// never starting a Run.
//
// What a conversation was last shown is read from what it holds, never from a record written beside it: the newest of the
// section its context shows and the notices placed after it (each carries the hash of its listing), then any notice
// still queued for it (its request ID ends in the hash). A record written at submit time would be wrong for a busy
// conversation until the notice is placed (a fork in between would never be told) and after a crash that lost it. So a
// notice is one write: the submission, whose request ID is the entry the baseline is, how many notices are queued behind
// it and the listing's hash. A check that runs again finds that submission instead of writing a second, and no id of an
// earlier notice is reused, a flip back included. The checks of one conversation run one at a time.
// @effect-diagnostics asyncFunction:off globalDate:off -- plain Promise code over pi-durable's commits.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, ContextView, EntryId, Harness } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import {
  EMPTY_LISTING,
  listingHashOfSection,
  MCP_SERVERS_KIND,
  MCP_SERVERS_NOTICE,
  MCP_SERVERS_SECTION,
  type McpIntroFeatures,
  type McpListing,
  mcpServersNotice,
} from "./servers.ts";

const context = BACKGROUND_CONTEXT;

/** How a check of one conversation ended. */
export type McpCheckResult = {
  readonly conversation: ConversationId;
  /**
   * `current`: its context now holds `listing`, shown or told (a notice may have been written or still be queued).
   * `unshown`: its context shows no section yet (its first request of the window shows it), or it is gone.
   * `pending`: it shows no section yet but has a Run live, which may be in its first `prepare` and rendering the section
   * as it is now: it is neither told nor left out of later checks.
   * `failed`: the check could not be made; `error` says why.
   */
  readonly outcome: "current" | "unshown" | "pending" | "failed";
  readonly error?: unknown;
};

/** Where a conversation's notices are written, and which conversations there are: the Session's Harness. */
export type McpNotices = {
  /**
   * Tell each of `conversations` of `listing` if what it was last shown is another: its section and the notices after
   * it, or the notices still queued for it. `features` is what the intro may name when a notice must bring it. A few
   * checks run side by side, one conversation's one at a time, and one failing never stops the others; the Harness is
   * asked what is queued once for them all.
   */
  readonly check: (input: {
    readonly conversations: ReadonlyArray<ConversationId>;
    readonly listing: McpListing;
    readonly features: McpIntroFeatures;
  }) => Promise<ReadonlyArray<McpCheckResult>>;
  /** Every conversation of the Session. */
  readonly conversations: () => Promise<ReadonlyArray<ConversationId>>;
};

/** How many conversations a check reads at once. */
const CHECK_CONCURRENCY = 4;

/** The listing a conversation's context last showed it, and the entry that did. */
type Shown = { readonly entry: EntryId; readonly hash: string };

/** The newest of the section the context shows and the notices placed after it; none when it shows no section. */
const shownIn = (view: ContextView): Shown | undefined => {
  let shown: Shown | undefined;

  for (const [index, entry] of view.entries.entries()) {
    const contributed = view.contributions[index] ?? [];

    if (entry.kind === MCP_SERVERS_KIND && contributed.length > 0) {
      const hash = Predicate.hasProperty(entry.data, "hash") ? entry.data.hash : undefined;

      // A notice shows the listing it carried; one this build cannot read shows nothing.
      if (Predicate.isString(hash) && shown !== undefined) shown = { entry: entry.id, hash };

      continue;
    }

    for (const message of contributed) {
      if (message.role !== "system") continue;

      const text = message.sections?.[MCP_SERVERS_SECTION];

      if (text === undefined) continue;

      shown = text === null ? undefined : { entry: entry.id, hash: listingHashOfSection(text) };
    }
  }

  return shown;
};

/** The hash a queued notice carries: the end of its request ID. */
const queuedHash = (requestId: string): string => requestId.slice(requestId.lastIndexOf(":") + 1);

/** What `harness.inspect` said of the queued notices at one moment, and when. */
type Queued = {
  /** The write ticks the answer is as new as: a conversation written since is read again. */
  readonly tick: number;
  /** The conversations with a task live when it was asked. */
  readonly busy: ReadonlySet<ConversationId>;
  readonly byConversation: ReadonlyMap<ConversationId, ReadonlyArray<string>>;
};

/** The notices over `harness`. */
export const mcpNotices = (harness: Harness): McpNotices => {
  /** The checks of each conversation, one at a time. */
  const lines = new Map<ConversationId, Promise<unknown>>();

  /** The number of notices written, and the number when each conversation was last written. */
  let tick = 0;
  const written = new Map<ConversationId, number>();

  /** The request IDs of the notices queued for each conversation, oldest first. */
  const queuedOf = async (): Promise<Queued> => {
    const taken = tick;
    const inspection = await harness.inspect(context);
    const byConversation = new Map<ConversationId, string[]>();

    for (const each of inspection.submissions) {
      if (
        each.type !== "write" ||
        each.status !== "queued" ||
        each.requestId?.startsWith(`${MCP_SERVERS_KIND}:`) !== true
      ) {
        continue;
      }

      byConversation.set(each.conversationId, [
        ...(byConversation.get(each.conversationId) ?? []),
        each.requestId,
      ]);
    }

    const busy = new Set(Arr.map(inspection.tasks, (task) => task.record.conversationId));

    return { tick: taken, busy, byConversation };
  };

  const check = async (
    id: ConversationId,
    listing: McpListing,
    features: McpIntroFeatures,
    shared: Promise<Queued>,
  ): Promise<McpCheckResult["outcome"]> => {
    const conversation = await harness.conversation(id, context);

    if (conversation === undefined) return "unshown";

    // Queued first: a notice placed between the two reads is then seen as placed, or as both, never as neither. What was
    // asked once for the whole check is used unless this conversation was written since, whose queue it cannot show.
    const seen = await shared;
    const queued = (written.get(id) ?? 0) <= seen.tick ? seen : await queuedOf();
    const ids = queued.byConversation.get(id) ?? [];
    const shown = shownIn(await conversation.context(context));

    if (shown === undefined) return seen.busy.has(id) ? "pending" : "unshown";

    const last = ids.at(-1);
    const told = last === undefined ? shown.hash : queuedHash(last);

    if (told === listing.hash) return "current";

    // The section listed nothing: the notice brings the intro it never had.
    const intro =
      told === EMPTY_LISTING.hash
        ? {
            ...features,
            codemodeDeferred: Arr.some(
              (await conversation.agent(context)).deferred,
              (tool) => tool.name === "codemode",
            ),
          }
        : undefined;

    await conversation.submit(
      {
        type: "write",
        requestId: `${MCP_SERVERS_KIND}:${shown.entry}:${ids.length}:${listing.hash}`,
        entry: {
          kind: MCP_SERVERS_KIND,
          model: [
            { role: "user", content: mcpServersNotice(listing, intro), timestamp: Date.now() },
          ],
          data: { notice: MCP_SERVERS_NOTICE, hash: listing.hash },
        },
      },
      context,
    );

    tick += 1;
    written.set(id, tick);

    return "current";
  };

  /** One check of `id` in its line: after the ones before it, which it never stops by failing. */
  const inLine = (
    id: ConversationId,
    listing: McpListing,
    features: McpIntroFeatures,
    shared: Promise<Queued>,
  ): Promise<McpCheckResult> => {
    const run = (lines.get(id) ?? Promise.resolve()).then(() =>
      check(id, listing, features, shared),
    );

    // The line goes on after a check that failed; its result says so.
    const next = run.catch(() => undefined);

    lines.set(id, next);
    void next.then(() => {
      if (lines.get(id) === next) lines.delete(id);
    });

    return run.then(
      (outcome): McpCheckResult => ({ conversation: id, outcome }),
      (error): McpCheckResult => ({ conversation: id, outcome: "failed", error }),
    );
  };

  return {
    check: async ({ conversations, listing, features }) => {
      // One answer for every conversation checked, asked once: a conversation is read again only if written since.
      const shared = queuedOf();

      // A failed answer is every check's failure, not an unhandled rejection of a promise nobody awaits yet.
      shared.catch(() => undefined);

      const results: McpCheckResult[] = [];
      let next = 0;

      const worker = async () => {
        while (next < conversations.length) {
          const id = conversations[next];

          next += 1;

          if (id !== undefined) results.push(await inLine(id, listing, features, shared));
        }
      };

      await Promise.all(Arr.makeBy(Math.min(CHECK_CONCURRENCY, conversations.length), worker));

      return results;
    },
    conversations: () =>
      harness.commit(async (tx) => {
        const found: ConversationId[] = [];
        let page = await tx.scanConversations({}, 200);

        for (;;) {
          for (const each of page.items) found.push(each.id);

          if (page.next === undefined) return found;

          page = await tx.scanConversations({}, 200, page.next);
        }
      }, context),
  };
};
