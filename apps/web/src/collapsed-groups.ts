// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a short list of keys over native arrays, and plain helpers.

// Which Environment groups of the Session list are collapsed: a view preference kept per device in `localStorage`.

import type { SessionRecord } from "@cloudpid/protocol";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { appRuntime } from "./runtime.ts";
import { currentSessionAtom } from "./sessions.ts";

/** The part of the Session list a group is in: its archived Sessions are grouped apart. */
export type ListSection = "active" | "archived";

/** A group of the Session list: the Sessions of Environment `environment` in `section`. */
export const groupKey = (section: ListSection, environment: string): string =>
  `${section}:${environment}`;

/** The group Session `session` is listed in. */
const groupOf = (session: SessionRecord): string =>
  groupKey(session.archivedAt === null ? "active" : "archived", session.environment);

/** The groups collapsed on this device (in the runtime's key-value store); every other group is expanded. */
const collapsedGroupsAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:collapsed-groups",
  schema: Schema.Array(Schema.String),
  defaultValue: (): readonly string[] => [],
}).pipe(Atom.keepAlive);

/** Whether group `key` is collapsed; writing it collapses or expands the group, and keeps that on this device. */
export const groupCollapsedAtom = Atom.family((key: string) =>
  Atom.writable(
    (get) => get(collapsedGroupsAtom).includes(key),
    (ctx, collapsed: boolean) => {
      const others = ctx.get(collapsedGroupsAtom).filter((known) => known !== key);

      ctx.set(collapsedGroupsAtom, collapsed ? [...others, key] : others);
    },
  ),
);

/**
 * Expands the group of the Session shown as it is shown (or moves to another group, as when it is archived), and keeps
 * that on this device. It acts only on that change, so the owner can collapse the group again while the Session stays
 * shown. Mounted for as long as the app runs.
 */
export const revealShownAtom = Atom.make((get) => {
  let last: string | undefined;

  get.subscribe(
    currentSessionAtom,
    (session) => {
      // None shown: the next one shown is shown anew, though it is the last one again.
      if (session === undefined) {
        last = undefined;

        return;
      }

      const shown = `${session.id} ${groupOf(session)}`;

      if (shown === last) return;

      last = shown;
      get.set(groupCollapsedAtom(groupOf(session)), false);
    },
    { immediate: true },
  );
});
