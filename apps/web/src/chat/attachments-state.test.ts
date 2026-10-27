// @effect-diagnostics preferEffectArray:off -- assertions over what the fakes recorded, in native arrays.

import { MAX_ATTACHMENT_BYTES } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterEach, beforeEach, vi } from "vitest";
import { callOf } from "../calls.ts";
import { exitFailure } from "../registry.ts";
import { settled } from "../registry.testing.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import {
  addAttachmentsAtom,
  addPageAtom,
  attachmentsAtom,
  type PageToAttach,
  removeAttachmentAtom,
  removePageAtom,
  screenNote,
  sendAttachedAtom,
  sentAttachments,
  sentPages,
  waitingFor,
} from "./attachments-state.ts";
import { chatRegistry, fakeImages, fakeUploads, live, sent } from "./chat.testing.ts";
import { conversationKey } from "./conversation.ts";

const ROOT = conversationKey("s1", undefined);

const file = (name: string, size = 10, type = "text/plain") =>
  new File(["x".repeat(size)], name, { type });

/** A live Session whose root composer holds Attachments. */
const setup = Effect.gen(function* () {
  const uploads = fakeUploads();
  const images = fakeImages();
  const chat = chatRegistry(uploads.layer, images.layer);

  chat.registry.mount(sessionStatusAtom("s1"));

  // What the composer reads, and lets go of when it goes.
  const unmounts = [
    chat.registry.mount(attachmentsAtom(ROOT)),
    chat.registry.mount(addAttachmentsAtom(ROOT)),
    chat.registry.mount(removeAttachmentAtom(ROOT)),
    chat.registry.mount(sendAttachedAtom(ROOT)),
    chat.registry.mount(addPageAtom(ROOT)),
    chat.registry.mount(removePageAtom(ROOT)),
  ];

  const leave = Effect.sync(() => {
    for (const unmount of unmounts) unmount();
  }).pipe(Effect.andThen(settle));

  yield* settle;
  yield* live(chat.latest());

  const add = (...files: File[]) =>
    Effect.sync(() => {
      chat.registry.set(addAttachmentsAtom(ROOT), files);
    }).pipe(Effect.andThen(settle));

  const remove = (name: string) =>
    Effect.sync(() => {
      const item = chat.registry.get(attachmentsAtom(ROOT)).items.find((a) => a.name === name);

      chat.registry.set(removeAttachmentAtom(ROOT), item?.id ?? "");
    }).pipe(Effect.andThen(settle));

  const attachPage = (page: PageToAttach) =>
    Effect.sync(() => {
      chat.registry.set(addPageAtom(ROOT), page);
    }).pipe(Effect.andThen(settle));

  const detachPage = (ownerTabId: string) =>
    Effect.sync(() => {
      chat.registry.set(removePageAtom(ROOT), ownerTabId);
    }).pipe(Effect.andThen(settle));

  const state = () => chat.registry.get(attachmentsAtom(ROOT));

  const summary = () => state().items.map((item) => `${item.name} ${item.status}`);

  return { ...chat, uploads, images, leave, add, remove, attachPage, detachPage, state, summary };
});

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a composer's Attachments", () => {
  it.effect("upload one at a time, in the order they came, each named apart", () =>
    Effect.gen(function* () {
      const { uploads, add, state, summary } = yield* setup;

      yield* add(file("notes.txt"), file("notes.txt"), file("plan.md"));

      expect(summary()).toEqual(["notes.txt uploading", "notes-2.txt queued", "plan.md queued"]);
      expect(uploads.started.map((upload) => upload.name)).toEqual(["notes.txt"]);

      yield* uploads.started[0]!.progress(0.5);

      expect(state().items[0]?.progress).toBe(0.5);

      yield* uploads.started[0]!.finish();

      expect(uploads.started.map((upload) => upload.name)).toEqual(["notes.txt", "notes-2.txt"]);
      expect(state().items[0]).toMatchObject({
        status: "uploaded",
        progress: 1,
        stored: { name: "notes.txt", path: "/workspace/.cloudpid/uploads/s1/notes.txt" },
      });

      yield* uploads.started[1]!.fail("The upload failed (500).");
      yield* uploads.started[2]!.finish();

      expect(summary()).toEqual(["notes.txt uploaded", "notes-2.txt failed", "plan.md uploaded"]);
      expect(state().items[1]?.error).toBe("The upload failed (500).");
    }),
  );

  it.effect("fail one too big for the Workspace at once, without uploading it", () =>
    Effect.gen(function* () {
      const { uploads, add, state, summary } = yield* setup;
      const big = file("big.bin");

      Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_BYTES + 1 });

      yield* add(big, file("a.txt"));

      expect(summary()).toEqual(["big.bin failed", "a.txt uploading"]);
      expect(state().items[0]?.error).toBe("An attachment is at most 25 MB.");
      expect(uploads.started.map((upload) => upload.name)).toEqual(["a.txt"]);
    }),
  );

  it.effect("hold Send until every upload is done, and a failed one is removed", () =>
    Effect.gen(function* () {
      const { uploads, add, remove, state } = yield* setup;

      yield* add(file("a.txt"), file("b.txt"));

      expect(waitingFor(state())).toBe("Waiting for the attachments to upload.");
      expect(sentAttachments(state())).toBeUndefined();

      yield* uploads.started[0]!.finish();
      yield* uploads.started[1]!.fail("Nope");

      expect(waitingFor(state())).toBe("Remove the attachments that did not upload, then send.");

      yield* remove("b.txt");

      expect(waitingFor(state())).toBeNull();
      expect(sentAttachments(state())).toEqual([
        { name: "a.txt", path: "/workspace/.cloudpid/uploads/s1/a.txt", inline: undefined },
      ]);
    }),
  );

  it.effect(
    "stop the upload of one removed while it uploads, and skip one removed while it waits",
    () =>
      Effect.gen(function* () {
        const { uploads, add, remove, summary } = yield* setup;

        yield* add(file("a.txt"), file("b.txt"), file("c.txt"));
        yield* remove("b.txt");
        yield* remove("a.txt");

        expect(uploads.started[0]?.interrupted).toBe(true);
        expect(uploads.started.map((upload) => upload.name)).toEqual(["a.txt", "c.txt"]);
        expect(summary()).toEqual(["c.txt uploading"]);
        // Stopped before it was stored: nothing to delete.
        expect(uploads.removed).toEqual([]);
      }),
  );

  it.effect(
    "delete the stored file of one removed, also when its upload ended as it was removed",
    () =>
      Effect.gen(function* () {
        const { uploads, add, remove } = yield* setup;

        yield* add(file("a.txt"), file("b.txt"));
        yield* uploads.started[0]!.finish({
          name: "a-2.txt",
          path: "/workspace/.cloudpid/uploads/s1/a-2.txt",
        });
        yield* remove("a.txt");

        expect(uploads.removed).toEqual(["s1/a-2.txt"]);

        // The upload ends, and the owner removes it before the page heard.
        yield* uploads.started[1]!.complete;
        yield* remove("b.txt");

        expect(uploads.removed).toEqual(["s1/a-2.txt", "s1/b.txt"]);
      }),
  );

  it.effect(
    "send with the text, put back with it when the Session refuses, and let go once taken",
    () =>
      Effect.gen(function* () {
        const { registry, latest, uploads, add, summary } = yield* setup;

        yield* add(file("a.txt"));
        yield* uploads.started[0]!.finish();

        registry.set(sendAttachedAtom(ROOT), callOf({ typed: "look", whenBusy: "followUp" }));
        yield* settle;

        // Off the composer while the Session answers.
        expect(summary()).toEqual([]);

        const [submit] = sent(latest(), "submit");

        expect(submit).toMatchObject({
          input: [
            { type: "text", text: "look" },
            { type: "text", text: "@/workspace/.cloudpid/uploads/s1/a.txt" },
          ],
          whenBusy: "followUp",
        });

        yield* latest().say({ type: "error", id: submit?.id, message: "Too big" });

        expect(
          exitFailure(AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)))),
        ).toBe("Too big");
        expect(summary()).toEqual(["a.txt uploaded"]);

        registry.set(sendAttachedAtom(ROOT), callOf({ typed: "look again", whenBusy: "followUp" }));
        yield* settle;

        const again = sent(latest(), "submit").at(-1);

        yield* latest().say({ type: "result", id: again?.id, result: { submissionId: "sub-1" } });

        expect(
          Exit.isSuccess(AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)))),
        ).toBe(true);
        expect(summary()).toEqual([]);
      }),
  );

  it.effect("fit the pictures before sending, saying why one goes as a file only", () =>
    Effect.gen(function* () {
      const { uploads, images, add, remove, state } = yield* setup;

      yield* add(file("cat.jpg", 100, "image/jpeg"), file("unreadable.heic", 100, "image/heic"));
      yield* uploads.started[0]!.finish();
      yield* uploads.started[1]!.finish();

      expect(waitingFor(state())).toBeNull();

      const [cat, heic] = state().items;

      expect(state().fits.get(cat?.id ?? "")).toMatchObject({ kind: "inline" });
      expect(state().fits.get(heic?.id ?? "")).toEqual({
        kind: "file",
        reason: "This browser cannot read it; it goes as a file only.",
      });
      expect(sentAttachments(state())?.[0]?.inline?.mimeType).toBe("image/jpeg");

      yield* remove("cat.jpg");

      expect(images.released).toEqual(["cat.jpg"]);
    }),
  );

  it.effect("stop the uploads in progress when the composer goes, and keep what was stored", () =>
    Effect.gen(function* () {
      const { uploads, images, add, leave } = yield* setup;

      yield* add(file("a.txt"), file("cat.jpg", 10, "image/jpeg"));
      yield* uploads.started[0]!.finish();

      yield* leave;

      expect(uploads.started[1]?.interrupted).toBe(true);
      expect(uploads.removed).toEqual([]);
      expect(images.released).toEqual(["cat.jpg"]);
    }),
  );
});

const SHOWN: PageToAttach = {
  ownerTabId: "tab-1",
  title: "Guide",
  shown: true,
};

const OTHER: PageToAttach = {
  ownerTabId: "tab-2",
  title: "Other",
  shown: false,
};

/** The Pane's frame as a picture: a JPEG of `size` bytes. */
const screen = (size = 1000) => file("screen.jpg", size, "image/jpeg");

describe("a composer's attached pages", () => {
  it.effect(
    "carry the shown page's screen through the image budget, and the page that is not shown only its tab",
    () =>
      Effect.gen(function* () {
        const { registry, latest, attachPage, state } = yield* setup;

        yield* attachPage({ ...SHOWN, screen: screen() });
        yield* attachPage(OTHER);

        expect(state().pages.map((chip) => chip.ownerTabId)).toEqual(["tab-1", "tab-2"]);
        // The screen is a picture to fit, never an upload.
        expect(state().items.map((item) => [item.name, item.screenOf, item.status])).toEqual([
          ["screen", "tab-1", "uploaded"],
        ]);
        expect(state().fits.get(state().items[0]?.id ?? "")).toMatchObject({ kind: "inline" });
        expect(waitingFor(state())).toBeNull();
        expect(sentAttachments(state())).toEqual([]);

        expect(sentPages(state())).toEqual([
          {
            ref: { ownerTabId: "tab-1", screen: true },
            title: "Guide",
            screen: { mimeType: "image/jpeg", data: "A".repeat(850) },
          },
          { ref: { ownerTabId: "tab-2" }, title: "Other", screen: undefined },
        ]);

        registry.set(
          sendAttachedAtom(ROOT),
          callOf({ typed: "what is this?", whenBusy: "followUp" }),
        );
        yield* settle;

        const [submit] = sent(latest(), "submit");

        // The pages go as references the Session reads; only the screen is in the input, after the typed text.
        expect(submit).toMatchObject({
          input: [
            { type: "text", text: "what is this?" },
            { type: "image", mimeType: "image/jpeg", data: "A".repeat(850) },
          ],
          pages: [{ ownerTabId: "tab-1", screen: true }, { ownerTabId: "tab-2" }],
        });
      }),
  );

  it.effect(
    "share the image budget with attached pictures: the largest goes as a file to make room",
    () =>
      Effect.gen(function* () {
        const { uploads, add, attachPage, state } = yield* setup;

        // Together they are over what one message may hold, even at the lowest quality: the largest goes as a file.
        yield* add(file("big.jpg", 5_000_000, "image/jpeg"));
        yield* uploads.started[0]!.finish();
        yield* attachPage({ ...SHOWN, screen: screen(3_000_000) });

        const [big, shownScreen] = state().items;

        expect(state().fits.get(big?.id ?? "")).toMatchObject({ kind: "file" });
        expect(state().fits.get(shownScreen?.id ?? "")).toMatchObject({ kind: "inline" });
        expect(sentPages(state())[0]?.ref).toEqual({ ownerTabId: "tab-1", screen: true });
      }),
  );

  it.effect("say when a screen is left out, still sending the page", () =>
    Effect.gen(function* () {
      const { attachPage, state } = yield* setup;

      yield* attachPage({ ...SHOWN, screen: screen(9_000_000) });

      const chip = state().pages[0];

      expect(chip && screenNote(state(), chip)).toMatch(/no room/);
      expect(sentPages(state())).toEqual([
        { ref: { ownerTabId: "tab-1" }, title: "Guide", screen: undefined },
      ]);
    }),
  );

  it.effect("attach a page once, and take it off with its screen", () =>
    Effect.gen(function* () {
      const { images, attachPage, detachPage, state } = yield* setup;

      yield* attachPage({ ...SHOWN, screen: screen() });
      yield* attachPage({ ...SHOWN, screen: screen() });
      yield* attachPage(OTHER);

      expect(state().pages).toHaveLength(2);
      expect(state().items).toHaveLength(1);

      yield* detachPage("tab-1");

      expect(state().pages.map((chip) => chip.ownerTabId)).toEqual(["tab-2"]);
      expect(state().items).toEqual([]);
      expect(images.released).toEqual(["screen.jpg"]);
      expect(sentPages(state())).toHaveLength(1);
    }),
  );

  it.effect("make a message alone, and come back with the text when the Session refuses it", () =>
    Effect.gen(function* () {
      const { registry, latest, attachPage, state } = yield* setup;

      yield* attachPage({ ...SHOWN, screen: screen() });

      registry.set(sendAttachedAtom(ROOT), callOf({ typed: "", whenBusy: "followUp" }));
      yield* settle;

      const [submit] = sent(latest(), "submit");

      expect(submit).toMatchObject({
        input: [{ type: "image", mimeType: "image/jpeg" }],
        pages: [{ ownerTabId: "tab-1", screen: true }],
      });
      // Off the composer while the Session answers.
      expect(state().pages).toEqual([]);

      yield* latest().say({
        type: "error",
        id: submit?.id,
        message: "A page you attached is gone",
      });

      expect(
        exitFailure(AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)))),
      ).toBe("A page you attached is gone");
      expect(state().pages.map((chip) => chip.ownerTabId)).toEqual(["tab-1"]);
      expect(state().items.map((item) => item.screenOf)).toEqual(["tab-1"]);
    }),
  );

  it.effect("keep one screen for a page attached again while its message was refused", () =>
    Effect.gen(function* () {
      const { registry, latest, attachPage, state } = yield* setup;
      const revoked = vi.spyOn(URL, "revokeObjectURL");

      yield* attachPage({ ...SHOWN, screen: screen() });

      registry.set(sendAttachedAtom(ROOT), callOf({ typed: "", whenBusy: "followUp" }));
      yield* settle;

      const [submit] = sent(latest(), "submit");
      expect(state().pages).toEqual([]);

      // The owner attaches the same page again, with a newer screen, while the Session answers.
      yield* attachPage({ ...SHOWN, screen: screen(2000) });

      const newer = state().items[0];

      expect(newer?.screenOf).toBe("tab-1");
      revoked.mockClear();

      yield* latest().say({
        type: "error",
        id: submit?.id,
        message: "A page you attached is gone",
      });
      yield* settled(registry, sendAttachedAtom(ROOT));

      // One chip and one screen, the refused message's; the newer screen is let go.
      expect(state().pages.map((chip) => chip.ownerTabId)).toEqual(["tab-1"]);
      expect(state().items).toHaveLength(1);
      expect(state().items[0]).not.toBe(newer);
      expect(state().pages[0]?.screenId).toBe(state().items[0]?.id);
      expect(revoked).toHaveBeenCalledWith(newer?.preview);

      revoked.mockRestore();
    }),
  );
});
