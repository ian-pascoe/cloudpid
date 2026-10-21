// What the page says about what happened elsewhere, and leaving a Session's page when the Session is gone.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import { changing } from "./registry.ts";
import { pathAtom, sessionIdAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";

/**
 * Something the owner should know that happened before they moved on, such as a Session deleted from another device.
 * Opening a Session clears it.
 */
export const noticeAtom = Atom.writable(
  (get): string | null =>
    get(sessionIdAtom) === undefined ? Option.getOrNull(get.self<string | null>()) : null,
  (ctx, notice: string | null) => {
    ctx.setSelf(notice);
  },
);

/**
 * Why an archive or unarchive asked on the Session's page failed, shown there: the list may be hidden (a phone). It
 * belongs to the page it was asked on, so a change of page clears it.
 */
export const pageProblemAtom = Atom.writable(
  (get): string | null => {
    get(pathAtom);

    return null;
  },
  (ctx, problem: string | null) => {
    ctx.setSelf(problem);
  },
);

/**
 * Why an archive or unarchive from a Session's menu in the list failed, shown with the list's own error. It stays until
 * the next archive or unarchive from the list.
 */
export const listProblemAtom = Atom.make<string | null>(null);

/** Sessions this page asked to delete: their socket's close can come before the answer, and is then no news. */
export const deletedHereAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);

/** The Session `id` is gone: leave its page if it is the one shown, and say why. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a step of an atom function, called with its context.
export const leaveSession = (get: Atom.FnContext, id: string, message: string): void => {
  if (get(sessionIdAtom) !== id) return;

  get.set(noticeAtom, message);
  get.set(pathAtom, "/");
};

/** The socket of Session `id` closed saying it was deleted: here, or on another device. The list asks again. */
export const sessionGoneAtom = appRuntime.fn(
  (id: string, get) =>
    Effect.sync(() => {
      leaveSession(
        get,
        id,
        get(deletedHereAtom).has(id) ? "Session deleted." : "That session was deleted.",
      );
    }).pipe(changing(["sessions"])),
  { concurrent: true },
);
