import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener("popstate", listener);

  return () => {
    window.removeEventListener("popstate", listener);
  };
};

/** The page's path, which changes with `navigate` and the browser's back and forward buttons. */
export const usePath = (): string =>
  useSyncExternalStore(subscribe, () => window.location.pathname);

export const navigate = (path: string): void => {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/** The page of Session `sessionId`. */
export const sessionPath = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}`;

/** The settings page. */
export const SETTINGS_PATH = "/settings";

/** Whether a page path shows the settings. */
export const isSettingsPath = (path: string): boolean => /^\/settings\/?$/.test(path);

/** The Session a page path shows, if any. */
export const sessionIdOf = (path: string): string | undefined => {
  const encoded = /^\/sessions\/([^/]+)\/?$/.exec(path)?.[1];

  return encoded === undefined ? undefined : decodeURIComponent(encoded);
};
