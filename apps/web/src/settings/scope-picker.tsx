// @effect-diagnostics preferEffectArray:off -- JSX lists of Environments are native arrays.

// The Scope picker of the Settings page (docs/architecture/client-and-protocol.md → Settings page): a menu of Global
// and each Environment, the one shown checked. Picking one goes to the same section there when it has it, else to its
// first section (`scopeSwitchPath`).

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDown } from "lucide-react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../components/ui/menu.tsx";
import { environmentsInOrderAtom } from "../environments-state.ts";
import { cn } from "../lib/utils.ts";
import { navigate, searchAtom, type SettingsView } from "../router.ts";
import { useScopeName } from "./scope.tsx";
import { scopeSwitchPath } from "./sections.ts";

export const ScopePicker = ({
  scope,
  view,
  className,
}: {
  scope: string;
  view: SettingsView;
  className?: string;
}) => {
  const environments = useAtomValue(environmentsInOrderAtom);
  const search = useAtomValue(searchAtom);
  const name = useScopeName(scope);

  const pick = (to: string) => {
    if (to !== scope) navigate(scopeSwitchPath(view, search, to));
  };

  return (
    <Menu
      label={`Scope: ${name}`}
      title="Choose the scope"
      align="start"
      icon={
        <>
          <span className="truncate">{name}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        </>
      }
      className={cn(
        "size-auto h-8 max-w-56 min-w-0 gap-1 px-2 text-sm font-medium text-foreground",
        className,
      )}
      menuClassName="w-[min(18rem,calc(100vw-1rem))]"
    >
      <MenuItem
        checked={scope === GLOBAL_SCOPE}
        onSelect={() => {
          pick(GLOBAL_SCOPE);
        }}
      >
        Global
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Environments</MenuLabel>
      {environments === null ? (
        <p className="px-2.5 py-1.5 text-sm text-muted-foreground">Loading…</p>
      ) : (
        environments.map((environment) => (
          <MenuItem
            key={environment.id}
            checked={scope === environment.id}
            onSelect={() => {
              pick(environment.id);
            }}
          >
            <span className="truncate">{environment.name}</span>
          </MenuItem>
        ))
      )}
    </Menu>
  );
};
