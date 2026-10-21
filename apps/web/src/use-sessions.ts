// @effect-diagnostics asyncFunction:off globalTimers:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import type { SessionRecord } from "@cloudpid/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectRegistry } from "./registry.ts";

/** How often the list refreshes while the page is visible, so a running Session shows as it starts and ends. */
const REFRESH_MS = 5_000;

export interface Sessions {
  /** Newest first; null until the first answer. */
  readonly sessions: readonly SessionRecord[] | null;
  /** Why the list could not load or a Session could not be created. */
  readonly error: string | null;
  /**
   * Register a new Session and refresh the list; resolves to it, or undefined if that failed. It works in
   * `/workspace/<repo>` of Workspace `workspace`, or at the root of the default Workspace without them.
   */
  readonly create: (where?: {
    readonly workspace?: string;
    readonly repo?: string;
  }) => Promise<SessionRecord | undefined>;
  /** Name a Session and refresh the list; resolves to whether it worked (the reason is in `error` when not). */
  readonly rename: (id: string, title: string) => Promise<boolean>;
  readonly refresh: () => Promise<void>;
}

export const useSessions = (): Sessions => {
  const registry = useMemo(() => connectRegistry(window.location.origin), []);
  const [sessions, setSessions] = useState<readonly SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const answer = await registry.listSessions();

    if (answer.ok) setSessions(answer.value);

    setError(answer.ok ? null : answer.message);
  }, [registry]);

  useEffect(() => {
    void refresh();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);

    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  const create = useCallback(
    async (where?: { workspace?: string; repo?: string }) => {
      const answer = await registry.createSession(where);

      if (!answer.ok) {
        setError(answer.message);

        return undefined;
      }

      await refresh();

      return answer.value;
    },
    [registry, refresh],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const answer = await registry.renameSession(id, title);

      if (!answer.ok) {
        setError(answer.message);

        return false;
      }

      await refresh();

      return true;
    },
    [registry, refresh],
  );

  return { sessions, error, create, rename, refresh };
};
