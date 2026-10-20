// @effect-diagnostics asyncFunction:off globalTimers:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { overridesFrom, type Settings } from "@cloudpid/config";
import type { SettingsState } from "@cloudpid/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectRegistry } from "./registry.ts";

export interface SettingsStore {
  /** The settings in force; null until the first answer. */
  readonly state: SettingsState | null;
  /** Why the settings could not load, or why `save` was refused: the Registry's own message. */
  readonly error: string | null;
  readonly saving: boolean;
  /** Save `settings` as overrides of the defaults; resolves to whether the Registry accepted them. */
  readonly save: (settings: Settings) => Promise<boolean>;
}

export const useSettings = (): SettingsStore => {
  const registry = useMemo(() => connectRegistry(window.location.origin), []);
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;

    void registry.getSettings().then((answer) => {
      if (!current) return;

      if (answer.ok) setState(answer.value);
      else setError(answer.message);
    });

    return () => {
      current = false;
    };
  }, [registry]);

  const save = useCallback(
    async (settings: Settings) => {
      setSaving(true);

      const answer = await registry.updateSettings(overridesFrom(settings));

      setSaving(false);

      if (answer.ok) setState(answer.value);

      setError(answer.ok ? null : answer.message);

      return answer.ok;
    },
    [registry],
  );

  return { state, error, saving, save };
};
