// @effect-diagnostics asyncFunction:off -- browser code in a React app with no Effect runtime: promises are the platform here.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  disablePush,
  enablePush,
  loadPushStatus,
  pageBrowser,
  type PushBrowser,
  type PushStatus,
} from "./push.ts";
import { connectRegistry } from "./registry.ts";

export interface PushStore {
  /** Whether this device is notified; null until the first answer. */
  readonly status: PushStatus | null;
  /** Whether a change is in flight. */
  readonly busy: boolean;
  /** Ask permission and subscribe this device. */
  readonly enable: () => Promise<void>;
  /** Unsubscribe this device. */
  readonly disable: () => Promise<void>;
}

export const usePush = (): PushStore => {
  const registry = useMemo(() => connectRegistry(window.location.origin), []);
  const browser = useMemo<PushBrowser>(() => pageBrowser(), []);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;

    void loadPushStatus(browser, registry).then((loaded) => {
      if (current) setStatus(loaded);
    });

    return () => {
      current = false;
    };
  }, [browser, registry]);

  const change = useCallback(
    async (run: typeof enablePush) => {
      setBusy(true);
      setStatus(await run(browser, registry));
      setBusy(false);
    },
    [browser, registry],
  );

  return {
    status,
    busy,
    enable: () => change(enablePush),
    disable: () => change(disablePush),
  };
};
