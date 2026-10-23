// A conversation's Attachments in its composer (`docs/spec.md` → Client and protocol → Attachments): each file uploads
// once it is attached, one at a time in the order they came, with its progress; removing one before it is sent stops
// its upload or deletes the stored file; and the pictures among them are fitted, while the owner writes, into what one
// message may hold (`image-budget.ts`), so each tile says before sending whether its image goes inline. Kept while a
// composer of the conversation reads them: when it goes, the uploads in progress stop, and what was stored stays. The
// draft of a new Session has Attachments of its own, which upload once Send has made the Session.

// @effect-diagnostics preferEffectArray:off -- the bookkeeping of one composer's uploads: native arrays and sets mutated in place, one synchronous step at a time.

import { MAX_ATTACHMENT_BYTES, type StoredAttachment, type WhenBusy } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { messageOf } from "../registry.ts";
import { replying } from "../calls.ts";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import {
  formatSize,
  isPictureType,
  outgoingMessage,
  requestedName,
  type SentAttachment,
} from "./attachments.ts";
import type { ConversationKey } from "./conversation.ts";
import { type Fit, fitImages, UNPREPARED } from "./image-budget.ts";
import { ImageEncoder } from "./image-encode.ts";
import { type UploadError, Uploads } from "./uploads.ts";

/**
 * `queued` until its upload starts (it waits for the one before it, or, in the draft, for the Session to be made), then
 * `uploading`, and `uploaded` or `failed`.
 */
export type AttachmentStatus = "queued" | "uploading" | "uploaded" | "failed";

/** One file attached to the message being written. */
export interface AttachmentItem {
  readonly id: string;
  readonly file: File;
  /** The name it is uploaded under, apart from the composer's other Attachments. */
  readonly name: string;
  /** Whether it is a picture the model may see inline. */
  readonly picture: boolean;
  /** A link to the file, for a picture's thumbnail. */
  readonly preview: string | undefined;
  readonly status: AttachmentStatus;
  /** The share of it uploaded, 0–1. */
  readonly progress: number;
  /** Where the Workspace stored it, once uploaded. */
  readonly stored: StoredAttachment | undefined;
  /** Why it did not upload. */
  readonly error: string | undefined;
}

/** What the composer shows of its Attachments. */
export interface AttachmentsState {
  readonly items: readonly AttachmentItem[];
  /** How each picture goes, by its ID: inline, or as a file only and why. Absent while it is being prepared. */
  readonly fits: ReadonlyMap<string, Fit>;
  /** The pictures `fits` was made for (`picturesOf`): a set that changed since is being fitted again. */
  readonly fitted: string;
}

const EMPTY: AttachmentsState = { items: [], fits: new Map(), fitted: "" };

/** The pictures among `items`, as one key that changes when the set does. */
const picturesOf = (items: readonly AttachmentItem[]): string =>
  items.flatMap((item) => (item.picture ? [item.id] : [])).join(",");

/**
 * Why the message cannot be sent with its Attachments yet, or null once every one is uploaded and every picture
 * fitted.
 */
export const waitingFor = (state: AttachmentsState): string | null => {
  if (anyFailed(state)) return "Remove the attachments that did not upload, then send.";

  if (anyUnsettled(state)) return "Waiting for the attachments to upload.";

  return fittedAll(state) ? null : "Preparing the images for the model.";
};

/** Whether one Attachment did not upload, or cannot. */
const anyFailed = (state: AttachmentsState): boolean =>
  state.items.some((item) => item.status === "failed");

/** Whether an upload has not ended: one waits for its turn or goes on. */
const anyUnsettled = (state: AttachmentsState): boolean =>
  state.items.some((item) => item.status === "queued" || item.status === "uploading");

/** Whether every picture has been fitted: none is being prepared for the model. */
const fittedAll = (state: AttachmentsState): boolean => state.fitted === picturesOf(state.items);

/**
 * Why the draft cannot be sent with its Attachments yet, or null. The draft uploads them once the Session is made, so
 * only one that cannot upload, or a picture still being prepared, holds it.
 */
export const draftWaitingFor = (state: AttachmentsState): string | null => {
  if (anyFailed(state)) return "Remove the attachments that cannot be sent, then send.";

  return fittedAll(state) ? null : "Preparing the images for the model.";
};

/** Whether every upload has ended, and every picture is fitted unless one failed: nothing more will change. */
const uploadsSettled = (state: AttachmentsState): boolean =>
  !anyUnsettled(state) && (fittedAll(state) || anyFailed(state));

/** The Attachments as the message sends them; undefined while `waitingFor` says why not. */
export const sentAttachments = (state: AttachmentsState): readonly SentAttachment[] | undefined => {
  if (waitingFor(state) !== null) return undefined;

  const message: SentAttachment[] = [];

  for (const item of state.items) {
    if (item.stored === undefined) return undefined;

    const fit = state.fits.get(item.id);

    message.push({
      name: item.stored.name,
      path: item.stored.path,
      inline: fit?.kind === "inline" ? fit.encoded : undefined,
    });
  }

  return message;
};

/** Attachments taken off the composer while their message is submitted. */
export interface Held {
  /** The Session refused the message: put them back, before any attached since. */
  readonly restore: Effect.Effect<void>;
  /** The Session took it: forget them (their files stay in the Workspace). */
  readonly release: Effect.Effect<void>;
}

/** One conversation's Attachments, as long as the scope is open. */
export interface Attachments {
  readonly state: SubscriptionRef.SubscriptionRef<AttachmentsState>;
  readonly add: (files: Iterable<File>) => Effect.Effect<void>;
  /** Take one off the message: its upload is stopped, or its stored file deleted. */
  readonly remove: (id: string) => Effect.Effect<void>;
  /** Take them all off the composer while their message is submitted; their names stay taken until released. */
  readonly hold: Effect.Effect<Held>;
}

const UNREADABLE = "This browser cannot read it; it goes as a file only.";

const TOO_BIG = "Too big to attach.";

const TOO_BIG_TO_UPLOAD = `An attachment is at most ${formatSize(MAX_ATTACHMENT_BYTES)}.`;

/**
 * The Attachments of a composer writing to the Session `sessionId` gives, as long as the scope is open. Each upload
 * waits for it, so the draft, whose Session is not made yet, attaches files that upload once it is. Closing the scope
 * stops the upload in progress and lets go of what the page kept of each file; what was stored stays, as a sent file
 * does.
 */
export const makeAttachments = Effect.fnUntraced(function* (sessionId: Effect.Effect<string>) {
  const uploads = yield* Uploads;
  const images = yield* ImageEncoder;
  const state = yield* SubscriptionRef.make(EMPTY);
  const waiting = yield* Queue.unbounded<AttachmentItem>();
  const fitting = yield* FiberHandle.make();
  const background = yield* FiberSet.makeRuntime<never>();

  let current = EMPTY;
  let ids = 0;

  /** Attachments held off the composer while their message is submitted: their names are still taken. */
  const held = new Set<AttachmentItem>();

  /** The one upload under way. */
  let uploading: {
    readonly id: string;
    readonly fiber: Fiber.Fiber<StoredAttachment, UploadError>;
  } | null = null;

  /** The pictures being fitted, or last fitted. */
  let requested = "";

  /** Run `change` on the state, publish it, and fit the pictures again if their set changed. */
  const step = (change: (state: AttachmentsState) => AttachmentsState): Effect.Effect<void> =>
    Effect.suspend(() => {
      current = change(current);

      const pictures = picturesOf(current.items);

      return SubscriptionRef.set(state, current).pipe(
        Effect.andThen(pictures === requested ? Effect.void : fit(pictures)),
      );
    });

  const update = (id: string, change: Partial<AttachmentItem>) =>
    step((before) => ({
      ...before,
      items: before.items.map((item) => (item.id === id ? { ...item, ...change } : item)),
    }));

  /** Let go of what the page keeps of `item`: its thumbnail's link and its drawing for the model. */
  const forget = (item: AttachmentItem) =>
    Effect.sync(() => {
      if (item.preview !== undefined) URL.revokeObjectURL(item.preview);
    }).pipe(Effect.andThen(item.picture ? images.release(item.file) : Effect.void));

  /** How `item`'s picture goes when it cannot be fitted with the others. */
  const unfitted = (item: AttachmentItem): Effect.Effect<Fit | undefined> =>
    item.file.size > MAX_ATTACHMENT_BYTES
      ? Effect.succeed({ kind: "file", reason: TOO_BIG })
      : images.probe(item.file).pipe(
          Effect.as(undefined),
          Effect.orElseSucceed((): Fit => ({ kind: "file", reason: UNREADABLE })),
        );

  /** Fit the pictures of `pictures` again; a newer set interrupts this one. */
  function fit(pictures: string): Effect.Effect<void> {
    requested = pictures;

    const shown = current.items.filter((item) => item.picture);

    const fitted = Effect.gen(function* () {
      const fits = new Map<string, Fit>();
      const readable: AttachmentItem[] = [];

      for (const item of shown) {
        const known = yield* unfitted(item);

        if (known === undefined) readable.push(item);
        else fits.set(item.id, known);
      }

      const results = yield* fitImages(
        readable.map((item) => item.file),
        images.encode,
      );

      for (const [index, item] of readable.entries()) {
        fits.set(item.id, results[index] ?? { kind: "file", reason: UNPREPARED });
      }

      yield* step((before) => ({ ...before, fits, fitted: pictures }));
    });

    return FiberHandle.run(fitting, fitted).pipe(Effect.asVoid);
  }

  /** Upload `item`, unless it was removed while it waited, and note how it ended. */
  const upload = (item: AttachmentItem) =>
    Effect.gen(function* () {
      if (!current.items.some((candidate) => candidate.id === item.id)) return;

      const session = yield* sessionId;

      // Removed while it waited for the Session.
      if (!current.items.some((candidate) => candidate.id === item.id)) return;

      yield* update(item.id, { status: "uploading" });

      const fiber = yield* uploads
        .upload(session, item.name, item.file, (progress) => {
          background(update(item.id, { progress }));
        })
        .pipe(Effect.forkChild);

      uploading = { id: item.id, fiber };

      const exit = yield* Fiber.await(fiber);

      uploading = null;

      if (Exit.isSuccess(exit)) {
        yield* update(item.id, { status: "uploaded", progress: 1, stored: exit.value });
      } else if (!Cause.hasInterrupts(exit.cause)) {
        yield* update(item.id, { status: "failed", error: messageOf(exit.cause) });
      }
    });

  yield* Queue.take(waiting).pipe(Effect.flatMap(upload), Effect.forever, Effect.forkScoped);

  // Going away stops the upload in progress (above, with its fiber) and lets go of the page's copies.
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...current.items, ...held], forget, { discard: true }),
  );

  const add = (files: Iterable<File>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const taken = [...current.items, ...held].flatMap((item) =>
        item.stored === undefined ? [item.name] : [item.name, item.stored.name],
      );

      const added: AttachmentItem[] = [];

      for (const file of files) {
        const name = requestedName(file.name, taken);
        const picture = isPictureType(file.type);
        // One the Workspace would refuse fails at once, without waiting for its turn.
        const tooBig = file.size > MAX_ATTACHMENT_BYTES;

        ids += 1;
        taken.push(name);
        added.push({
          id: `attachment-${ids}`,
          file,
          name,
          picture,
          preview: picture ? URL.createObjectURL(file) : undefined,
          status: tooBig ? "failed" : "queued",
          progress: 0,
          stored: undefined,
          error: tooBig ? TOO_BIG_TO_UPLOAD : undefined,
        });
      }

      return step((before) => ({ ...before, items: [...before.items, ...added] })).pipe(
        Effect.andThen(
          Queue.offerAll(
            waiting,
            added.filter((item) => item.status === "queued"),
          ),
        ),
        Effect.asVoid,
      );
    });

  const remove = (id: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const item = current.items.find((candidate) => candidate.id === id);

      if (item === undefined) return Effect.void;

      const active = uploading?.id === id ? uploading.fiber : undefined;

      // A stored file was stored in the Session `sessionId` gave, so it gives it at once.
      const removeStored = (name: string) =>
        sessionId.pipe(Effect.flatMap((session) => uploads.remove(session, name)));

      // An upload that ended before the stop could reach it stored the file: it is deleted once its name is known.
      // The deletion goes on after the composer does.
      const deleted =
        active === undefined
          ? item.stored === undefined
            ? Effect.void
            : removeStored(item.stored.name)
          : Fiber.interrupt(active).pipe(
              Effect.andThen(Fiber.await(active)),
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit) ? removeStored(exit.value.name) : Effect.void,
              ),
            );

      return step((before) => ({
        ...before,
        items: before.items.filter((candidate) => candidate.id !== id),
      })).pipe(
        Effect.andThen(forget(item)),
        Effect.andThen(Effect.forkDetach(deleted)),
        Effect.asVoid,
      );
    });

  const hold = Effect.suspend(() => {
    const taken = current.items;

    for (const item of taken) held.add(item);

    const unhold = Effect.sync(() => {
      for (const item of taken) held.delete(item);
    });

    return step((before) => ({ ...before, items: [] })).pipe(
      Effect.as<Held>({
        restore: unhold.pipe(
          Effect.andThen(step((before) => ({ ...before, items: [...taken, ...before.items] }))),
        ),
        release: unhold.pipe(Effect.andThen(Effect.forEach(taken, forget, { discard: true }))),
      }),
    );
  });

  return { state, add, remove, hold } satisfies Attachments;
});

/** The conversation's Attachments, while a composer of it reads them. */
const attachmentsProgramAtom = Atom.family((key: ConversationKey) =>
  appRuntime.atom(makeAttachments(Effect.succeed(key.sessionId))),
);

const attachmentsRefAtom = Atom.family((key: ConversationKey) =>
  appRuntime.subscriptionRef((get) =>
    get.result(attachmentsProgramAtom(key)).pipe(Effect.map((attachments) => attachments.state)),
  ),
);

/** The conversation's Attachments as its composer shows them. */
export const attachmentsAtom = Atom.family((key: ConversationKey) =>
  Atom.map(attachmentsRefAtom(key), (result) => AsyncResult.getOrElse(result, () => EMPTY)),
);

/** Attach `files` to the conversation's message: each uploads in turn. */
export const addAttachmentsAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn(
    (files: readonly File[], get) =>
      get
        .result(attachmentsProgramAtom(key))
        .pipe(Effect.flatMap((attachments) => attachments.add(files))),
    { concurrent: true },
  ),
);

/** Take an Attachment off the conversation's message, by its ID. */
export const removeAttachmentAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn(
    (id: string, get) =>
      get
        .result(attachmentsProgramAtom(key))
        .pipe(Effect.flatMap((attachments) => attachments.remove(id))),
    { concurrent: true },
  ),
);

/** Why a message with Attachments was not sent: they were not ready, or the Session refused it. */
export class SendError extends Schema.TaggedError<SendError, { readonly brand: unique symbol }>()(
  "SendError",
  { message: Schema.String },
) {}

/** A message with Attachments: what was typed, and how it goes while a Run is in progress. */
export interface AttachedMessage {
  readonly typed: string;
  readonly whenBusy: WhenBusy;
}

/**
 * Send what was typed with the conversation's Attachments, once every one is uploaded and every picture fitted. They
 * leave the composer while the Session answers, and come back when it refuses the message, failing with why: the
 * composer then puts the text back too.
 */
export const sendAttachedAtom = Atom.family((key: ConversationKey) =>
  appRuntime.fn(
    replying(({ typed, whenBusy }: AttachedMessage, get: Atom.FnContext) =>
      Effect.gen(function* () {
        const attachments = yield* get.result(attachmentsProgramAtom(key));
        const client = yield* get.result(sessionClientAtom(key.sessionId));
        const ready = yield* SubscriptionRef.get(attachments.state);
        const sent = sentAttachments(ready);

        if (sent === undefined) {
          return yield* SendError.make({
            message: waitingFor(ready) ?? "The attachments are not ready.",
          });
        }

        const held = yield* attachments.hold;

        yield* client
          .submitAndAwait(outgoingMessage(typed, sent), whenBusy, key.conversationId)
          .pipe(
            Effect.tapError(() => held.restore),
            Effect.mapError((error) => SendError.make({ message: error.message })),
          );

        yield* held.release;
      }),
    ),
    { concurrent: true },
  ),
);

/**
 * The draft's Attachments: they are fitted as they are added, as a Session's composer's are, but upload only once
 * `uploadTo` names the Session the draft made. Kept alive, so a send goes on when the page is left; a sent draft
 * starts a new set (`sendDraftAtom` refreshes it).
 */
export const draftAttachmentsProgramAtom = appRuntime
  .atom(
    Effect.gen(function* () {
      const session = yield* Deferred.make<string>();
      const made = Deferred.await(session);
      const attachments = yield* makeAttachments(made);

      /**
       * Upload them to Session `sessionId`, one at a time, and give how they ended once every upload has. When one did
       * not upload, the files that did are deleted, since their message is not sent: the Session's composer attaches
       * them all again.
       */
      const uploadTo = (sessionId: string): Effect.Effect<AttachmentsState> =>
        Deferred.succeed(session, sessionId).pipe(
          Effect.andThen(
            SubscriptionRef.changes(attachments.state).pipe(
              Stream.filter(uploadsSettled),
              Stream.runHead,
            ),
          ),
          // The state ends only with the scope, which interrupts this first.
          Effect.flatMap(Option.match({ onNone: () => Effect.interrupt, onSome: Effect.succeed })),
          Effect.tap((settled) =>
            anyFailed(settled)
              ? Effect.forEach(
                  settled.items.filter((item) => item.status === "uploaded"),
                  (item) => attachments.remove(item.id),
                  { discard: true },
                )
              : Effect.void,
          ),
        );

      return { ...attachments, uploadTo };
    }),
  )
  .pipe(Atom.keepAlive);

const draftAttachmentsRefAtom = appRuntime.subscriptionRef((get) =>
  get.result(draftAttachmentsProgramAtom).pipe(Effect.map((attachments) => attachments.state)),
);

/** The draft's Attachments, as its tiles show them. */
export const draftAttachmentsAtom = Atom.map(draftAttachmentsRefAtom, (result) =>
  AsyncResult.getOrElse(result, () => EMPTY),
);

/** Attach `files` to the draft. */
export const addDraftAttachmentsAtom = appRuntime.fn(
  (files: readonly File[], get) =>
    get
      .result(draftAttachmentsProgramAtom)
      .pipe(Effect.flatMap((attachments) => attachments.add(files))),
  { concurrent: true },
);

/** Take an Attachment off the draft, by its ID. */
export const removeDraftAttachmentAtom = appRuntime.fn(
  (id: string, get) =>
    get
      .result(draftAttachmentsProgramAtom)
      .pipe(Effect.flatMap((attachments) => attachments.remove(id))),
  { concurrent: true },
);
