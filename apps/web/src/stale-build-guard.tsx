// Installs the reload for a stale build (`stale-build.ts`) for the life of the app, with the page's registry, which the
// check for an unsent draft reads.

import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect } from "react";
import { draftHeldAtom } from "./draft-state.ts";
import { browserPage, installStaleBuildReload } from "./stale-build.ts";

export const StaleBuildGuard = () => {
  const registry = useContext(RegistryContext);

  useEffect(
    () => installStaleBuildReload(browserPage(() => registry.get(draftHeldAtom))),
    [registry],
  );

  return null;
};
