// `sessions()`: the Registry's Session list filtered and paged for the MCP endpoint's `sessions_list`
// (`docs/architecture/mcp-endpoint.md` → The `api` target, Limits and errors). Pure over the records `listSessions`
// answers, newest first.
// @effect-diagnostics missingPipeableSignature:off
import {
  decodeBase64Url,
  DEFAULT_SESSIONS_PAGE,
  encodeBase64Url,
  MAX_SESSIONS_PAGE,
  type SessionRecord,
  type SessionsQuery,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A page of Sessions: `nextCursor` is there when more follow. */
export type SessionsPage = {
  readonly sessions: ReadonlyArray<SessionRecord>;
  readonly nextCursor?: string;
};

/** What `sessions()` answers: a page, or that the cursor is not one (`invalid_cursor` at the endpoint). */
export type SessionsResult = SessionsPage | { readonly refused: "invalid-cursor" };

/** Where a page ends: the last Session it holds, as the list is ordered (newest first, then by id). */
const Position = Schema.Struct({ t: Schema.Finite, i: Schema.String });

const decodePosition = Schema.decodeUnknownOption(Schema.fromJsonString(Position));

/** Whether `a` comes before `b` in the list: newest first, ties by the larger id. */
const before = (a: { readonly t: number; readonly i: string }, b: typeof a): boolean =>
  a.t > b.t || (a.t === b.t && a.i > b.i);

/**
 * The page of `all` (newest first) `query` asks for. Filters: `environment` (its id), `status` (the Registry's coarse
 * one), `archived` (only archived when true, only the others otherwise) and `query` (a case-insensitive substring of the
 * title). `limit` defaults to `DEFAULT_SESSIONS_PAGE` and is held to `MAX_SESSIONS_PAGE`.
 */
export const pageSessions = (
  all: ReadonlyArray<SessionRecord>,
  query: SessionsQuery,
): SessionsResult => {
  const after =
    query.cursor === undefined
      ? undefined
      : Option.getOrUndefined(decodePosition(decodeBase64Url(query.cursor) ?? ""));

  if (query.cursor !== undefined && after === undefined) return { refused: "invalid-cursor" };

  const needle = query.query?.trim().toLowerCase() ?? "";
  const archived = query.archived === true;
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_SESSIONS_PAGE, 1), MAX_SESSIONS_PAGE);

  const matching = Arr.filter(
    all,
    (session) =>
      (query.environment === undefined || session.environment === query.environment) &&
      (query.status === undefined || session.status === query.status) &&
      (session.archivedAt !== null) === archived &&
      (needle === "" || (session.title ?? "").toLowerCase().includes(needle)) &&
      (after === undefined || before(after, { t: session.createdAt, i: session.id })),
  );

  const page = Arr.take(matching, limit);
  const last = page.at(-1);

  if (matching.length <= limit || last === undefined) return { sessions: page };

  return {
    sessions: page,
    nextCursor: encodeBase64Url(JSON.stringify({ t: last.createdAt, i: last.id })),
  };
};
