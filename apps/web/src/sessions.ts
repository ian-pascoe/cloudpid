// The Session list and what the owner does to a Session in it: create, rename, archive, unarchive, delete.

import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { replying } from "./calls.ts";
import { changing, failureOf, RegistryClient } from "./registry.ts";
import { deletedHereAtom, leaveSession } from "./app-state.ts";
import { pathAtom, sessionIdAtom, sessionPath } from "./router.ts";
import { appRuntime } from "./runtime.ts";

/** How often the list refreshes while the page is visible, so a running Session shows as it starts and ends. */
export const REFRESH_INTERVAL = Duration.seconds(5);

/** Whether the page is shown: a hidden tab does not poll. */
const pageVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

/** Ticks every `REFRESH_INTERVAL` while the page is visible. */
export const visibleTickAtom = Atom.make(
  REFRESH_INTERVAL.pipe(Schedule.spaced, Stream.fromSchedule, Stream.filter(pageVisible)),
);

/** Every Session, newest first, asked again every few seconds while the page is visible and when it is shown again. */
export const sessionsAtom = RegistryClient.query("listSessions", undefined, {
  reactivityKeys: ["sessions"],
}).pipe(Atom.makeRefreshOnSignal(visibleTickAtom), Atom.refreshOnWindowFocus);

/** The Sessions, newest first, as of the last answer; null until the first. */
export const sessionListAtom = Atom.map(sessionsAtom, (result) =>
  result.pipe(AsyncResult.value, Option.getOrNull),
);

/** Why the list could not load, or null. */
export const sessionsErrorAtom = Atom.map(sessionsAtom, failureOf);

/** Where a new Session works: `/workspace/<repo>` of Workspace `workspace`, or the default Workspace's root. */
export type SessionPlace = { readonly workspace?: string; readonly repo?: string };

/** Register a new Session, idle, and open it; the list asks again. */
export const createSessionAtom = appRuntime.fn(
  replying((where: SessionPlace, get: Atom.FnContext) =>
    RegistryClient.use((registry) => registry("createSession", where)).pipe(
      Effect.tap((created) =>
        Effect.sync(() => {
          get.set(pathAtom, sessionPath(created.id));
        }),
      ),
      changing(["sessions"]),
    ),
  ),
  { concurrent: true },
);

/** Name a Session: the title is the owner's from then on. */
export const renameSessionAtom = appRuntime.fn(
  replying((change: { readonly id: string; readonly title: string }) =>
    RegistryClient.use((registry) => registry("renameSession", change)).pipe(
      changing(["sessions"]),
    ),
  ),
  { concurrent: true },
);

/** Stop everything a Session runs and take it out of the Session list; it is kept whole. */
export const archiveSessionAtom = appRuntime.fn(
  replying((id: string) =>
    RegistryClient.use((registry) => registry("archiveSession", { id })).pipe(
      changing(["sessions"]),
    ),
  ),
  { concurrent: true },
);

/** Put an archived Session back in the Session list. */
export const unarchiveSessionAtom = appRuntime.fn(
  replying((id: string) =>
    RegistryClient.use((registry) => registry("unarchiveSession", { id })).pipe(
      changing(["sessions"]),
    ),
  ),
  { concurrent: true },
);

/**
 * Delete Session `id` for good; the files it wrote in its Workspace stay. Once it is gone its page is left, saying so;
 * its socket's close, which can come first, is then no news. Each Session has its own, so one's delete does not show on
 * another's dialog.
 */
export const deleteSessionAtom = Atom.family((id: string) =>
  appRuntime.fn(
    (_: void, get) =>
      Effect.gen(function* () {
        const asked = (change: (ids: Set<string>) => void) => {
          const ids = new Set(get(deletedHereAtom));

          change(ids);
          get.set(deletedHereAtom, ids);
        };

        asked((ids) => ids.add(id));

        yield* RegistryClient.use((registry) => registry("deleteSession", { id })).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              asked((ids) => ids.delete(id));
            }),
          ),
        );

        leaveSession(get, id, "Session deleted.");
      }).pipe(changing(["sessions"])),
    { concurrent: true },
  ),
);

/** The Session the page shows, as the list last had it; undefined while the list has not answered or lacks it. */
export const currentSessionAtom = Atom.make((get) => {
  const id = get(sessionIdAtom);

  return id === undefined
    ? undefined
    : Option.getOrUndefined(Arr.findFirst(get(sessionListAtom) ?? [], (known) => known.id === id));
});
