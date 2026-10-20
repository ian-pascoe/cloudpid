import type { SessionRecord } from "@cloudpid/protocol";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { navigate, sessionPath } from "./router.ts";
import type { Sessions } from "./use-sessions.ts";

export const sessionTitle = (session: SessionRecord): string => session.title ?? "Untitled session";

const SessionLink = ({ session, active }: { session: SessionRecord; active: boolean }) => (
  <a
    href={sessionPath(session.id)}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      navigate(sessionPath(session.id));
    }}
    className={cn(
      "flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
      active && "bg-accent text-accent-foreground",
    )}
  >
    <span className="truncate font-medium">{sessionTitle(session)}</span>
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {session.status === "running" ? (
        <>
          <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
          Running
        </>
      ) : (
        <span className="tabular">{relativeTime(session.updatedAt, Date.now())}</span>
      )}
    </span>
  </a>
);

export const Sidebar = ({
  sessions,
  activeId,
  className,
}: {
  sessions: Sessions;
  activeId: string | undefined;
  className?: string;
}) => {
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);

    const session = await sessions.create();

    setCreating(false);

    if (session !== undefined) navigate(sessionPath(session.id));
  };

  return (
    <nav aria-label="Sessions" className={cn("flex w-full flex-col border-r md:w-72", className)}>
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <Button size="sm" variant="outline" disabled={creating} onClick={() => void create()}>
          <Plus />
          New session
        </Button>
      </div>
      {sessions.error !== null && (
        <p role="alert" className="mx-3 mb-2 text-sm text-destructive">
          {sessions.error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.sessions === null ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : sessions.sessions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.sessions.map((session) => (
              <li key={session.id}>
                <SessionLink session={session} active={session.id === activeId} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
};
