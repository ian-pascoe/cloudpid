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
//
// The Settings page (docs/architecture/client-and-protocol.md → Settings page) is `/settings/:scope/:section`, the Scope
// `all` for Global or an Environment's id; `/settings` and `/settings/:scope` are a Scope's list of sections. Its Skills
// section keeps its view in the query: `?tab=` (`installed`, `all-time`, `trending`, `hot`) and `?q=` (the search).
// The tabs are a query, not a path, because the path's first segment after `skills` is always an owner of the Skill
// directory: `…/skills/:owner`, `…/skills/:owner/:repo` and `…/skills/:owner/:repo/:skill`, so an owner named
// `installed` is an owner.
//
// The old pages' addresses (`/environments`, `/skills…`) are replaced in the history by their Settings page equivalent
// as the page opens or is navigated to (`legacyRedirect`), so a bookmark or an old link still lands.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";

/** Show `path` as a new history entry; `pathAtom` hears of it like a back or forward. */
export const navigate = (path: string): void => {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/** Show `path` in place of the history entry's, as a page that leads elsewhere does; `pathAtom` hears of it. */
export const redirect = (path: string): void => {
  window.history.replaceState(null, "", path);
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
        settleLegacy();
        get.setSelf(read(window.location));
      };

      window.addEventListener("popstate", heard);
      get.addFinalizer(() => {
        window.removeEventListener("popstate", heard);
      });

      settleLegacy();

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
 * The Subagent page of agent `agentId` (its canonical ID, such as `agent-1.reviewer`, which a new subagent may take once
 * it is deleted) in Session `sessionId`: the Session page scoped to that subagent (GLOSSARY.md → Subagent page).
 */
export const subagentPath = (sessionId: string, agentId: string): string =>
  `${sessionPath(sessionId)}/agents/${encodeURIComponent(agentId)}`;

/** The Settings page, at Global's list of sections (a wide screen opens its first section). */
export const SETTINGS_PATH = "/settings";

/** Global's Scope in a Settings page path, in place of the `*` the Registry names it by. */
export const GLOBAL_SEGMENT = "all";

/** The path segment of Scope `scope` (`*` for Global, or an Environment's id). */
const scopeSegment = (scope: string): string =>
  scope === GLOBAL_SCOPE ? GLOBAL_SEGMENT : encodeURIComponent(scope);

/**
 * The Settings page at Scope `scope` (`*` for Global, or an Environment's id): section `section` (its slug), or the
 * Scope's list of sections when none is named.
 */
export const settingsPath = (scope: string, section?: string): string =>
  `${SETTINGS_PATH}/${scopeSegment(scope)}${section === undefined ? "" : `/${section}`}`;

/** The Skills section's tabs, as the query names them, in the order the tab bar shows them. */
export const SKILLS_TABS = ["installed", "all-time", "trending", "hot"] as const;

export type SkillsTab = (typeof SKILLS_TABS)[number];

const isSkillsTab = (value: string | null): value is SkillsTab =>
  value !== null && Arr.contains(SKILLS_TABS, value);

/** What the Skills section's query names. */
export interface SkillsParams {
  /** The tab shown; undefined when the query names none (or one that is not a tab), for the page to choose. */
  readonly tab: SkillsTab | undefined;
  /** The search, as typed; `""` for none. */
  readonly query: string;
}

/** The Skills section's parameters in `search`. */
export const skillsParamsOf = (search: string): SkillsParams => {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");

  return { tab: isSkillsTab(tab) ? tab : undefined, query: params.get("q") ?? "" };
};

/** `params` as the Skills section's query (`?tab=…&q=…`), leaving out what is not named; `""` for none. */
export const skillsSearch = (params: Partial<SkillsParams> = {}): string => {
  const query = new URLSearchParams();

  if (params.tab !== undefined) query.set("tab", params.tab);

  if (params.query !== undefined && params.query !== "") query.set("q", params.query);

  return query.size === 0 ? "" : `?${query.toString()}`;
};

/** The Skills section of Scope `scope` showing `params`: `/settings/:scope/skills?tab=…&q=…`. */
export const skillsPath = (scope: string, params: Partial<SkillsParams> = {}): string =>
  `${settingsPath(scope, "skills")}${skillsSearch(params)}`;

/**
 * The page of a Skill directory's owner (a GitHub user or organization), its repos that hold Skills, in the Skills
 * section of Scope `scope`, where an install from it goes.
 */
export const skillOwnerPath = (scope: string, owner: string): string =>
  `${settingsPath(scope, "skills")}/${encodeURIComponent(owner)}`;

/** `?ref=<ref>` (the branch, tag or commit a repo's page shows), or `""` for the default branch. */
const refQuery = (ref: string | undefined): string =>
  ref === undefined || ref === "" ? "" : `?ref=${encodeURIComponent(ref)}`;

/** The page of a repo's Skills, at `ref` (a branch, tag or commit) when one is named, else the default branch. */
export const skillRepoPath = (scope: string, owner: string, repo: string, ref?: string): string =>
  `${skillOwnerPath(scope, owner)}/${encodeURIComponent(repo)}${refQuery(ref)}`;

/** What a Skill's page link names beyond the Skill: the ref, and the folder that holds the Skill. */
export interface SkillPageTarget {
  /** The branch, tag or commit; absent for the repo's default branch. */
  readonly ref?: string | undefined;
  /**
   * The folder (repo-relative, `""` for the repo's root) that holds the Skill: what makes the link exact when the Skill's
   * name in the path is not (two folders can share a folder name or declare one name). Absent when the link does not know it.
   */
  readonly path?: string | undefined;
}

/** The page of one Skill of a repo, at `target.ref` and in the folder `target.path` when they are named. */
export const skillPagePath = (
  scope: string,
  owner: string,
  repo: string,
  skill: string,
  { ref, path }: SkillPageTarget = {},
): string => {
  const query = new URLSearchParams();

  if (ref !== undefined && ref !== "") query.set("ref", ref);

  if (path !== undefined) query.set("path", path);

  return `${skillOwnerPath(scope, owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skill)}${query.size === 0 ? "" : `?${query.toString()}`}`;
};

/** What a repo's or a Skill's page names in its query. */
export interface SkillRepoParams {
  /** The branch, tag or commit to show; undefined (also for an empty `?ref=`) is the repo's default branch. */
  readonly ref: string | undefined;
  /**
   * The Skill page's folder (`?path=`): the folder that holds the Skill, `""` for the repo's root, undefined when the query
   * does not name one (the Skill is then found by the name in the path).
   */
  readonly path: string | undefined;
}

/** The repo and Skill pages' parameters in `search`. */
export const skillRepoParamsOf = (search: string): SkillRepoParams => {
  const params = new URLSearchParams(search);
  const ref = params.get("ref");

  return {
    ref: ref === null || ref === "" ? undefined : ref,
    path: params.get("path") ?? undefined,
  };
};

/** The old Skills page, or a page below it: an owner's, then a repo's, then a Skill's segment. */
const LEGACY_SKILLS_PAGE = /^\/skills((?:\/[^/]+){0,3})\/?$/;

/** The old Environments page. */
const LEGACY_ENVIRONMENTS_PAGE = /^\/environments\/?$/;

/**
 * Where an old page's address (`pathname` and `search`) is now on the Settings page, or undefined for any other address:
 * `/environments` is Global's Environments section; `/skills` (`?tab=`, `?q=`, `?environment=`) the Skills section of
 * the Scope `?environment=` named (`*` or none: Global); `/skills/:owner…` the same page of Global's Skill directory,
 * its query kept.
 */
export const legacyRedirect = (pathname: string, search: string): string | undefined => {
  if (LEGACY_ENVIRONMENTS_PAGE.test(pathname)) return settingsPath(GLOBAL_SCOPE, "environments");

  const skills = LEGACY_SKILLS_PAGE.exec(pathname);

  if (skills === null) return undefined;

  const below = skills[1] ?? "";

  if (below !== "") return `${settingsPath(GLOBAL_SCOPE, "skills")}${below}${search}`;

  const environment = new URLSearchParams(search).get("environment");

  return skillsPath(
    environment === null || environment === "" ? GLOBAL_SCOPE : environment,
    skillsParamsOf(search),
  );
};

/** Replace an old page's address in the history by its Settings page equivalent (`legacyRedirect`), if it is one. */
const settleLegacy = (): void => {
  const to = legacyRedirect(window.location.pathname, window.location.search);

  if (to !== undefined) window.history.replaceState(null, "", to);
};

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

/**
 * What the Settings page shows at its Scope: the list of its sections, a section by slug (which the page checks against
 * the sections the Scope has), or a page of the Skill directory below the Skills section.
 */
export type SettingsView =
  | { readonly kind: "index" }
  | { readonly kind: "section"; readonly section: string }
  | { readonly kind: "skillOwner"; readonly owner: string }
  | { readonly kind: "skillRepo"; readonly owner: string; readonly repo: string }
  | {
      readonly kind: "skill";
      readonly owner: string;
      readonly repo: string;
      readonly skill: string;
    };

/** What a page path shows. */
export type Page =
  | {
      readonly kind: "settings";
      /** `*` for Global, or an Environment's id (which may name none: the page says so). */
      readonly scope: string;
      readonly view: SettingsView;
    }
  | { readonly kind: "draft" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "subagent"; readonly sessionId: string; readonly agentId: string }
  | { readonly kind: "empty" };

/** The Settings page: a Scope, a section, and below the Skills section up to three segments of the Skill directory. */
const SETTINGS_PAGE = /^\/settings(?:\/([^/]+)(?:\/([^/]+)((?:\/[^/]+){0,3}))?)?\/?$/;

/** What the Settings page view below Scope segment `section` and the `below` segments (`/a/b`) shows, if anything. */
const settingsViewOf = (section: string | undefined, below: string): SettingsView | undefined => {
  if (section === undefined) return { kind: "index" };

  const name = decoded(section);

  if (name === undefined) return undefined;

  if (below === "") return { kind: "section", section: name };

  if (name !== "skills") return undefined;

  // `below` is one to three segments, each after a `/`.
  const segments = Arr.map(Arr.drop(below.split("/"), 1), decoded);

  if (!Arr.every(segments, (segment) => segment !== undefined)) return undefined;

  const [owner = "", repo, skill] = segments;

  if (repo === undefined) return { kind: "skillOwner", owner };

  return skill === undefined
    ? { kind: "skillRepo", owner, repo }
    : { kind: "skill", owner, repo, skill };
};

/** The Settings page `match` (of `SETTINGS_PAGE`) names; empty when a segment cannot be decoded. */
const settingsPageOf = (match: RegExpExecArray): Page => {
  const segment = match[1] ?? GLOBAL_SEGMENT;
  const scope = segment === GLOBAL_SEGMENT ? GLOBAL_SCOPE : decoded(segment);
  const view = settingsViewOf(match[2], match[3] ?? "");

  return scope === undefined || view === undefined
    ? { kind: "empty" }
    : { kind: "settings", scope, view };
};

/** What `path` shows. */
export const pageOf = (path: string): Page => {
  if (isDraftPath(path)) return { kind: "draft" };

  const settings = SETTINGS_PAGE.exec(path);

  if (settings !== null) return settingsPageOf(settings);

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

/** What the Skills section's query names now. */
export const skillsParamsAtom = Atom.map(searchAtom, skillsParamsOf);

/** What a repo's or a Skill's page names in its query now. */
export const skillRepoParamsAtom = Atom.map(searchAtom, skillRepoParamsOf);
