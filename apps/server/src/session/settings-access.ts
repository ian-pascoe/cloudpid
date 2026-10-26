// The Session's `SettingsAccess` (`@cloudpid/extensions/settings`, `docs/spec.md` → Agent changes): the Registry's Settings,
// read and changed for the agent. A change is applied and recorded by the Registry (`changeSettings`), as the owner's
// save is applied; the Session reads the Settings again after it (the tools call `SettingsReload`), so its next request
// uses them, and other Sessions read them when they next admit input, as after the owner's save.
import {
  type AppliedSettingsChange,
  SettingsAccessError,
  type SettingsAccessService,
} from "@cloudpid/extensions/settings";
import * as Effect from "effect/Effect";
import type { RegistryMethods } from "../registry/Registry.ts";

/** What the Session's Settings read and change in the Registry. */
export type SettingsRegistry = Pick<RegistryMethods, "getSettings" | "changeSettings">;

export type SessionSettingsAccessOptions = {
  readonly registry: SettingsRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then changes nothing. */
  readonly session: string | undefined;
};

export const sessionSettingsAccess = ({
  registry,
  session,
}: SessionSettingsAccessOptions): SettingsAccessService => ({
  get: Effect.suspend(() => registry.getSettings()).pipe(
    Effect.map(({ settings, overrides, problem }) => ({ settings, overrides, problem })),
  ),
  change: ({ changes, author }) =>
    Effect.gen(function* () {
      if (session === undefined) {
        return yield* SettingsAccessError.make({
          message: "This Session is not one the Registry lists, so it changes no Settings.",
        });
      }

      const answer = yield* registry.changeSettings({
        changes,
        author: { session, ...author },
      });

      switch (answer.status) {
        case "changed":
          return {
            status: "changed",
            changes: answer.changes,
            dropped: answer.dropped,
          } satisfies AppliedSettingsChange;
        case "unchanged":
        case "rejected":
        case "changed-since":
          return answer;
      }
    }),
});
