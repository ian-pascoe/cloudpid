// The Scope the Settings page shows (GLOSSARY.md → Scope; docs/architecture/client-and-protocol.md → Settings page), for
// what is rendered inside it: the Skills section and the Skill directory's pages build their links in it and install
// for it. Outside the page (a test that renders a part alone) it is Global.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { createContext, useContext } from "react";
import { environmentNamesAtom } from "../environments-state.ts";

/** `*` for Global, or an Environment's id. */
export const SettingsScope = createContext<string>(GLOBAL_SCOPE);

/** The Scope the Settings page shows: `*` for Global, or an Environment's id. */
export const useSettingsScope = (): string => useContext(SettingsScope);

/** The name of Scope `scope` as the page shows it: "Global", or the Environment's name (its id until it is listed). */
export const useScopeName = (scope: string): string => {
  const names = useAtomValue(environmentNamesAtom);

  return scope === GLOBAL_SCOPE ? "Global" : (names[scope] ?? scope);
};
