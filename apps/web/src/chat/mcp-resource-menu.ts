// The MCP resources the composer's `@` menu lists after the files (`docs/architecture/mcp-in-a-session.md` → Attached
// resources), kept per conversation. The Session reads the servers' lists, which starts no Container (a stopped stdio
// server comes back as a muted row), and the listing is held for `MENU_LISTING_TTL_MS` (30 s): asked for when the `@` menu
// first opens, and again once it is older than that, so a resource added meanwhile shows up without a reload. A failure
// keeps what the menu had, and the next opening after `RESOURCE_MENU_RETRY_MS` asks again. A Session that does not take
// the request (its `hello` lacks `attachedResources`) answers no servers, and the menu has no resource rows.

import { MENU_LISTING_TTL_MS, type McpResourceMenu } from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import type { ConversationKey } from "./conversation.ts";

/** How long to wait before asking again after the Session could not answer. */
export const RESOURCE_MENU_RETRY_MS = 5_000;

/** A listing as the composer has it, whether it is being asked for, and when it may be again. */
interface Held {
  readonly menu: McpResourceMenu | null;
  readonly asking: boolean;
  readonly nextAt: number;
}

const heldAtom = Atom.family((_key: ConversationKey) =>
  Atom.make<Held>({ menu: null, asking: false, nextAt: 0 }),
);

/** The MCP resources of a conversation's `@` menu: null until the Session first answered. Kept while a composer reads it. */
export const resourceMenuAtom = Atom.family((key: ConversationKey) =>
  Atom.map(heldAtom(key), (held) => held.menu),
);

/** Ask for the listing of a conversation unless it is fresh or a request is out. */
export const askResourceMenuAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn(
    (_: void, get) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const held = get(heldAtom(key));

        if (held.asking || now < held.nextAt) return;

        const settle = (change: (held: Held) => Held) =>
          Effect.sync(() => {
            get.set(heldAtom(key), change(get(heldAtom(key))));
          });

        yield* settle((before) => ({ ...before, asking: true }));

        const answer = yield* get.result(sessionClientAtom(key.sessionId)).pipe(
          Effect.flatMap((client) => client.resourceMenu(key.conversationId)),
          Effect.exit,
          // Stopped (nothing reads the listing any more): the next composer may ask at once.
          Effect.onInterrupt(() => settle((before) => ({ ...before, asking: false }))),
        );

        const at = yield* Clock.currentTimeMillis;

        yield* settle((before) =>
          Exit.isSuccess(answer)
            ? { menu: answer.value, asking: false, nextAt: at + MENU_LISTING_TTL_MS }
            : { ...before, asking: false, nextAt: at + RESOURCE_MENU_RETRY_MS },
        );
      }),
    { concurrent: true },
  ),
);
