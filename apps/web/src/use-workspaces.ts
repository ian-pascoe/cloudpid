// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import type { WorkspaceRecord } from "@cloudpid/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { connectRegistry, type RegistryApi } from "./registry.ts";

export interface Workspaces {
  readonly registry: RegistryApi;
  /** Newest first; null until the first answer. */
  readonly workspaces: readonly WorkspaceRecord[] | null;
  /** Why the list could not load or a Workspace could not be created. */
  readonly error: string | null;
  /** Register a Workspace and refresh the list; resolves to whether it was created. */
  readonly create: (slug: string) => Promise<boolean>;
}

export const useWorkspaces = (): Workspaces => {
  const registry = useMemo(() => connectRegistry(window.location.origin), []);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const answer = await registry.listWorkspaces();

    if (answer.ok) setWorkspaces(answer.value);

    setError(answer.ok ? null : answer.message);
  }, [registry]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (slug: string) => {
      const answer = await registry.createWorkspace(slug);

      if (!answer.ok) {
        setError(answer.message);

        return false;
      }

      await refresh();

      return true;
    },
    [registry, refresh],
  );

  return { registry, workspaces, error, create };
};

export interface Repos {
  /** The directories of the repos the Workspace holds; null until the first answer. */
  readonly repos: readonly string[] | null;
  /** Why the repos could not be listed, or why a clone failed (git's message). */
  readonly error: string | null;
  /** A clone is running. It can take a minute: the Container starts, and the repo is downloaded. */
  readonly cloning: boolean;
  /** Clone `source` into the Workspace and list its repos again; resolves to the directory it went to, or undefined. */
  readonly clone: (source: string) => Promise<string | undefined>;
}

/** The repos of Workspace `slug`, listed once and again after each clone. */
export const useRepos = (registry: RegistryApi, slug: string): Repos => {
  const [repos, setRepos] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  const refresh = useCallback(async () => {
    const answer = await registry.listRepos(slug);

    if (answer.ok) setRepos(answer.value);

    setError(answer.ok ? null : answer.message);
  }, [registry, slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clone = useCallback(
    async (source: string) => {
      setCloning(true);
      setError(null);

      const answer = await registry.cloneRepo(slug, source);

      setCloning(false);

      if (!answer.ok) {
        setError(answer.message);

        return undefined;
      }

      await refresh();

      return answer.value;
    },
    [registry, slug, refresh],
  );

  return { repos, error, cloning, clone };
};
