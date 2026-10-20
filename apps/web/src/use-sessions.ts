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
  /** Register a new Session and refresh the list; resolves to it, or undefined if that failed. */
  readonly create: () => Promise<SessionRecord | undefined>;
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

  const create = useCallback(async () => {
    const answer = await registry.createSession();

    if (!answer.ok) {
      setError(answer.message);

      return undefined;
    }

    await refresh();

    return answer.value;
  }, [registry, refresh]);

  return { sessions, error, create, refresh };
};
