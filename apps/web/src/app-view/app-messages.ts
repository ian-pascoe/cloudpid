// docs/architecture/mcp-apps.md → App messages and App context. What a View says to the host about the conversation:
// `ui/message` (a message it would have the owner send, which the composer holds as a chip for the owner to Edit, Discard or
// Send, and which never starts a turn by itself) and `ui/update-model-context` (what it tells the model of what the owner is
// doing in it, which the Session holds and gives the model as an untrusted notice). Both take text only: the content blocks
// of another kind are left out. This only decodes what the View sent and hands it on; the limits, the cleaning and the
// redaction are the Session's (context) and the composer's (messages).
/* oxlint-disable anti-slop/no-unknown-parameters -- a handler is given a View's own `params`, which are decoded here before anything reads them */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain functions over the bridge's promises.
import {
  MAX_APP_MESSAGE_CHARS,
  MAX_MCP_APP_CONTEXT_INPUT,
  MCP_APP_INVALID_PARAMS,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HOST_REFUSED, RpcError, type RequestHandler } from "../sandbox-frame/frame-protocol.ts";
import type { BridgeOptions } from "./bridge.ts";

/** What the card does with the View's messages and context; each is only there when the frame can serve it. */
export interface AppSpeech {
  /** Hold the View's message in the composer: `held` (a chip for it, replacing the View's last one), or `refused`. */
  readonly message: (text: string) => Promise<"held" | "refused">;
  /** Send the View's context to the Session: `held`, or the reason it was refused. */
  readonly context: (
    text: string,
  ) => Promise<{ readonly held: boolean; readonly message?: string | undefined }>;
}

/** What an archived Session's View is answered: it holds nothing, whatever the frame was given, and the context says why. */
export const refusingSpeech = (given: Partial<AppSpeech>): Partial<AppSpeech> => {
  const refusing: Types.Mutable<Partial<AppSpeech>> = {};

  if (given.message !== undefined) refusing.message = () => Promise.resolve("refused");

  if (given.context !== undefined) {
    refusing.context = () => Promise.resolve({ held: false, message: "This Session is archived" });
  }

  return refusing;
};

/** The method names, as the spec has them. */
export const UI_MESSAGE = "ui/message";
export const UI_UPDATE_MODEL_CONTEXT = "ui/update-model-context";

const Block = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) });

const Blocks = Schema.Array(Block);

const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({ role: Schema.String, content: Blocks }),
);

const decodeContext = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.optionalKey(Blocks) }),
);

/** The text of `blocks`: each text block's text, joined by a blank line. Other kinds of block are left out. */
export const textOfBlocks = (blocks: ReadonlyArray<typeof Block.Type>): string =>
  Arr.join(
    Arr.flatMap(blocks, (block) =>
      block.type === "text" && block.text !== undefined ? [block.text] : [],
    ),
    "\n\n",
  );

/** `text` cut to `max` characters, not in the middle of a surrogate pair. */
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;

  const end =
    text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;

  return text.slice(0, end);
};

/**
 * The bridge's handlers for a View's `ui/message` and `ui/update-model-context`, as far as `speech` has them. A message is
 * answered `{}` once the composer holds it and `{ isError: true }` when it does not (no room, an archived Session, a Session
 * that cannot take it); a context `{}` once held and a `HOST_REFUSED` (`-32000`) error with the Session's reason when it is not. Params that
 * are not the spec's, or a message with no text, are `-32602`.
 */
export const speechHandlers = (
  speech: Partial<AppSpeech>,
): NonNullable<BridgeOptions["handlers"]> => {
  const handlers: Record<string, RequestHandler> = {};
  const { message, context } = speech;

  if (message !== undefined) {
    handlers[UI_MESSAGE] = async (params) => {
      const decoded = decodeMessage(params);

      if (Option.isNone(decoded) || decoded.value.role !== "user") {
        throw new RpcError(MCP_APP_INVALID_PARAMS, "ui/message needs a user role and content");
      }

      const text = cut(textOfBlocks(decoded.value.content), MAX_APP_MESSAGE_CHARS);

      if (text.trim() === "") throw new RpcError(MCP_APP_INVALID_PARAMS, "ui/message has no text");

      return (await message(text)) === "held" ? {} : { isError: true };
    };
  }

  if (context !== undefined) {
    handlers[UI_UPDATE_MODEL_CONTEXT] = async (params) => {
      const decoded = decodeContext(params);

      if (Option.isNone(decoded)) {
        throw new RpcError(MCP_APP_INVALID_PARAMS, "ui/update-model-context needs content blocks");
      }

      // An update with no text clears the context the View had pending.
      const answer = await context(
        cut(textOfBlocks(decoded.value.content ?? []), MAX_MCP_APP_CONTEXT_INPUT),
      );

      if (!answer.held)
        throw new RpcError(HOST_REFUSED, answer.message ?? "The host did not take the context");

      return {};
    };
  }

  return handlers;
};
