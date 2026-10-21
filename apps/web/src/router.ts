// The page's path and what it shows, as atoms over the History API: no router library.

import * as Atom from "effect/reactivity/Atom";

/** Show `path` as a new history entry; `pathAtom` hears of it like a back or forward. */
export const navigate = (path: string): void => {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/**
 * The page's path, which changes with `navigate` (or a write of this atom) and the browser's back and forward buttons.
 * Without a window (a test that does not stub one) it is `/`.
 */
export const pathAtom = Atom.writable(
  (get): string => {
    if (!("window" in globalThis)) return "/";

    const heard = () => {
      get.setSelf(window.location.pathname);
    };

    window.addEventListener("popstate", heard);
    get.addFinalizer(() => {
      window.removeEventListener("popstate", heard);
    });

    return window.location.pathname;
  },
  (ctx, path: string) => {
    if ("window" in globalThis) navigate(path);
    else ctx.setSelf(path);
  },
);

/** The page of Session `sessionId`. */
export const sessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}`;

/** The settings page. */
export const SETTINGS_PATH = "/settings";

/** Whether a page path shows the settings. */
export const isSettingsPath = (path: string): boolean => /^\/settings\/?$/.test(path);

/** The Workspaces page: create Workspaces, clone repos into them, and start Sessions in them. */
export const WORKSPACES_PATH = "/workspaces";

/** Whether a page path shows the Workspaces. */
export const isWorkspacesPath = (path: string): boolean => /^\/workspaces\/?$/.test(path);

/** The Session a page path shows, if any. */
export const sessionIdOf = (path: string): string | undefined => {
  const encoded = /^\/sessions\/([^/]+)\/?$/.exec(path)?.[1];

  return encoded === undefined ? undefined : decodeURIComponent(encoded);
};

/** What a page path shows. */
export type Page =
  | { readonly kind: "settings" }
  | { readonly kind: "workspaces" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "empty" };

/** What `path` shows. */
export const pageOf = (path: string): Page => {
  if (isSettingsPath(path)) return { kind: "settings" };

  if (isWorkspacesPath(path)) return { kind: "workspaces" };

  const sessionId = sessionIdOf(path);

  return sessionId === undefined ? { kind: "empty" } : { kind: "session", sessionId };
};

/** What the page shows now. */
export const pageAtom = Atom.map(pathAtom, pageOf);

/** The Session the page shows, if any. */
export const sessionIdAtom = Atom.map(pathAtom, sessionIdOf);
