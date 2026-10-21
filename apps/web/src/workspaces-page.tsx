// @effect-diagnostics asyncFunction:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import {
  INSTANCE_DESCRIPTIONS,
  INSTANCE_TYPES,
  type InstanceType,
  type WorkspaceSettings,
} from "@cloudpid/config";
import type { SessionRecord } from "@cloudpid/protocol";
import { ArrowLeft, GitBranch, Play } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";
import { navigate, sessionPath } from "./router.ts";
import { SessionLink } from "./sidebar.tsx";
import type { Sessions } from "./use-sessions.ts";
import {
  type Repos,
  useRepos,
  useWorkspaces,
  useWorkspaceSettings,
  type WorkspaceSettingsStore,
} from "./use-workspaces.ts";
import { idleMinutesProblem, slugProblem, sourceProblem } from "./workspaces.ts";

const NewWorkspaceForm = ({ onCreate }: { onCreate: (slug: string) => Promise<boolean> }) => {
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = slug === "" ? null : slugProblem(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (slug === "" || problem !== null) return;

    setBusy(true);

    if (await onCreate(slug)) setSlug("");

    setBusy(false);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <label htmlFor="new-workspace" className="text-sm font-medium">
        New workspace
      </label>
      <div className="flex gap-2">
        <Input
          id="new-workspace"
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
          }}
          placeholder="cloudpid"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={busy || slug === "" || problem !== null}>
          Create
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
    </form>
  );
};

const CloneForm = ({ slug, repos }: { slug: string; repos: Repos }) => {
  const [source, setSource] = useState("");
  const problem = source.trim() === "" ? null : sourceProblem(source);
  const id = `clone-${slug}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (source.trim() === "" || problem !== null || repos.cloning) return;

    if ((await repos.clone(source)) !== undefined) setSource("");
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Clone a repo
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
          }}
          placeholder="owner/repo or https://github.com/owner/repo"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={repos.cloning}
          aria-invalid={problem !== null}
          className="flex-1 font-mono"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={repos.cloning || source.trim() === "" || problem !== null}
        >
          <GitBranch />
          {repos.cloning ? "Cloning…" : "Clone"}
        </Button>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      {repos.cloning && (
        <p role="status" className="text-xs text-muted-foreground">
          Cloning into /workspace. The first command of a Workspace starts its Container, which
          takes a little while.
        </p>
      )}
    </form>
  );
};

const ContainerSettingsForm = ({
  slug,
  store,
  saved,
}: {
  slug: string;
  store: WorkspaceSettingsStore;
  saved: WorkspaceSettings;
}) => {
  const [instance, setInstance] = useState<InstanceType>(saved.instance);
  const [idle, setIdle] = useState(String(saved.idleMinutes));
  const [justSaved, setJustSaved] = useState(false);
  const problem = idleMinutesProblem(idle);
  const dirty = instance !== saved.instance || idle !== String(saved.idleMinutes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (problem !== null || !dirty || store.saving) return;

    setJustSaved(await store.save({ instance, idleMinutes: Number(idle) }));
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Container</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`instance-${slug}`} className="text-sm font-medium">
            Size
          </label>
          <NativeSelect
            id={`instance-${slug}`}
            value={instance}
            onChange={(event) => {
              const picked = INSTANCE_TYPES.find((type) => type === event.target.value);

              if (picked !== undefined) {
                setInstance(picked);
                setJustSaved(false);
              }
            }}
          >
            {INSTANCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}: {INSTANCE_DESCRIPTIONS[type]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`idle-${slug}`} className="text-sm font-medium">
            Stop after (minutes without a command)
          </label>
          <Input
            id={`idle-${slug}`}
            type="number"
            inputMode="numeric"
            min={1}
            value={idle}
            onChange={(event) => {
              setIdle(event.target.value);
              setJustSaved(false);
            }}
            aria-invalid={problem !== null}
          />
        </div>
      </div>
      {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
      <p className="text-xs text-muted-foreground">
        Applies the next time the Container starts: a running one keeps the size and idle time it
        started with. The Container's disk is saved when it stops, so its tools come back without
        downloading; a saved disk larger than a smaller size's disk cannot be restored there, and
        the Container then starts from scratch.
      </p>
      {store.error !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {store.error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!dirty || problem !== null || store.saving}
        >
          {store.saving ? "Saving…" : "Save"}
        </Button>
        {justSaved && !dirty && (
          <span role="status" className="text-xs text-muted-foreground">
            Saved. It applies at the next start.
          </span>
        )}
      </div>
    </form>
  );
};

const WorkspaceCard = ({
  slug,
  sessions,
  registry,
  starting,
  onStart,
}: {
  slug: string;
  sessions: readonly SessionRecord[];
  registry: ReturnType<typeof useWorkspaces>["registry"];
  starting: boolean;
  onStart: (workspace: string, repo?: string) => void;
}) => {
  const repos = useRepos(registry, slug);
  const container = useWorkspaceSettings(registry, slug);

  return (
    <section aria-label={slug} className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 className="font-mono text-sm font-semibold">{slug}</h2>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Start a session in</h3>
        <ul className="flex flex-col gap-1.5">
          <li className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm text-muted-foreground">/workspace</span>
            <Button
              size="sm"
              variant="outline"
              disabled={starting}
              onClick={() => {
                onStart(slug);
              }}
            >
              <Play />
              Start
            </Button>
          </li>
          {(repos.repos ?? []).map((repo) => (
            <li key={repo} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-sm">/workspace/{repo}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={starting}
                onClick={() => {
                  onStart(slug, repo);
                }}
              >
                <Play />
                Start
              </Button>
            </li>
          ))}
        </ul>
        {repos.repos === null && repos.error === null && (
          <p className="text-xs text-muted-foreground">Looking for repos…</p>
        )}
        {repos.repos?.length === 0 && (
          <p className="text-xs text-muted-foreground">No repos yet. Clone one below.</p>
        )}
      </div>
      <CloneForm slug={slug} repos={repos} />
      {container.state !== null && (
        <ContainerSettingsForm slug={slug} store={container} saved={container.state.settings} />
      )}
      {container.state === null && container.error !== null && (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {container.error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={container.retry}>
            Try again
          </Button>
        </div>
      )}
      {repos.error !== null && (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {repos.error}
        </p>
      )}
      {sessions.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Sessions</h3>
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <SessionLink session={session} active={false} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

/** The Workspaces page: create a Workspace, clone repos into it, and start Sessions in a repo or at its root. */
export const WorkspacesPage = ({ sessions }: { sessions: Sessions }) => {
  const { registry, workspaces, error, create } = useWorkspaces();
  const [starting, setStarting] = useState(false);

  const start = async (workspace: string, repo?: string) => {
    setStarting(true);

    const session = await sessions.create(repo === undefined ? { workspace } : { workspace, repo });

    setStarting(false);

    if (session !== undefined) navigate(sessionPath(session.id));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigate("/");
            }}
            aria-label="Back to sessions"
            className="-ml-2 rounded-md p-2 hover:bg-accent md:hidden"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">Workspaces</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          A workspace holds the files of one or more repos, shared by every session that works in
          it. A session started in a repo has its directory as the working directory.
        </p>
        <NewWorkspaceForm onCreate={create} />
        {(error ?? sessions.error) !== null && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {error ?? sessions.error}
          </p>
        )}
        {workspaces === null ? (
          error === null && <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.slug}
                slug={workspace.slug}
                sessions={(sessions.sessions ?? []).filter(
                  (session) => session.workspace === workspace.slug,
                )}
                registry={registry}
                starting={starting}
                onStart={(slug, repo) => void start(slug, repo)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
