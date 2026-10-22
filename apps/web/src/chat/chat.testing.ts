// An atom registry for the chat's atoms: the app's runtime over a fake socket (`FakeSocket`), fake uploads and a fake
// image encoder, each driven by the test.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- in-memory fakes recording what they were asked in native arrays, and plain test helpers.

import type { StoredAttachment } from "@cloudpid/protocol";
import * as Clipboard from "@effect/platform-browser/Clipboard";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Socket from "effect/socket/Socket";
import { PushManagerLive } from "../push.ts";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { appRuntime } from "../runtime.ts";
import { SessionProbe } from "../session/client.ts";
import { FakeSocket, settle } from "../session/client.testing.ts";
import { ImageEncoder, ImageError } from "./image-encode.ts";
import { UploadError, Uploads } from "./uploads.ts";

/** One upload the composer started, which the test finishes, fails or watches being stopped. */
export interface FakeUpload {
  readonly sessionId: string;
  readonly name: string;
  /** Report the share of it sent, as the browser does. */
  readonly progress: (fraction: number) => Effect.Effect<void>;
  /** The Machine stored it, under its own name or `stored`'s. */
  readonly finish: (stored?: StoredAttachment) => Effect.Effect<void>;
  /** `finish`, without letting the composer hear of it yet. */
  readonly complete: Effect.Effect<void>;
  readonly fail: (message: string) => Effect.Effect<void>;
  /** Whether the composer stopped it. */
  interrupted: boolean;
}

/** Uploads that wait for the test, and the removals asked for, as `sessionId/name`. */
export const fakeUploads = () => {
  const started: FakeUpload[] = [];
  const removed: string[] = [];

  const layer = Layer.succeed(Uploads)({
    upload: (sessionId, name, _file, onProgress) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<StoredAttachment, UploadError>();

        const upload: FakeUpload = {
          sessionId,
          name,
          progress: (fraction) =>
            Effect.sync(() => {
              onProgress(fraction);
            }).pipe(Effect.andThen(settle)),
          finish: (stored = { name, path: `/workspace/.uploads/${sessionId}/${name}` }) =>
            Deferred.succeed(answer, stored).pipe(Effect.andThen(settle)),
          complete: Deferred.succeed(answer, {
            name,
            path: `/workspace/.uploads/${sessionId}/${name}`,
          }).pipe(Effect.asVoid),
          fail: (message) =>
            Deferred.fail(answer, UploadError.make({ message })).pipe(Effect.andThen(settle)),
          interrupted: false,
        };

        started.push(upload);

        return yield* Deferred.await(answer).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              upload.interrupted = true;
            }),
          ),
        );
      }),
    remove: (sessionId, name) =>
      Effect.sync(() => {
        removed.push(`${sessionId}/${name}`);
      }),
  });

  return { started, removed, layer };
};

/**
 * An encoder that reads every picture but one whose name starts with `unreadable`, and encodes one to its size × the
 * quality in characters; what it released, by file name.
 */
export const fakeImages = () => {
  const released: string[] = [];

  const layer = Layer.succeed(ImageEncoder)({
    probe: (file) =>
      file.name.startsWith("unreadable")
        ? Effect.fail(ImageError.make({ message: "Cannot decode" }))
        : Effect.void,
    encode: (file, quality) =>
      Effect.succeed({
        mimeType: "image/jpeg",
        data: "A".repeat(Math.round(file.size * quality)),
      }),
    release: (file) =>
      Effect.sync(() => {
        released.push(file.name);
      }),
  });

  return { released, layer };
};

/** An atom registry whose runtime dials fake sockets (recorded in `sockets`) and uploads through `uploads`. */
export const chatRegistry = (
  uploads: Layer.Layer<Uploads> = fakeUploads().layer,
  images: Layer.Layer<ImageEncoder> = fakeImages().layer,
) => {
  const sockets: FakeSocket[] = [];

  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        appRuntime.layer,
        Layer.mergeAll(
          Layer.succeed(Socket.WebSocketConstructor)((url) => {
            const socket = new FakeSocket(url);

            sockets.push(socket);

            return socket;
          }),
          Layer.succeed(SessionProbe)(() => Effect.succeed("reachable")),
          Clipboard.layer,
          PushManagerLive,
          uploads,
          images,
          fakeRegistryLayer({}),
        ),
      ),
    ],
  });

  return {
    registry,
    sockets,
    latest: (): FakeSocket => {
      const socket = sockets.at(-1);

      if (socket === undefined) throw new Error("No socket was dialled");

      return socket;
    },
  };
};

/** Greet and answer the root's watch, as a Session does. */
export const live = (socket: FakeSocket) =>
  Effect.gen(function* () {
    yield* socket.open();
    yield* socket.say({ type: "hello", root: 1 });

    const watch = socket.commands().find((command) => command.type === "watch");

    yield* socket.say({ type: "result", id: watch?.id, result: null });
    yield* socket.say({
      type: "events",
      conversationId: 1,
      events: [
        {
          type: "snapshot",
          entries: [],
          tools: [],
          nestedTools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: {},
        },
      ],
    });
  });

/** The commands of `type` the client sent on `socket`. */
export const sent = (socket: FakeSocket, type: string) =>
  socket.commands().filter((command) => command.type === type);
