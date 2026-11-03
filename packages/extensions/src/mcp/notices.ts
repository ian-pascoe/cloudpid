// The notice that the `mcp_servers` listing changed (`docs/architecture/mcp-in-a-session.md` → The prompt cache and the
// `mcp_servers` section). Each conversation keeps, in a document of its own, the Context Window and the hash of the
// listing it was last shown; when the newest listing differs, one pi-durable `write` submission tells it and the document
// is updated, so a conversation has one notice for each change however many requests, starts or restarts see it: the
// submission's request ID is the conversation's Context Window and how many notices it has had, so a check that ran
// again after a crash between the two writes finds the first submission instead of writing a second, and the checks of
// one conversation run one at a time. (pi-durable 1.4 cannot admit a submission inside a commit; one that can would make
// the two one commit.) The write is a user message and a titled notice: placed at the next boundary while the
// conversation is busy, at once when it is idle, and it never starts a Run.
//
// The listing last shown is the document's while its Context Window is the conversation's current one; otherwise (no
// notice yet in this window, a fork, a Handoff, a navigation) it is that of the section the conversation's context
// holds, so a conversation is never told what its section already says, and a conversation whose context holds no
// section (its first request of the window is yet to show it) is told nothing.
// @effect-diagnostics asyncFunction:off globalDate:off -- plain Promise code over pi-durable's commits.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import {
  listingHashOfSection,
  MCP_SERVERS_KIND,
  MCP_SERVERS_NOTICE,
  MCP_SERVERS_SECTION,
  type McpListing,
  EMPTY_LISTING,
  mcpServersNotice,
} from "./servers.ts";

const context = BACKGROUND_CONTEXT;

/**
 * What a conversation was last shown of the listing: the hash, the Context Window (its head marker's entry, or `start`)
 * it was shown in, and how many notices that window has had. Rewindable, so a fork starts with what its fork point had.
 */
export const McpServersDoc = defineDoc<{ window: string; hash: string; notices: number }>({
  kind: MCP_SERVERS_KIND,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ window: "", hash: "", notices: 0 }),
  checkpointWhen: () => true,
});

/** Where a conversation's notices are written: the Session's Harness. */
export type McpNotices = {
  /**
   * Tell `conversation` of `listing` if it was shown another one: `shown`, when the caller holds it (a request's
   * section), is the section it was shown, else it is read from the conversation's context. True when the conversation's
   * section is shown and it now knows `listing`; false when its context holds no section yet.
   */
  readonly check: (input: {
    readonly conversation: ConversationId;
    readonly listing: McpListing;
    readonly shown?: string | undefined;
  }) => Promise<boolean>;
};

/** The section the transcript's system messages leave in effect, replayed in order (`null` deletes). */
const shownSection = (messages: ReadonlyArray<Message>): string | undefined => {
  let shown: string | undefined;

  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;

    const text = message.sections[MCP_SERVERS_SECTION];

    if (text !== undefined) shown = text === null ? undefined : text;
  }

  return shown;
};

/** The notices over `harness`. */
export const mcpNotices = (harness: Harness): McpNotices => {
  /** The checks of each conversation, one at a time. */
  const lines = new Map<ConversationId, Promise<unknown>>();

  const check = async (
    id: ConversationId,
    listing: McpListing,
    given: string | undefined,
  ): Promise<boolean> => {
    const conversation = await harness.conversation(id, context);

    if (conversation === undefined) return false;

    const section = given ?? shownSection((await conversation.context(context)).messages);

    if (section === undefined) return false;

    const marker = await harness.commit((tx) => tx.latestHeadMarker(id), context);
    const window = String(marker?.id ?? "start");
    const doc = await harness.snapshot(McpServersDoc, id, context);
    const mine = doc?.window === window;
    const before = mine ? doc.hash : listingHashOfSection(section);
    const had = mine ? doc.notices : 0;

    if (before === listing.hash) return true;

    await conversation.submit(
      {
        type: "write",
        requestId: `${MCP_SERVERS_KIND}:${window}:${had + 1}`,
        entry: {
          kind: MCP_SERVERS_KIND,
          model: [
            {
              role: "user",
              content: mcpServersNotice(listing, before === EMPTY_LISTING.hash),
              timestamp: Date.now(),
            },
          ],
          data: { notice: MCP_SERVERS_NOTICE, hash: listing.hash },
        },
      },
      context,
    );

    await harness.commit(async (tx) => {
      const draft = await tx.doc(McpServersDoc, id);

      draft.window = window;
      draft.hash = listing.hash;
      draft.notices = had + 1;
    }, context);

    return true;
  };

  return {
    check: ({ conversation, listing, shown }) => {
      const run = (lines.get(conversation) ?? Promise.resolve()).then(() =>
        check(conversation, listing, shown),
      );

      // The line goes on after a check that failed; its caller sees the failure.
      const next = run.catch(() => undefined);

      lines.set(conversation, next);
      void next.then(() => {
        if (lines.get(conversation) === next) lines.delete(conversation);
      });

      return run;
    },
  };
};
