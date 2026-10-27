// @effect-diagnostics missingPipeableSignature:off -- plain helpers over a query string.

// The page's path and query, and what they show, as atoms over the History API: no router library.
//
// The path says which page is shown. The query holds what the page's view has open, today the Session page's Panes:
//
// - `?pane=subagents`: one open Pane. Several are repeated values of `pane`, in tab order
//   (`?pane=subagents&pane=terminal:1`), not one comma-separated value: a Pane's key is free to hold a comma later, a
//   repeated key needs no escaping rule of its own, and each `pane` reads as one tab. A key's `:` is written as it is, not as `%3A`, so a link stays readable.
// - `shown=<key>` names the Pane shown when it is not the first `pane`. Without it (or when it names a Pane that is not
//   open) the first is shown, so the common link, one Pane, has no `shown`.
// - `panes=hidden`: the Pane area is hidden, its Panes still open. Written only beside an open Pane.
// - Anything else in the query is kept as it was, whatever opens or closes a Pane.
//
// Opening, closing and switching Panes *replace* the history entry (`replaceSearch`) instead of pushing one. A Pane is
// part of how the page is laid out, as its scroll is, and Back is for leaving places: with a push, a reader who opened
// Subagents, then the Terminal, would press Back three times to leave the Session, and the first presses would only undo
// what they had just chosen to look at. A link, a reload or a push tap still opens the Session with the same Panes,
// as the entry's URL holds them. Moving to another page (`navigate`) drops the query: Panes belong to one Session, whose
// layout on the device (`session-layout-state.ts`) shows them again when the Session is opened without a query.

import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";

/** Show `path` as a new history entry; `pathAtom` hears of it like a back or forward. */
export const navigate = (path: string): void => {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/**
 * Show `search` (a query: `?pane=subagents`, or `""` for none) on the same path, in place of the history entry's;
 * `searchAtom` hears of it like a back or forward.
 */
export const replaceSearch = (search: string): void => {
  window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/** An atom over one part of the window's location, which follows `popstate`; `empty` is its value without a window. */
const locationAtom = (
  read: (location: Location) => string,
  empty: string,
  write: (value: string) => void,
) =>
  Atom.writable(
    (get): string => {
      if (!("window" in globalThis)) return empty;

      const heard = () => {
        get.setSelf(read(window.location));
      };

      window.addEventListener("popstate", heard);
      get.addFinalizer(() => {
        window.removeEventListener("popstate", heard);
      });

      return read(window.location);
    },
    (ctx, value: string) => {
      if ("window" in globalThis) write(value);
      else ctx.setSelf(value);
    },
  );

/**
 * The page's path, which changes with `navigate` (or a write of this atom) and the browser's back and forward buttons.
 * Without a window (a test that does not stub one) it is `/`.
 */
export const pathAtom = locationAtom((location) => location.pathname, "/", navigate);

/**
 * The page's query (`?pane=subagents`, or `""`), which changes with `replaceSearch` (or a write of this atom, which
 * replaces the history entry) and the browser's back and forward buttons. Without a window it is `""`.
 */
export const searchAtom = locationAtom((location) => location.search, "", replaceSearch);

/**
 * The query's Pane parameters: the open Panes' keys in tab order, the key of the one shown, if named, and whether the
 * area is hidden.
 */
export interface PaneParams {
  readonly keys: readonly string[];
  readonly shown: string | undefined;
  readonly hidden: boolean;
}

/** The Pane parameters of `search`; the keys are as written, for `panes.ts` to check against the Pane types. */
export const paneParamsOf = (search: string): PaneParams => {
  const params = new URLSearchParams(search);

  return {
    keys: params.getAll("pane"),
    shown: params.get("shown") ?? undefined,
    hidden: params.get("panes") === "hidden",
  };
};

/** A Pane key as it is written in a query: encoded, but for the `:` that separates its type from its argument. */
const encodeKey = (key: string): string => encodeURIComponent(key).replaceAll("%3A", ":");

/**
 * `search` with its Pane parameters replaced by `params` (and every other parameter kept): `shown` is written only
 * when it is not the first key. `""` when nothing is left.
 */
export const withPaneParams = (search: string, params: PaneParams): string => {
  const others = new URLSearchParams(search);

  others.delete("pane");
  others.delete("shown");
  others.delete("panes");

  const parts = others.size === 0 ? [] : [others.toString()];

  for (const key of params.keys) parts.push(`pane=${encodeKey(key)}`);

  if (params.shown !== undefined && params.shown !== params.keys[0]) {
    parts.push(`shown=${encodeKey(params.shown)}`);
  }

  if (params.hidden && params.keys.length > 0) parts.push("panes=hidden");

  return parts.length === 0 ? "" : `?${Arr.join(parts, "&")}`;
};

/** The page of Session `sessionId`. */
export const sessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}`;

/**
 * The Subagent page of agent `agentId` (its canonical ID, such as `agent-1.reviewer`, never reused in its Session) in
 * Session `sessionId`: the Session page scoped to that subagent (GLOSSARY.md → Subagent page).
 */
export const subagentPath = (sessionId: string, agentId: string): string =>
  `${sessionPath(sessionId)}/agents/${encodeURIComponent(agentId)}`;

/** The settings page. */
export const SETTINGS_PATH = "/settings";

/** Whether a page path shows the settings. */
export const isSettingsPath = (path: string): boolean => /^\/settings\/?$/.test(path);

/** The Environments page: make Environments, add Repos to them, and manage their Workspaces. */
export const ENVIRONMENTS_PATH = "/environments";

/** Whether a page path shows the Environments. */
export const isEnvironmentsPath = (path: string): boolean => /^\/environments\/?$/.test(path);

/** The draft page: write the first message of a new Session, and choose where it works. */
export const DRAFT_PATH = "/new";

/** Whether a page path shows the draft. */
export const isDraftPath = (path: string): boolean => /^\/new\/?$/.test(path);

/** `encoded` decoded, or undefined when it is not a valid encoding (a hand-edited link). */
const decoded = (encoded: string | undefined): string | undefined => {
  if (encoded === undefined) return undefined;

  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
};

/** A Session's page, or one of its Subagent pages: the Session's ID, then the agent's when it is a Subagent page. */
const SESSION_PAGE = /^\/sessions\/([^/]+)(?:\/agents\/([^/]+))?\/?$/;

/** What a page path shows. */
export type Page =
  | { readonly kind: "settings" }
  | { readonly kind: "environments" }
  | { readonly kind: "draft" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "subagent"; readonly sessionId: string; readonly agentId: string }
  | { readonly kind: "empty" };

/** What `path` shows. */
export const pageOf = (path: string): Page => {
  if (isSettingsPath(path)) return { kind: "settings" };

  if (isEnvironmentsPath(path)) return { kind: "environments" };

  if (isDraftPath(path)) return { kind: "draft" };

  const match = SESSION_PAGE.exec(path);
  const sessionId = decoded(match?.[1]);
  const agentId = decoded(match?.[2]);

  if (sessionId === undefined || (match?.[2] !== undefined && agentId === undefined)) {
    return { kind: "empty" };
  }

  return agentId === undefined
    ? { kind: "session", sessionId }
    : { kind: "subagent", sessionId, agentId };
};

/** The Session a page path shows, if any: a Subagent page shows its Session too, scoped to one subagent. */
export const sessionIdOf = (path: string): string | undefined => {
  const page = pageOf(path);

  return page.kind === "session" || page.kind === "subagent" ? page.sessionId : undefined;
};

/** The subagent whose Subagent page a path shows, by its canonical ID, if it is one. */
export const agentIdOf = (path: string): string | undefined => {
  const page = pageOf(path);

  return page.kind === "subagent" ? page.agentId : undefined;
};

/** What the page shows now. */
export const pageAtom = Atom.map(pathAtom, pageOf);

/** The Session the page shows, if any: on a Subagent page, the subagent's Session. */
export const sessionIdAtom = Atom.map(pathAtom, sessionIdOf);

/** The subagent whose Subagent page is shown, if one is. */
export const agentIdAtom = Atom.map(pathAtom, agentIdOf);
