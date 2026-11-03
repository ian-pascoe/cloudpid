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

/** Where a conversation's notices are written, and which conversations there are: the Session's Harness. */
export type McpNotices = {
  /**
   * Tell `conversation` of `listing` if what it was last shown is another: its section and the notices after it, or
   * the notices still queued for it. `features` is what the intro may name when the notice must bring it. True when the
   * conversation's context shows the section and it now has (or is queued) `listing`; false when it shows none yet.
   */
  readonly check: (input: {
    readonly conversation: ConversationId;
    readonly listing: McpListing;
    readonly features: McpIntroFeatures;
  }) => Promise<boolean>;
  /** Every conversation of the Session. */
  readonly conversations: () => Promise<ReadonlyArray<ConversationId>>;
};

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

/** The notices over `harness`. */
export const mcpNotices = (harness: Harness): McpNotices => {
  /** The checks of each conversation, one at a time. */
  const lines = new Map<ConversationId, Promise<unknown>>();

  const check = async (
    id: ConversationId,
    listing: McpListing,
    features: McpIntroFeatures,
  ): Promise<boolean> => {
    const conversation = await harness.conversation(id, context);

    if (conversation === undefined) return false;

    // Queued first: a notice placed between the two reads is then seen as placed, or as both, never as neither.
    const inspection = await harness.inspect(context);

    const queued = Arr.filter(
      inspection.submissions,
      (each) =>
        each.conversationId === id &&
        each.type === "write" &&
        each.status === "queued" &&
        each.requestId?.startsWith(`${MCP_SERVERS_KIND}:`) === true,
    );

    const shown = shownIn(await conversation.context(context));

    if (shown === undefined) return false;

    const last = queued.at(-1)?.requestId;
    const told = last === undefined ? shown.hash : queuedHash(last);

    if (told === listing.hash) return true;

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
        requestId: `${MCP_SERVERS_KIND}:${shown.entry}:${queued.length}:${listing.hash}`,
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

    return true;
  };

  return {
    check: ({ conversation, listing, features }) => {
      const run = (lines.get(conversation) ?? Promise.resolve()).then(() =>
        check(conversation, listing, features),
      );

      // The line goes on after a check that failed; its caller sees the failure.
      const next = run.catch(() => undefined);

      lines.set(conversation, next);
      void next.then(() => {
        if (lines.get(conversation) === next) lines.delete(conversation);
      });

      return run;
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
