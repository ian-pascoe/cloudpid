// The Session's App context (`docs/architecture/mcp-apps.md` → App messages and App context): what an App View told the
// model of what the owner is doing in it (`ui/update-model-context`, as `mcp_app_context`). It is held pending, the latest for
// each call, and the same text once (a remount sends it again): cleaned (control characters), redacted of the Secrets held and
// cut to `MAX_MCP_APP_CONTEXT_BYTES`. The host takes the pending ones of a conversation (`take`) to write them as one untrusted
// notice (`appContextNotice`), when input is admitted to it or at its next boundary while it is busy, and marks them delivered
// once the write is admitted; nothing delivered is withdrawn, and a new Context Window does not send them again. A Fork or
// Clone carries none (they are not part of what `copiesFor` copies) and a conversation the active branch moved off drops its
// pending ones (`drop`). Kept in the Session's key-value storage, a value for each call and an index of them; the card's chip
// reads the last one of a call (`contextOf`) from the list of App calls.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain storage reads, under Effect.sync.
import { sha256Hex } from "@cloudpid/config";
import {
  appContextNotice,
  MCP_APP_CONTEXT_KIND,
  MCP_APP_CONTEXT_NOTICE,
} from "@cloudpid/extensions/mcp";
import {
  cleanText,
  type ConversationId,
  cutUtf8,
  MAX_MCP_APP_CONTEXT_BYTES,
  MAX_MCP_APP_CONTEXTS,
  MAX_MCP_APP_CONTEXTS_PER_MINUTE,
  MAX_MCP_APP_PENDING,
  type McpAppContext,
  type McpAppContextAnswer,
} from "@cloudpid/protocol";
import type { EntryDraft } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Types from "effect/Types";
import { socketRequests } from "./socket-requests.ts";
import type { McpWatchesService } from "./mcp-watches.ts";
import type { SessionKv } from "./session-kv.ts";

/** What the call's record says of it: the server and tool whose View it is, and the conversation it was made in. */
export type AppContextCall = {
  readonly server: string;
  readonly tool: string;
  readonly conversation: string;
  /** For a call nested in a `codemode` script, the script's call: the one the model's History holds. */
  readonly parentCall?: string | undefined;
};

/** The index of every held context, oldest first. */
const INDEX_KEY = "cloudpid:mcp-app-contexts";

const contextKey = (callId: string) => `cloudpid:mcp-app-context:${callId}`;

/** What an index entry says of a context, so a conversation's pending ones are found without reading them all. */
type IndexItem = {
  readonly callId: string;
  readonly conversation: string;
  readonly at: number;
  readonly delivered: boolean;
};

/** What is kept of one call's context. */
type Held = McpAppContext & {
  readonly conversation: string;
  readonly server: string;
  readonly tool: string;
};

/** A pending context and the call it is of. */
type Pending = { readonly callId: string; readonly held: Held };

/** The pending contexts of a conversation, taken to be written as one notice; the host says how it went. */
export type AppContextTaken = {
  /** The submission's request ID: the same set of contexts, once held, always has the same one, so a resend finds the first write. */
  readonly requestId: string;
  /** The `write` that tells the conversation, never starting a Run. */
  readonly entry: EntryDraft;
  /** The write was admitted: these contexts are delivered, and not sent again. */
  readonly delivered: Effect.Effect<void>;
  /** The write was not admitted: these contexts are pending again, for the next take. */
  readonly release: Effect.Effect<void>;
};

/** The App context the Session holds. */
export type AppContexts = {
  /** An App View's context, for the call `callId`, as its socket sent it: held, or refused and why. Never fails. */
  readonly hold: (input: {
    readonly view: WebSocket;
    readonly callId: string;
    readonly text: string;
    /**
     * The conversation to give it to, asked once the record and the View's limit have passed (it may read a History); none when
     * no conversation can take it, which refuses the context. Left out: the one the call's record names.
     */
    readonly where?: ((call: AppContextCall) => Effect.Effect<string | undefined>) | undefined;
  }) => Effect.Effect<McpAppContextAnswer>;
  /** What the record of call `callId` says of it; none for a call with no record. */
  readonly callOf: (callId: string) => AppContextCall | undefined;
  /** The last context of call `callId`, for the card's chip. */
  readonly contextOf: (callId: string) => McpAppContext | undefined;
  /**
   * The last context of call `callId` as seen from `conversation` (an export of it): `here` when it was held for that conversation,
   * so its delivered flag says what its model has read; else it was held for another branch, which says nothing of this one.
   */
  readonly contextFor: (
    callId: string,
    conversation: string,
  ) => { readonly context: McpAppContext; readonly here: boolean } | undefined;
  /** Take the pending contexts of `conversation`, as one notice; none when it has none that another take has not taken. */
  readonly take: (conversation: string) => Effect.Effect<AppContextTaken | undefined>;
  /** Drop the pending contexts of `conversation` (its branch was moved off); delivered ones stay as they were. */
  readonly drop: (conversation: string) => Effect.Effect<void>;
};

/**
 * What the Session ends of a conversation it has left (the active branch moved off it, or its subagent was deleted): the
 * Resource watches its agent started, silently, and the App contexts still pending for it.
 */
export const leaveConversation =
  (watches: McpWatchesService, contexts: AppContexts) => (conversation: ConversationId) =>
    watches.endConversation(conversation).pipe(Effect.andThen(contexts.drop(String(conversation))));

export type AppContextsOptions = {
  readonly storage: SessionKv;
  /** The record of call `callId`, kept or evicted; none for a call the Session has no record of. */
  readonly call: (callId: string) => Option.Option<AppContextCall>;
  /** The Secrets held, to redact what is held and what is written. */
  readonly secrets: Effect.Effect<{ readonly redact: <A>(value: A) => A }>;
  /** `conversations` have contexts that changed: their lists are sent again. */
  readonly changed: (conversations: ReadonlySet<string>) => void;
  readonly now: () => number;
};

/** What a client sees of a held context. */
const showing = (held: Held): McpAppContext => {
  const context: Types.Mutable<McpAppContext> = { hash: held.hash, text: held.text, at: held.at };

  if (held.delivered === true) context.delivered = true;

  return context;
};

/** `text` as a context: cleaned, redacted, and cut to the bound with an ellipsis that says it was cut. */
const bounded = (text: string): string => {
  const trimmed = text.trim();

  if (cutUtf8(trimmed, MAX_MCP_APP_CONTEXT_BYTES) === trimmed) return trimmed;

  // The ellipsis is three bytes: the cut leaves room for it, so the whole stays within the bound.
  return `${cutUtf8(trimmed, MAX_MCP_APP_CONTEXT_BYTES - 3).trimEnd()}…`;
};

export const appContextsOver = (options: AppContextsOptions): AppContexts => {
  const { storage, now } = options;
  const limits = socketRequests(now);

  /** The contexts a take holds until the host says how the write went: `<callId>:<hash>`. */
  const claimed = new Set<string>();

  const index = (): ReadonlyArray<IndexItem> =>
    storage.get<ReadonlyArray<IndexItem>>(INDEX_KEY) ?? [];

  const read = (callId: string): Held | undefined => storage.get<Held>(contextKey(callId));

  const claimKey = (callId: string, hash: string) => `${callId}:${hash}`;

  /** The conversation the call's record is of, which lists the call (its chip is read from there), as a set of none or one. */
  const homeOf = (callId: string): ReadonlyArray<string> =>
    Option.match(options.call(callId), {
      onNone: () => [],
      onSome: (call) => [call.conversation],
    });

  /** Write `held` as call `callId`'s context, and its index entry; the oldest delivered, then the oldest, past the bound are dropped. */
  const keep = (callId: string, held: Held): ReadonlySet<string> => {
    const touched = new Set<string>([held.conversation, ...homeOf(callId)]);

    const item: IndexItem = {
      callId,
      conversation: held.conversation,
      at: held.at,
      delivered: held.delivered === true,
    };

    storage.put(contextKey(callId), held);

    const next: IndexItem[] = [...Arr.filter(index(), (each) => each.callId !== callId), item];

    while (next.length > MAX_MCP_APP_CONTEXTS) {
      const at = next.findIndex((each) => each.delivered && each.callId !== callId);
      const [gone] = next.splice(at === -1 ? 0 : at, 1);

      if (gone !== undefined) {
        storage.delete(contextKey(gone.callId));
        touched.add(gone.conversation);
      }
    }

    storage.put(INDEX_KEY, next);

    return touched;
  };

  const remove = (callId: string): ReadonlySet<string> => {
    const gone = Arr.findFirst(index(), (each) => each.callId === callId);

    storage.delete(contextKey(callId));
    storage.put(
      INDEX_KEY,
      Arr.filter(index(), (each) => each.callId !== callId),
    );

    return new Set([...(Option.isSome(gone) ? [gone.value.conversation] : []), ...homeOf(callId)]);
  };

  const hold: AppContexts["hold"] = ({ view, callId, text, where }) =>
    Effect.gen(function* () {
      const call = options.call(callId);

      if (Option.isNone(call)) {
        return { status: "refused", message: "No App record of this Session keeps that call" };
      }

      if (!limits.of(view, callId).admits("context", MAX_MCP_APP_CONTEXTS_PER_MINUTE)) {
        return {
          status: "refused",
          message: `At most ${MAX_MCP_APP_CONTEXTS_PER_MINUTE} contexts a minute for each App View`,
        };
      }

      const redactor = yield* options.secrets;
      // Redacted after it is cleaned, so a Secret split by a character the cleaning drops is whole when it is redacted.
      const cleaned = bounded(redactor.redact(cleanText(text)));
      const current = read(callId);

      // An empty context clears what is pending; what was delivered is not withdrawn.
      if (cleaned === "") {
        if (current === undefined) return { status: "held" };

        if (current.delivered === true) return { status: "held", context: showing(current) };

        options.changed(remove(callId));

        return { status: "held" };
      }

      const hash = sha256Hex(cleaned);
      const conversation = where === undefined ? call.value.conversation : yield* where(call.value);

      if (conversation === undefined) {
        return {
          status: "refused",
          message:
            "The conversation that call was made in was left, and the one shown does not hold it: there is nothing to tell",
        };
      }

      // The same text again (a remount sends it) for the conversation that has it: held once. One whose conversation is not the
      // one that has it (the View is shown in another branch now) is held again for that one, which has not been told.
      if (current?.hash === hash && current.conversation === conversation) {
        return { status: "held", context: showing(current) };
      }

      // The cap is on distinct calls: a call's own pending context is not counted, so it is always replaced.
      const waiting = Arr.filter(
        index(),
        (each) => each.conversation === conversation && !each.delivered && each.callId !== callId,
      ).length;

      if (waiting >= MAX_MCP_APP_PENDING) {
        return {
          status: "refused",
          message: `At most ${MAX_MCP_APP_PENDING} App contexts wait for a conversation: they are given to the model with the owner's next message`,
        };
      }

      const held: Held = {
        hash,
        text: cleaned,
        at: now(),
        conversation,
        server: call.value.server,
        tool: call.value.tool,
      };

      options.changed(keep(callId, held));

      return { status: "held", context: showing(held) };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("An App View's context failed in the Session", cause).pipe(
          Effect.as<McpAppContextAnswer>({
            status: "refused",
            message: "The Session could not hold the context",
          }),
        ),
      ),
    );

  const take: AppContexts["take"] = (conversation) =>
    Effect.gen(function* () {
      const pending = Arr.flatMap(
        Arr.filter(
          index(),
          (each: IndexItem) => each.conversation === conversation && !each.delivered,
        ),
        (each: IndexItem): ReadonlyArray<Pending> => {
          const held = read(each.callId);

          return held === undefined || claimed.has(claimKey(each.callId, held.hash))
            ? []
            : [{ callId: each.callId, held }];
        },
      );

      const taken = Arr.sort(
        pending,
        Order.combine(
          Order.mapInput(Order.Number, (each: Pending) => each.held.at),
          Order.mapInput(Order.String, (each: Pending) => each.callId),
        ),
      );

      if (taken.length === 0) return undefined;

      const redactor = yield* options.secrets;

      // Redacted again as it is written: a Secret the owner entered since it was held is not given to the model.
      const items = Arr.map(taken, ({ held }) => ({
        server: held.server,
        tool: held.tool,
        text: redactor.redact(held.text),
      }));

      const keys = Arr.map(taken, ({ callId, held }) => claimKey(callId, held.hash));
      const at = now();

      for (const key of keys) claimed.add(key);

      const unclaim = () => {
        for (const key of keys) claimed.delete(key);
      };

      const entry: EntryDraft = {
        kind: MCP_APP_CONTEXT_KIND,
        model: [{ role: "user", content: appContextNotice(items), timestamp: at }],
        data: {
          notice: MCP_APP_CONTEXT_NOTICE,
          untrusted: true,
          from: "mcp-app",
          apps: Arr.map(taken, ({ callId, held }) => ({
            callId,
            server: held.server,
            tool: held.tool,
            hash: held.hash,
          })),
        },
      };

      return {
        // The set of contexts and when each was held, so the same ones resent find their write and a later one never does.
        requestId: `${MCP_APP_CONTEXT_KIND}:${conversation}:${sha256Hex(
          Arr.join(
            Arr.map(taken, ({ callId, held }) => `${callId}:${held.hash}:${held.at}`),
            "\n",
          ),
        ).slice(0, 32)}`,
        entry,
        delivered: Effect.sync(() => {
          const touched = new Set<string>();

          for (const { callId, held } of taken) {
            const latest = read(callId);

            // A newer context held meanwhile stays pending.
            if (latest?.hash === held.hash) {
              for (const each of keep(callId, { ...latest, delivered: true })) touched.add(each);
            }
          }

          unclaim();
          options.changed(touched);
        }),
        release: Effect.sync(unclaim),
      } satisfies AppContextTaken;
    });

  const drop: AppContexts["drop"] = (conversation) =>
    Effect.sync(() => {
      const touched = new Set<string>();

      for (const each of index()) {
        if (each.conversation !== conversation || each.delivered) continue;

        for (const gone of remove(each.callId)) touched.add(gone);
      }

      if (touched.size > 0) options.changed(touched);
    });

  return {
    hold,
    callOf: (callId) => Option.getOrUndefined(options.call(callId)),
    contextOf: (callId) => {
      const held = read(callId);

      return held === undefined ? undefined : showing(held);
    },
    contextFor: (callId, conversation) => {
      const held = read(callId);

      return held === undefined
        ? undefined
        : { context: showing(held), here: held.conversation === conversation };
    },
    take,
    drop,
  };
};
