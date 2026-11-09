// @effect-diagnostics preferEffectArray:off -- assertions over what the fakes recorded, in native arrays.

import { MAX_ATTACHED_RESOURCES, MAX_ATTACHMENT_BYTES } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
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
  addAppMessageAtom,
  addAttachmentsAtom,
  addPageAtom,
  addResourceAtom,
  attachmentsAtom,
  type PageToAttach,
  removeAppMessageAtom,
  removeAttachmentAtom,
  removePageAtom,
  removeResourceAtom,
  screenNote,
  sendAttachedAtom,
  sentApps,
  sentAttachments,
  sentPages,
  sentResources,
  waitingFor,
} from "./attachments-state.ts";
import { templateDone, templatePick } from "./template-form.ts";
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
    chat.registry.mount(addResourceAtom(ROOT)),
    chat.registry.mount(removeResourceAtom(ROOT)),
  ];

  const leave = Effect.sync(() => {
    for (const unmount of unmounts) unmount();
  }).pipe(Effect.andThen(settle));

  yield* settle;
  // A Session that takes attached resources, as the current one says in its hello.
  yield* live(chat.latest(), { attachedResources: true });

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

  it.effect(
    "send an MCP prompt with the message, and fail with the refusal's code and server so the composer can act on them",
    () =>
      Effect.gen(function* () {
        const { registry, latest } = yield* setup;

        const prompt = {
          prompt: {
            command: "/mcp__docs__review",
            server: "docs",
            source: "owner",
            name: "review",
            title: "Review PR",
            description: "",
            arguments: [{ name: "pr", required: true }],
            completions: false,
          },
          values: { pr: "7", gone: "dropped" },
        };

        registry.set(
          sendAttachedAtom(ROOT),
          callOf({ typed: "focus on tests", whenBusy: "followUp", prompt }),
        );
        yield* settle;

        const [submit] = sent(latest(), "submit");

        expect(submit).toMatchObject({
          input: "focus on tests",
          mcpPrompt: { server: "docs", name: "review", arguments: { pr: "7" } },
        });

        yield* latest().say({
          type: "error",
          id: submit?.id,
          message: "docs is not signed in",
          code: "MCP_SIGN_IN_REQUIRED",
          server: "docs",
        });

        const exit = AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)));

        expect(exitFailure(exit)).toBe("docs is not signed in");
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : null).toMatchObject({
          refusal: { code: "MCP_SIGN_IN_REQUIRED", server: "docs" },
        });
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

describe("a composer's attached MCP resources", () => {
  const GUIDE = { server: "docs", uri: "file:///guide.md", name: "Guide" };

  it.effect("are attached once, in order, and taken off again", () =>
    Effect.gen(function* () {
      const { registry, state } = yield* setup;

      registry.set(addResourceAtom(ROOT), GUIDE);
      registry.set(addResourceAtom(ROOT), GUIDE);
      registry.set(addResourceAtom(ROOT), { server: "docs", uri: "file:///b.md", name: "" });
      yield* settle;

      expect(state().resources.map((chip) => chip.uri)).toEqual([
        "file:///guide.md",
        "file:///b.md",
      ]);
      expect(sentResources(state())).toEqual([
        { ref: { server: "docs", uri: "file:///guide.md", name: "Guide" }, label: "Guide" },
        { ref: { server: "docs", uri: "file:///b.md" }, label: "b.md" },
      ]);

      registry.set(removeResourceAtom(ROOT), { server: "docs", uri: "file:///guide.md" });
      yield* settle;

      expect(state().resources.map((chip) => chip.uri)).toEqual(["file:///b.md"]);
    }),
  );

  it.effect(
    "hold the resource a template's values make as a chip, sent as the URI they fill in",
    () =>
      Effect.gen(function* () {
        const { registry, state } = yield* setup;

        const picked = templatePick(
          "repos",
          { uriTemplate: "repo://{owner}/{name}", name: "repo" },
          true,
        );

        if (picked.kind !== "form") throw new Error("a template with variables opens its form");

        const done = templateDone({ ...picked.form, values: { owner: "acme", name: "web" } });

        if (!("resource" in done)) throw new Error("the values fill every required variable");

        registry.set(addResourceAtom(ROOT), done.resource);
        yield* settle;

        expect(sentResources(state())).toEqual([
          { ref: { server: "repos", uri: "repo://acme/web", name: "repo" }, label: "repo" },
        ]);
      }),
  );

  it.effect("hold a message's worth, no more", () =>
    Effect.gen(function* () {
      const { registry, state } = yield* setup;

      for (let index = 0; index < MAX_ATTACHED_RESOURCES + 3; index++) {
        registry.set(addResourceAtom(ROOT), {
          server: "docs",
          uri: `file:///${String(index)}`,
          name: "",
        });
      }

      yield* settle;

      expect(state().resources).toHaveLength(MAX_ATTACHED_RESOURCES);
    }),
  );

  it.effect(
    "make a message alone, go as references, and come back when the Session refuses it",
    () =>
      Effect.gen(function* () {
        const { registry, latest, state } = yield* setup;

        registry.set(addResourceAtom(ROOT), GUIDE);
        yield* settle;

        registry.set(sendAttachedAtom(ROOT), callOf({ typed: "", whenBusy: "followUp" }));
        yield* settle;

        const [submit] = sent(latest(), "submit");

        expect(submit).toMatchObject({
          resources: [{ server: "docs", uri: GUIDE.uri, name: "Guide" }],
        });
        // Off the composer while the Session answers.
        expect(state().resources).toEqual([]);

        yield* latest().say({
          type: "error",
          id: submit?.id,
          message: "A resource you attached is gone",
          code: "ATTACHED_RESOURCE_GONE",
        });

        expect(
          exitFailure(AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)))),
        ).toBe("A resource you attached is gone");
        expect(state().resources.map((chip) => chip.uri)).toEqual([GUIDE.uri]);
      }),
  );

  it.effect(
    "are not sent to a Session that does not say it takes them, and come back with why",
    () =>
      Effect.gen(function* () {
        const chat = chatRegistry(fakeUploads().layer, fakeImages().layer);

        chat.registry.mount(sessionStatusAtom("s1"));
        chat.registry.mount(attachmentsAtom(ROOT));
        chat.registry.mount(addResourceAtom(ROOT));
        chat.registry.mount(sendAttachedAtom(ROOT));
        yield* settle;
        // An older Session: its hello has no `attachedResources`.
        yield* live(chat.latest());

        chat.registry.set(addResourceAtom(ROOT), GUIDE);
        yield* settle;
        chat.registry.set(sendAttachedAtom(ROOT), callOf({ typed: "go", whenBusy: "followUp" }));
        yield* settle;

        expect(sent(chat.latest(), "submit")).toEqual([]);
        expect(
          exitFailure(AsyncResult.toExit(yield* settled(chat.registry, sendAttachedAtom(ROOT)))),
        ).toMatch(/cannot take attached MCP resources/);
        expect(chat.registry.get(attachmentsAtom(ROOT)).resources).toHaveLength(1);
      }),
  );
});

describe("a composer's App messages", () => {
  const message = (callId: string, text = `from ${callId}`) => ({ callId, server: "docs", text });

  /** A composer of a Session that takes App messages (its hello says so) unless `hello` says otherwise. */
  const apps = (hello: { readonly [key: string]: boolean } = { appMessages: true }) =>
    Effect.gen(function* () {
      const chat = chatRegistry(fakeUploads().layer, fakeImages().layer);

      chat.registry.mount(sessionStatusAtom("s1"));
      chat.registry.mount(attachmentsAtom(ROOT));
      chat.registry.mount(addAppMessageAtom(ROOT));
      chat.registry.mount(removeAppMessageAtom(ROOT));
      chat.registry.mount(sendAttachedAtom(ROOT));
      yield* settle;
      yield* live(chat.latest(), hello);

      const hold = (chip: ReturnType<typeof message>) =>
        Effect.sync(() => {
          chat.registry.set(addAppMessageAtom(ROOT), chip);
        }).pipe(
          Effect.andThen(settled(chat.registry, addAppMessageAtom(ROOT))),
          Effect.map((result) => AsyncResult.getOrElse(result, () => undefined)),
        );

      return { ...chat, hold, state: () => chat.registry.get(attachmentsAtom(ROOT)) };
    });

  it.effect("keeps one chip for a View: a newer message replaces it, in its place", () =>
    Effect.gen(function* () {
      const { hold, state } = yield* apps();

      yield* hold(message("c1", "first"));
      yield* hold(message("c2"));
      yield* hold(message("c1", "second"));

      expect(state().apps.map((chip) => [chip.callId, chip.text])).toEqual([
        ["c1", "second"],
        ["c2", "from c2"],
      ]);
    }),
  );

  it.effect(
    "holds at most three, refusing a fourth View's, and still takes a newer one of a View it holds",
    () =>
      Effect.gen(function* () {
        const { hold, state } = yield* apps();

        for (const id of ["c1", "c2", "c3"]) expect(yield* hold(message(id))).toBe("held");

        expect(yield* hold(message("c4"))).toBe("refused");
        expect(state().apps.map((chip) => chip.callId)).toEqual(["c1", "c2", "c3"]);

        expect(yield* hold(message("c2", "newer"))).toBe("held");
        expect(state().apps.find((chip) => chip.callId === "c2")?.text).toBe("newer");
      }),
  );

  it.effect("drops a chip on Discard, and makes room for another View's", () =>
    Effect.gen(function* () {
      const { registry, hold, state } = yield* apps();

      for (const id of ["c1", "c2", "c3"]) yield* hold(message(id));

      registry.set(removeAppMessageAtom(ROOT), "c2");
      yield* settle;
      expect(state().apps.map((chip) => chip.callId)).toEqual(["c1", "c3"]);

      expect(yield* hold(message("c4"))).toBe("held");
    }),
  );

  it.effect(
    "go with Send as `app`, after the typed text, which may be none, and leave the composer",
    () =>
      Effect.gen(function* () {
        const { registry, latest, hold, state } = yield* apps();

        yield* hold(message("c1", "Pick A"));
        yield* hold(message("c2", "Pick B"));

        expect(sentApps(state())).toEqual([
          { ref: { callId: "c1", text: "Pick A" }, label: "Message from docs" },
          { ref: { callId: "c2", text: "Pick B" }, label: "Message from docs" },
        ]);

        registry.set(sendAttachedAtom(ROOT), callOf({ typed: "", whenBusy: "followUp" }));
        yield* settle;

        const [submit] = sent(latest(), "submit");

        expect(submit).toMatchObject({
          input: "",
          app: [
            { callId: "c1", text: "Pick A" },
            { callId: "c2", text: "Pick B" },
          ],
        });
        expect(state().apps).toEqual([]);
      }),
  );

  it.effect("come back when the Session refuses the message, before any a View sent since", () =>
    Effect.gen(function* () {
      const { registry, latest, hold, state } = yield* apps();

      yield* hold(message("c1", "Pick A"));
      registry.set(sendAttachedAtom(ROOT), callOf({ typed: "go", whenBusy: "followUp" }));
      yield* settle;

      const [submit] = sent(latest(), "submit");

      yield* hold(message("c1", "newer"));
      yield* hold(message("c2", "other"));

      yield* latest().say({ type: "error", id: submit?.id, message: "No" });
      yield* settled(registry, sendAttachedAtom(ROOT));

      expect(state().apps.map((chip) => [chip.callId, chip.text])).toEqual([
        ["c1", "Pick A"],
        ["c2", "other"],
      ]);
    }),
  );

  it.effect(
    "are not sent to a Session that does not say it takes them, and come back with why",
    () =>
      Effect.gen(function* () {
        const { registry, latest, hold, state } = yield* apps({});

        yield* hold(message("c1"));
        registry.set(sendAttachedAtom(ROOT), callOf({ typed: "go", whenBusy: "followUp" }));
        yield* settle;

        expect(sent(latest(), "submit")).toEqual([]);
        expect(
          exitFailure(AsyncResult.toExit(yield* settled(registry, sendAttachedAtom(ROOT)))),
        ).toMatch(/cannot take App messages/);
        expect(state().apps).toHaveLength(1);
      }),
  );
});
