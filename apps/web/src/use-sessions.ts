// @effect-diagnostics asyncFunction:off globalTimers:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import type { SessionRecord } from "@cloudpid/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Answer, connectRegistry } from "./registry.ts";

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
  /** Name a Session and refresh the list; resolves to null when it worked, or to why it did not. */
  readonly rename: (id: string, title: string) => Promise<string | null>;
  /**
   * Archive a Session (stopping what it runs) and refresh the list; resolves to null when it worked, or to why not,
   * which the caller shows where the owner asked.
   */
  readonly archive: (id: string) => Promise<string | null>;
  /** Put an archived Session back in the list; resolves to null when it worked, or to why not. */
  readonly unarchive: (id: string) => Promise<string | null>;
  /** Delete a Session for good and refresh the list; resolves to null when it worked, or to why not. */
  readonly delete: (id: string) => Promise<string | null>;
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

  /** Run `call`, then refresh the list once it worked; null, or why it did not. */
  const changed = useCallback(
    async (call: Promise<Answer<unknown>>) => {
      const answer = await call;

      if (!answer.ok) return answer.message;

      await refresh();

      return null;
    },
    [refresh],
  );

  const rename = useCallback(
    (id: string, title: string) => changed(registry.renameSession(id, title)),
    [registry, changed],
  );

  const archive = useCallback(
    (id: string) => changed(registry.archiveSession(id)),
    [registry, changed],
  );

  const unarchive = useCallback(
    (id: string) => changed(registry.unarchiveSession(id)),
    [registry, changed],
  );

  const deleteSession = useCallback(
    (id: string) => changed(registry.deleteSession(id)),
    [registry, changed],
  );

  return {
    sessions,
    error,
    create,
    rename,
    archive,
    unarchive,
    delete: deleteSession,
    refresh,
  };
};
