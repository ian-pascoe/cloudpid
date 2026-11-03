// What a Session came from, under its title (`docs/architecture/mcp-endpoint.md` → Access and identity, Marks): a Fork or
// Clone's source, or "MCP · pi" / "Imported · pi" for a Session the MCP endpoint started or imported.
import { type SessionOrigin, type SessionRecord, sessionOriginLabel } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { navigate, sessionPath } from "./router.ts";
import { sessionListAtom } from "./sessions.ts";
import { sessionTitle } from "./sidebar.tsx";

/**
 * The line under a Fork's or a Clone's title: "Forked from" or "Cloned from" the Session it was made from, a link to it
 * while it is there.
 */
const ForkedFrom = ({ origin }: { origin: SessionOrigin }) => {
  const source = useAtomValue(sessionListAtom, (list) =>
    Option.getOrUndefined(Arr.findFirst(list ?? [], (known) => known.id === origin.session)),
  );

  const made = origin.kind === "fork" ? "Forked from" : "Cloned from";

  return source === undefined ? (
    <>{made} a deleted session</>
  ) : (
    <>
      {made}{" "}
      <button
        type="button"
        onClick={() => {
          navigate(sessionPath(source.id));
        }}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {sessionTitle(source)}
      </button>
    </>
  );
};

/**
 * What a Session came from, under its title: a Fork or Clone's source, or "MCP · pi" / "Imported · pi" for one the MCP
 * endpoint started or imported; none for one started afresh.
 */
export const Origin = ({ session }: { session: SessionRecord }) =>
  session.origin !== undefined ? (
    <ForkedFrom origin={session.origin} />
  ) : session.marks !== undefined ? (
    <>{sessionOriginLabel(session.marks, session.marks.kind)}</>
  ) : undefined;
