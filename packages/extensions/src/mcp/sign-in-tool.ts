// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- a builder over plain values, and pi-durable's
// Promise-based tool seam.
// `mcp_sign_in_ask` (`docs/architecture/mcp-sign-in.md` → Sign-in requests): the agent asks the owner to sign in to an MCP
// server. It is in the `mcp` extension, registered by its rebuild only when the set has an entry that can need an owner's
// sign-in (`signsIn`), deferred, callable by the model alone (not from scripts), and the root conversation's only
// (`isParentOnly`). It never starts, completes or signs out of anything, and shows the model no URL, code or token: the
// owner signs in from the card (`./sign-in.ts` keeps the request, durably).
import { mcpServerNamespace, signsInOnItsOwn } from "@cloudpid/config";
import { isJsonObject, type JsonObject } from "@cloudpid/mcp/types";
import { MAX_SIGN_IN_REASON } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails } from "./details.ts";
import { failedWith } from "./result.ts";
import { MCP_SIGN_IN_TOOL, type McpSignInOutcome, type McpSignInsService } from "./sign-in.ts";
import type { McpBuildServer } from "./tools.ts";

/** How long a sign-in's server is waited for to connect before the answer says it is still connecting, in ms. */
export const MCP_SIGN_IN_CONNECT_WAIT_MS = 10_000;

/**
 * Whether an entry as the host stores it can need an owner's sign-in: an HTTP server without its own `Authorization`
 * header that does not sign in on its own with client credentials (`mcpSignInNotApplicable`, `signsInOnItsOwn`).
 */
export const signsIn = (entry: JsonObject): boolean => {
  if (entry["type"] !== "http" || signsInOnItsOwn({ type: entry["type"], oauth: entry["oauth"] }))
    return false;

  const { headers } = entry;

  return (
    !isJsonObject(headers) ||
    !Arr.some(Record.toEntries(headers), ([name]) => name.toLowerCase() === "authorization")
  );
};

// SAFETY: an object JSON Schema, which pi-ai's `TSchema` describes (TypeBox's are JSON Schema too).
const PARAMETERS = {
  type: "object",
  properties: {
    server: {
      type: "string",
      description:
        "The server's name as the mcp_servers section lists it (mcp__<name> or just <name>).",
    },
    reason: {
      type: "string",
      maxLength: MAX_SIGN_IN_REASON,
      description: "Why you need it, in a sentence: the owner reads this on the sign-in card.",
    },
  },
  required: ["server", "reason"],
  additionalProperties: false,
} as TSchema;

const DESCRIPTION = Arr.join(
  [
    "Ask the owner to sign in to an MCP server that needs it: a server the mcp_servers section marks (needs sign-in), or one whose call failed saying the owner must sign in.",
    "The owner gets a card with your reason and signs in from it; you never see a URL, code or token, and you cannot sign in yourself.",
    "It waits with no deadline until the owner signs in or declines, or you are stopped, so ask once, with a specific reason, and only when you need the server for the task.",
    "Answers: signed_in (the server's tools arrive from your next request), declined, withdrawn (the server was removed, disabled or hidden), step_up_failed, or not_applicable.",
  ],
  " ",
);

/**
 * The enabled server `name` names among `servers`: its name, or its `mcp__` namespace. One that cannot need a sign-in is
 * found too: the Registry answers it `not_applicable`, which is a result and not an error.
 */
const serverNamed = (servers: ReadonlyArray<McpBuildServer>, name: string) => {
  const wanted = name.trim();

  return Arr.findFirst(
    servers,
    (server) =>
      server.state !== "disabled" &&
      (server.name === wanted || mcpServerNamespace(server.name) === wanted),
  );
};

const Args = Schema.Struct({
  server: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

const decodeArgs = Schema.decodeUnknownOption(Args);

/** The call's arguments, as far as they are readable: pi-durable has checked them against `PARAMETERS`. */
const argsOf = (args: Schema.Json): typeof Args.Type =>
  Option.getOrElse(decodeArgs(args), () => ({}));

/** What the model reads when the request ended with `outcome` for `server`, and the `details` that say so. */
const answerOf = (
  server: string,
  outcome: Exclude<McpSignInOutcome, { kind: "signed_in" }>,
  details: McpDetails,
): ToolExecutionResult<JsonValue> => {
  const kept: McpDetails = { ...details, sign_in_request: outcome.kind };

  switch (outcome.kind) {
    case "declined":
      return {
        output: [
          {
            type: "text",
            text: `The owner declined to sign in to ${server}.${
              outcome.reason === undefined ? "" : ` Their reason: ${outcome.reason}`
            } Go on without it, and do not ask again unless they want it.`,
          },
        ],
        details: kept,
      };
    case "withdrawn":
      return {
        output: [
          {
            type: "text",
            text: `The request to sign in to ${server} ended: ${outcome.reason}. Nothing was signed in.`,
          },
        ],
        details: kept,
      };
    case "not_applicable":
      return {
        output: [
          {
            type: "text",
            text: `${server} has no sign-in you can ask the owner for: ${outcome.reason}.`,
          },
        ],
        details: kept,
      };
    case "step_up_failed":
      return failedWith(
        `${server} still wants more access than the owner's sign-ins gave it (${outcome.reason}). The owner may change what it asks for in Settings; go on without it.`,
        kept,
      );
    default:
      // `unavailable`, and an outcome a newer build stored that this one does not know: nothing was signed in.
      return failedWith(
        `The sign-in to ${server} could not be asked for${"reason" in outcome ? `: ${outcome.reason}` : ""}.`,
        { ...details, sign_in_request: "unavailable" },
      );
  }
};

/**
 * The tool, or none: it is registered only for a build whose servers include one that can need a sign-in, and for a Session
 * that keeps Sign-in requests.
 */
export const signInTool = (
  servers: ReadonlyArray<McpBuildServer>,
  client: McpHostClientService,
  options: {
    readonly signIns?: McpSignInsService | undefined;
    readonly environment?: string | undefined;
    readonly connectWaitMs?: number | undefined;
  },
): ToolRegistration | undefined => {
  const { signIns, environment } = options;

  if (signIns === undefined || environment === undefined) return undefined;

  if (!Arr.some(servers, (server) => server.state !== "disabled" && server.signIn === true)) {
    return undefined;
  }

  return {
    name: MCP_SIGN_IN_TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    replay: "safe",
    // Deferred (loaded with `tool_search`) and the model's alone: a script cannot ask the owner for anything.
    deferred: true,
    callers: ["model"],
    execute: async (args, api: ToolExecutionApi, context) => {
      // SAFETY: the arguments pi-durable validated against `PARAMETERS`, an object.
      const input = argsOf(args as JsonObject);
      const wanted = input.server ?? "";
      const named = Option.getOrUndefined(serverNamed(servers, wanted));

      if (named === undefined) {
        const known = Arr.map(
          Arr.filter(servers, (server) => server.state !== "disabled" && server.signIn === true),
          (server) => server.name,
        );

        return failedWith(
          `No enabled MCP server has that name. Servers that can need a sign-in: ${Arr.join(known, ", ")}.`,
          { server: wanted, tool: MCP_SIGN_IN_TOOL },
        );
      }

      const { name } = named;
      const details: McpDetails = { server: name, tool: MCP_SIGN_IN_TOOL };

      const outcome = await Effect.runPromise(
        signIns.ask({
          callId: String(api.taskId),
          conversationId: api.conversationId,
          environment,
          server: name,
          reason: (input.reason ?? "").slice(0, MAX_SIGN_IN_REASON),
        }),
        { signal: context.abortSignal },
      );

      if (outcome.kind !== "signed_in") return answerOf(name, outcome, details);

      // Signed in: the host rediscovers the server on its own; wait a little for it, to say what the agent gets.
      const waited = await Effect.runPromise(
        client.servers({
          names: [name],
          parts: [],
          waitMs: options.connectWaitMs ?? MCP_SIGN_IN_CONNECT_WAIT_MS,
        }),
      );

      const server =
        "servers" in waited
          ? Option.getOrUndefined(Arr.findFirst(waited.servers, (each) => each.name === name))
          : undefined;

      const kept: McpDetails = { ...details, sign_in_request: "signed_in" };

      const text =
        server?.state === "connected"
          ? `Signed in to ${name}. ${String(server.counts.tools)} tools from your next request.`
          : `Signed in to ${name}; it is still connecting, so its tools will arrive from a later request.`;

      return { output: [{ type: "text", text }], details: kept };
    },
  };
};
