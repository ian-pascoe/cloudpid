// The options of a select of a model (`docs/architecture/overview.md` → Models, ADR-0051): the Model catalog's models
// by display name, in an `<optgroup>` per server behind the proxy, and the value the select holds in a group of its own
// when the catalog does not list it, so the select still shows it.
// @effect-diagnostics preferEffectArray:off -- JSX lists of options are native arrays.

import { useAtomValue } from "@effect/atom-react";
import { modelGroups } from "./models.ts";
import { modelCatalogStateAtom } from "./settings.ts";

export const ModelOptions = ({ current }: { current: string | null }) => {
  const catalog = useAtomValue(modelCatalogStateAtom);

  return (
    <>
      {modelGroups(catalog, current).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.models.map((model) => (
            <option key={model.id} value={model.id} title={model.id}>
              {model.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
};
