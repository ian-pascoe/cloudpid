// A repo's root `.gitattributes`, as Changes read it (docs/spec.md → Diffs and review → Changes): whether it has rules
// isomorphic-git ignores but git applies when it compares (`text`, `eol`, `binary`, `filter`), which send the repo to
// the Container's git, and the `linguist-generated` and `linguist-vendored` flags the web app folds files by. Only the
// root file is read. Patterns follow git's rules for `.gitattributes`: those of `.gitignore` without negation, where a
// pattern that names a directory matches nothing inside it (`dir/**` does).
// @effect-diagnostics preferEffectArray:off
import type * as Types from "effect/Types";

/** The attributes that change what git compares, and so need the Container's git. */
const COMPARED = new Set(["text", "eol", "binary", "filter"]);

/** A path's linguist flags: absent when the file says nothing of it. */
export type LinguistFlags = { readonly generated?: boolean; readonly vendored?: boolean };

export type RootAttributes = {
  /** The file has a `text`, `eol`, `binary` or `filter` rule (a macro's included). */
  readonly compares: boolean;
  /** `path`'s linguist flags (the last line that matches it and names a flag wins). */
  readonly linguist: (path: string) => LinguistFlags;
};

type Rule = {
  readonly match: (path: string) => boolean;
  readonly generated: boolean | null | undefined;
  readonly vendored: boolean | null | undefined;
};

const escapeRegExp = (text: string) => text.replaceAll(/[.+^${}()|\\]/g, "\\$&");

/** The regular expression of a glob's segment run (no `**` handling here): `*`, `?`, `[...]` and `\x`. */
const globBody = (glob: string): string => {
  let out = "";

  for (let at = 0; at < glob.length; at++) {
    const char = glob.charAt(at);

    if (char === "\\" && at + 1 < glob.length) {
      out += escapeRegExp(glob.charAt(++at));
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const close = glob.indexOf("]", at + 2);

      if (close === -1) {
        out += "\\[";
      } else {
        const inner = glob.slice(at + 1, close);

        out += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`.replaceAll("\\", "\\\\");
        at = close;
      }
    } else {
      out += escapeRegExp(char);
    }
  }

  return out;
};

/** A matcher of repo-relative paths for `pattern`, or undefined for one that can match no file. */
const compile = (pattern: string): ((path: string) => boolean) | undefined => {
  if (pattern === "" || pattern.endsWith("/")) return undefined;

  // No slash: the pattern is a name, at any depth.
  if (!pattern.includes("/")) {
    const name = new RegExp(`^${globBody(pattern)}$`);

    return (path) => name.test(path.slice(path.lastIndexOf("/") + 1));
  }

  const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const parts = anchored.split("/");
  let source = "";

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    const last = index === parts.length - 1;

    if (part === "**") {
      // `**/x`: any directories, none too; `x/**`: everything inside.
      source += last ? ".*" : "(?:[^/]*/)*";
    } else {
      source += globBody(part) + (last ? "" : "/");
    }
  }

  const full = new RegExp(`^${source}$`);

  return (path) => full.test(path);
};

/** The pattern at the start of `line`, unquoted, and the rest of the line. */
const splitPattern = (line: string): readonly [string, string] => {
  if (!line.startsWith('"')) {
    const space = line.search(/\s/);

    return space === -1 ? [line, ""] : [line.slice(0, space), line.slice(space)];
  }

  let pattern = "";

  for (let at = 1; at < line.length; at++) {
    const char = line.charAt(at);

    if (char === '"') return [pattern, line.slice(at + 1)];

    if (char === "\\" && at + 1 < line.length) {
      const next = line.charAt(++at);

      pattern += ESCAPES.get(next) ?? next;
    } else {
      pattern += char;
    }
  }

  return [pattern, ""];
};

/** What a backslash and the letter after it stand for in a quoted pattern; any other letter stands for itself. */
const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
]);

/** A flag's state on one line: true, false, null (`!name`: unspecified again), or undefined (not named). */
const flag = (tokens: readonly string[], name: string): boolean | null | undefined => {
  let state: boolean | null | undefined;

  for (const token of tokens) {
    if (token === name || token === `${name}=true`) state = true;
    else if (token === `-${name}` || token === `${name}=false`) state = false;
    else if (token === `!${name}`) state = null;
  }

  return state;
};

/** The name a token sets, whatever it sets it to. */
const nameOf = (token: string) => token.replace(/^[-!]/, "").replace(/=.*$/, "");

/** Read a repo's root `.gitattributes` (`undefined`: it has none). */
export const readAttributes = (text: string | undefined): RootAttributes => {
  const rules: Rule[] = [];
  let compares = false;

  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) continue;

    const [pattern, rest] = splitPattern(line);
    const tokens = rest.trim().split(/\s+/).filter((token) => token !== "");

    if (tokens.some((token) => COMPARED.has(nameOf(token)))) compares = true;

    // A macro's definition sets nothing on a path.
    if (pattern.startsWith("[attr]")) continue;

    const match = compile(pattern);
    const generated = flag(tokens, "linguist-generated");
    const vendored = flag(tokens, "linguist-vendored");

    if (match !== undefined && (generated !== undefined || vendored !== undefined)) {
      rules.push({ match, generated, vendored });
    }
  }

  return {
    compares,
    linguist: (path) => {
      let generated: boolean | null | undefined;
      let vendored: boolean | null | undefined;

      for (const rule of rules) {
        if (!rule.match(path)) continue;

        if (rule.generated !== undefined) generated = rule.generated;

        if (rule.vendored !== undefined) vendored = rule.vendored;
      }

      const flags: Types.Mutable<LinguistFlags> = {};

      if (generated === true || generated === false) flags.generated = generated;

      if (vendored === true || vendored === false) flags.vendored = vendored;

      return flags;
    },
  };
};
