// The owner's preview of a resource a tool call's card links, in the Session (`docs/architecture/mcp-in-a-session.md` →
// Resource links and embedded resources). The checks that are the Session's, in order, before anything is read; they are
// the ones an App View's request has (`./mcp-app-calls.ts`), those that fit a request that is the owner's own:
//
// 1. **A visible page.** A socket that has not said its page is visible is refused (`hidden`): no background tab reads.
// 2. **The limits**, for each socket: `MAX_MCP_RESOURCE_PER_MINUTE` reads a minute, counted when they arrive, and
//    `MAX_MCP_RESOURCE_IN_FLIGHT` at once; over either is `limit`.
// 3. **A Result Spill's file**, when the card names one: read from the Workspace through the Session's lookup environment,
//    which never starts the Container (`SessionHost.spill`); a file that is gone is read by its URI, as a link is.
//
// A preview of more than `PREVIEW_SLOT_OVER` (a file, or a result the host streams) takes the isolate's one decode slot, as a
// large call's result does, and holds it until the answer has been sent: the bytes, their base64, the answer's JSON and the
// socket's copy are alive together, and two of them at once would not fit the object's 128 MB. The previews wait in turn, each
// for at most `MCP_STREAM_SLOT_WAIT_MS`, and one that waits that long is told (`failed`) to try again. A preview takes its turn
// once: the read by the resource's URI that follows a spill's missing file has the turn the spill took.
// 4. **What the extension checks against the inventory** (`McpTools.resourcePreview`): a server that is not switched off or
//    `hidden`, a host that starts no Container for the read. The host checks the same again.
//
// What an App View's request has and this does not: a call's record (the card names the server and URI of its own call;
// the owner is the one asking, so any server of the set is theirs to read), an audit log (there is no record to keep it in;
// a span names the server and the outcome, never the URI) and the archived check (a read changes nothing). The answer is
// not redacted: a preview is the owner's own view, and is kept nowhere. A read ends when the host answers, or when its
// socket goes (`endResourcePreviews`), which aborts the host's request.
import {
  MCP_STREAM_SLOT_WAIT_MS,
  type McpResourcePreviewInput,
  takeDecodeSlot,
} from "@cloudpid/extensions/mcp";
import {
  MAX_MCP_RESOURCE_IN_FLIGHT,
  MAX_MCP_RESOURCE_PER_MINUTE,
  MAX_MCP_RESOURCE_PREVIEW_BYTES,
  type McpResourcePreviewAnswer,
  resourceUnavailable,
} from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { socketRequests } from "./socket-requests.ts";

/** What the Session's Workspace holds at a Result Spill's path (`SessionHost.spill`). */
export type SpillRead =
  /** The file's bytes, as base64: the bytes themselves are let go before it is returned. */
  | { readonly kind: "base64"; readonly base64: string }
  /** Not a Result Spill's path, or no such file: cleanup removed it, or it was never written. */
  | { readonly kind: "missing" }
  | { readonly kind: "too_large" }
  /** The decode slot was not given: the previews ahead took too long (`waited`), or the preview was closed (`aborted`). */
  | { readonly kind: "waited" | "aborted" };

/** Takes the decode slot for a read over `PREVIEW_SLOT_OVER`, held until the answer is sent; asked again, it is the same turn. */
export type HoldSlot = Effect.Effect<"held" | "aborted" | "waited">;

/** A preview's read, as its socket sent it. */
export type ResourceRead = {
  readonly socket: WebSocket;
  /** Whether the socket has said its page is visible. */
  readonly visible: boolean;
  readonly conversation: string;
  readonly server: string;
  readonly uri: string;
  /** The path of the Result Spill the card's chip names, as the client sent it: read only if it is a spill's. */
  readonly path?: string | undefined;
  /** The Workspace (`ws:<id>`) the conversation works in, asked for only by a stdio server's read. */
  readonly workspaceOf: (conversation: string) => Effect.Effect<string | undefined>;
  /** What the Workspace holds at a spill's path, for `conversation`; `hold` takes the decode slot once it knows the file is large. */
  readonly spill: (
    conversation: string,
    path: string,
    hold: (bytes: number) => HoldSlot,
  ) => Effect.Effect<SpillRead>;
};

export type ResourcePreviewsOptions = {
  /** The read, once the Session's own checks pass: the MCP tools' `resourcePreview`. */
  readonly read: (input: McpResourcePreviewInput) => Effect.Effect<McpResourcePreviewAnswer>;
  /** The time in epoch milliseconds, `Date.now` unless a test sets it. */
  readonly now?: () => number;
};

export type ResourcePreviewsService = {
  /**
   * One preview: its answer, however it ends. Never fails. The decode slot it took, if it took one, is held until the
   * caller's scope closes, which is when the answer has been sent.
   */
  readonly resourcePreview: (
    input: ResourceRead,
  ) => Effect.Effect<McpResourcePreviewAnswer, never, Scope.Scope>;
  /** The socket went: every read it has in flight is aborted. */
  readonly endResourcePreviews: (socket: WebSocket) => Effect.Effect<void>;
};

export class McpResourcePreviews extends Context.Service<
  McpResourcePreviews,
  ResourcePreviewsService
>()("@cloudpid/server/session/mcp-resource-previews/McpResourcePreviews") {}

const waitedFor = resourceUnavailable(
  "failed",
  "Other large previews were being read: try the preview again in a moment",
);

const tooLarge = resourceUnavailable(
  "too_large",
  `The resource is over ${MAX_MCP_RESOURCE_PREVIEW_BYTES / 1024 / 1024} MiB, more than a preview carries`,
);

/** Ends when `signal` aborts, with the cancelled answer; never otherwise. */
const aborted = (signal: AbortSignal): Effect.Effect<McpResourcePreviewAnswer> =>
  Effect.callback<McpResourcePreviewAnswer>((resume) => {
    const done = () =>
      resume(Effect.succeed(resourceUnavailable("cancelled", "The read was cancelled")));

    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", done));
  });

export const resourcePreviewsOver = (options: ResourcePreviewsOptions): ResourcePreviewsService => {
  const sockets = socketRequests(options.now ?? Date.now);
  // Names a read among its socket's in flight.
  let reads = 0;

  /** The answer for the spill's file, none when the file is gone and the resource is read by its URI. */
  const fromSpill = (input: ResourceRead, path: string, hold: (bytes: number) => HoldSlot) =>
    input.spill(input.conversation, path, hold).pipe(
      Effect.map((file): McpResourcePreviewAnswer | undefined => {
        switch (file.kind) {
          case "missing":
            return undefined;
          case "too_large":
            return tooLarge;
          case "aborted":
            return resourceUnavailable("cancelled", "The read was cancelled");
          case "waited":
            return waitedFor;
          case "base64":
            return { status: "contents", contents: [{ uri: input.uri, blob: file.base64 }] };
        }
      }),
    );

  const resourcePreview: ResourcePreviewsService["resourcePreview"] = (input) =>
    Effect.gen(function* () {
      if (!input.visible) {
        return resourceUnavailable(
          "hidden",
          "The page is hidden: a preview is read only while it is visible",
        );
      }

      const page = sockets.of(input.socket);

      if (!page.admits("read", MAX_MCP_RESOURCE_PER_MINUTE)) {
        return resourceUnavailable(
          "limit",
          `At most ${MAX_MCP_RESOURCE_PER_MINUTE} previews a minute`,
        );
      }

      if (page.inFlight() >= MAX_MCP_RESOURCE_IN_FLIGHT) {
        return resourceUnavailable(
          "limit",
          `At most ${MAX_MCP_RESOURCE_IN_FLIGHT} previews are read at once`,
        );
      }

      reads += 1;

      const id = `${reads}`;
      const stop = page.start(id);

      // The decode slot, taken once for the preview and held until the caller's scope closes: when the answer has been sent.
      const scope = yield* Effect.scope;
      let release: (() => void) | undefined;
      let closed = false;

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          closed = true;
          release?.();
        }),
      );

      const holdSlot: HoldSlot = Effect.suspend(() => {
        // Asked again (the spill's read fell back to the resource's, which is read as large): the preview's own turn is
        // still its own, and waiting for it would wait for itself.
        if (release !== undefined) return Effect.succeed("held" as const);

        // `interrupted` aborts when what waits is given up on (the page closed, or the preview is no longer wanted), and
        // a slot given at that moment goes straight back to the line.
        return Effect.promise((interrupted) =>
          takeDecodeSlot(AbortSignal.any([stop.signal, interrupted]), MCP_STREAM_SLOT_WAIT_MS).then(
            (taken) => {
              if (taken.kind !== "held") return taken.kind;

              if (interrupted.aborted || closed) {
                taken.release();

                return "aborted" as const;
              }

              release = taken.release;

              return "held" as const;
            },
          ),
        );
      });

      const answer = yield* Effect.gen(function* () {
        const saved =
          input.path === undefined
            ? undefined
            : yield* fromSpill(input, input.path, () => holdSlot).pipe(
                // The owner closed it, or the socket went: what the Workspace was asked is not waited for.
                Effect.raceFirst(aborted(stop.signal)),
              );

        if (saved !== undefined) return saved;

        return yield* options.read({
          server: input.server,
          uri: input.uri,
          conversation: input.conversation,
          workspaceOf: Effect.suspend(() => input.workspaceOf(input.conversation)),
          signal: stop.signal,
          holdSlot,
        });
      }).pipe(Effect.ensuring(Effect.sync(() => page.finish(id))));

      yield* Effect.annotateCurrentSpan("mcp.resource_preview.status", answer.status);

      return answer;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A resource preview failed in the Session", cause).pipe(
          Effect.as<McpResourcePreviewAnswer>(
            resourceUnavailable("failed", "The Session could not read the resource"),
          ),
        ),
      ),
      Effect.withSpan("mcp.resource_preview", { attributes: { "mcp.server": input.server } }),
    );

  const endResourcePreviews: ResourcePreviewsService["endResourcePreviews"] = (socket) =>
    Effect.sync(() => sockets.end(socket));

  return { resourcePreview, endResourcePreviews };
};

/** The service over `options`, which the Session builds with its MCP tools' read. */
export const mcpResourcePreviewsLayer = (
  options: ResourcePreviewsOptions,
): Layer.Layer<McpResourcePreviews> =>
  Layer.succeed(McpResourcePreviews, resourcePreviewsOver(options));
