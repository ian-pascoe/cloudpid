// How a Session is followed over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → Following a Run): its status,
// its cursor, and what ends a wait. Pure decisions over what the host read (`FollowState`) and the requests waiting for
// the owner, so each rule is tested without a Session.
// @effect-diagnostics missingPipeableSignature:off
import {
  type CursorState,
  type EndedBy,
  type McpSessionStatus,
  type WaitingRequest,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import type * as Types from "effect/Types";
import type { FollowState } from "./mcp-reads.ts";

/** What a status or a wait decides from. */
export type Snapshot = {
  readonly state: FollowState;
  /** The requests waiting for the owner, anywhere in the Session. */
  readonly waiting: ReadonlyArray<WaitingRequest>;
};

/** The newest `since` among the requests: the mark a cursor keeps, 0 for none. */
export const waitingMark = (waiting: ReadonlyArray<WaitingRequest>): number =>
  Arr.reduce(waiting, 0, (mark, request) => Math.max(mark, request.since));

/**
 * `importing` while the Session fills; `waiting_for_owner` when a request waits anywhere in it; `running` while the
 * conversation's Run is going or input is queued for it; `background` when only subagents or tasks work; else `idle`.
 */
export const statusOf = ({ state, waiting }: Snapshot): McpSessionStatus => {
  if (state.copying) return "importing";

  if (waiting.length > 0) return "waiting_for_owner";

  if (state.unsettled) return "running";

  return state.idle ? "idle" : "background";
};

/** The cursor for the Session as it stands: what a caller holding it has seen of it. */
export const cursorOf = ({ state, waiting }: Snapshot): CursorState => {
  const cursor: Types.Mutable<CursorState> = {
    c: state.conversationId,
    e: state.newestEntry,
    w: waitingMark(waiting),
    s: state.newestSettled?.id ?? 0,
  };

  if (state.copying) cursor.i = true;

  return cursor;
};

/**
 * What ends a wait now, if anything. With a cursor: a Run that ended after it, then a waiting request newer than its
 * mark, then an import that ended (`import_ended`: its cursor says it was importing), then a parked task. Without one
 * it returns at once unless a Run is going and nothing waits; an import going is not a Run, so it returns at once too,
 * as `timeout` with the status `importing` and a cursor that ends with the import. A request the caller has seen does not
 * end a wait.
 */
export const endedBy = (
  snapshot: Snapshot,
  cursor: CursorState | undefined,
): EndedBy | undefined => {
  const { state, waiting } = snapshot;

  if (cursor === undefined) {
    // An import is no Run: the caller gets the status (`importing`) and a cursor to wait out the import from.
    if (state.copying) return "timeout";

    if (waiting.length > 0) return "owner_needed";

    if (state.stalled) return "stalled";

    if (state.unsettled) return undefined;

    return state.newestSettled === undefined ? "timeout" : "run_ended";
  }

  if (state.newestSettled !== undefined && state.newestSettled.id > cursor.s) return "run_ended";

  if (Arr.some(waiting, (request) => request.since > cursor.w)) return "owner_needed";

  if (cursor.i === true && !state.copying) return "import_ended";

  if (state.stalled) return "stalled";

  return undefined;
};
