// The live read of a resource link's preview (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded
// resources): asked of the Session when the owner opens the chip, once for as long as the preview stays open. The Session
// reads through the host and never starts a Container, so a server that runs in a stopped one answers why it has no
// preview, and the card says so.
// @effect-diagnostics missingPipeableSignature:off -- a key built from strings, not a combinator.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Button } from "../components/ui/button.tsx";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { useShownSessionId, useThreadConversation } from "./conversation.ts";
import { readOf, type ShownResource, unavailableNote } from "./mcp-resources.ts";
import { ReadPreview } from "./mcp-resource-view.tsx";

/**
 * The key of one preview's read: the Session, the conversation (none: the root's), the server, the URI and the path of the
 * spill (none: a link's).
 */
const readKey = (
  sessionId: string,
  conversation: number | undefined,
  resource: Pick<ShownResource, "server" | "uri" | "path">,
): string =>
  Arr.join(
    [sessionId, `${conversation ?? ""}`, resource.server, resource.uri, resource.path ?? ""],
    "\0",
  );

const unkey = (key: string) => {
  const [sessionId = "", conversation = "", server = "", uri = "", path = ""] = key.split("\0");

  return {
    sessionId,
    conversation: conversation === "" ? undefined : Number(conversation),
    server,
    uri,
    path: path === "" ? undefined : path,
  };
};

/**
 * The Session's answer to a preview's read. It reads when something reads this and again when read after nothing did,
 * which is how Retry works (a refresh of the atom).
 */
const resourceReadAtom = Atom.family((key: string) =>
  appRuntime.atom((get) => {
    const { sessionId, conversation, server, uri, path } = unkey(key);

    return get
      .result(sessionClientAtom(sessionId))
      .pipe(Effect.flatMap((client) => client.resourcePreview(conversation, server, uri, path)));
  }),
);

/** The preview of `resource`, which the transcript holds no data of: read when this mounts. */
export const LiveResource = ({ resource }: { resource: ShownResource }) => {
  const sessionId = useShownSessionId();
  const conversation = useThreadConversation();
  const key = readKey(sessionId, conversation, resource);
  const result = useAtomValue(resourceReadAtom(key));
  const retry = useAtomRefresh(resourceReadAtom(key));

  if (AsyncResult.isSuccess(result)) {
    return <ReadPreview resource={resource} read={readOf(result.value, resource)} />;
  }

  if (AsyncResult.isFailure(result)) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <span>{unavailableNote("failed", "the connection to the Session was lost")}</span>
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  return <div className="text-xs text-muted-foreground">Reading…</div>;
};
