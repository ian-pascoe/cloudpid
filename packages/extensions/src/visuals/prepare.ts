// docs/architecture/visuals.md → Tools (visual_show: Fails, Warns), The copy (Sources, Inlining, Secrets, Bounds), Network and
// isolation (Speed bumps). The preparation of a show: a `path` (a file of the calling conversation's Workspace) or an `html`
// argument becomes the copy the Session keeps: one document, its local stylesheets and single-file scripts inlined, redacted
// of the Session's held Secrets, then its local images inlined as `data:` URLs, its static resource hints stripped, at most
// 2 MiB of UTF-8. It fails only when nothing faithful can show, and warns of the rest. The page is read as text with regular
// expressions, not parsed: what it notices is guidance and speed bumps, never a boundary (the frame's CSP is the boundary).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- string passes over a page.
import {
  isVisualHost,
  MAX_VISUAL_ASSET_BYTES,
  MAX_VISUAL_BYTES,
  MAX_VISUAL_SUMMARY,
  MAX_VISUAL_TITLE,
  type VisualSource,
  type VisualWarning,
  type VisualWarningKind,
  visualSizeText,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { secretReference } from "../secrets/references.ts";

/** A file as the preparation reads it from the Workspace. */
export type VisualFile =
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "missing" }
  /** A directory, or a device or special file (`/dev`, `/proc`, `/sys`), which is never read. */
  | { readonly kind: "not_file" }
  /** Over the bound it was read with, by its size before reading: it was not read. */
  | { readonly kind: "too_large"; readonly size: number }
  | { readonly kind: "unreadable"; readonly message: string };

/** The calling conversation's Workspace, as the preparation reads it. */
export type VisualFiles = {
  /** `path` as an absolute path of the Workspace (relative to the conversation's working directory); none when it is not one. */
  readonly absolute: (path: string) => Effect.Effect<string | undefined>;
  /**
   * The regular file at `path`, read only once its size (a link's target's) is known to be at most `max` bytes: a larger
   * one, or one that is not a regular file, is never read.
   */
  readonly read: (path: string, max: number) => Effect.Effect<VisualFile>;
};

/** Why an asset that was not read was left out, by what its read found. */
const ASSET_UNREAD = {
  missing: "does not exist",
  not_file: "is not a regular file",
  unreadable: "could not be read",
} as const;

/** Whether `path` is under a directory of devices or kernel files, whose "files" are never a page's (`/dev/zero` never ends). */
export const isSpecialPath = (path: string): boolean => /^\/(?:dev|proc|sys)(?:\/|$)/.test(path);

/** What `visual_show` was called with. */
export type VisualShowInput = {
  readonly path?: string | undefined;
  readonly html?: string | undefined;
  readonly title: string;
  readonly summary: string;
};

/** Why a show failed, as telemetry counts it (never its text). */
export const VISUAL_FAILURE_KINDS = [
  "no_source",
  "two_sources",
  "no_workspace",
  "missing",
  "unreadable",
  "not_utf8",
  "empty",
  "too_large",
  "viewport_units",
  "bad_title",
  "bad_summary",
  "secrets_unavailable",
  "not_kept",
] as const;

export type VisualFailureKind = (typeof VISUAL_FAILURE_KINDS)[number];

/** A show that could not show anything faithful: nothing is kept, and the model is told why. */
export class VisualShowError extends Schema.TaggedError<
  VisualShowError,
  { readonly brand: unique symbol }
>()("VisualShowError", { kind: Schema.String, message: Schema.String }) {}

const fail = (kind: VisualFailureKind, message: string) =>
  Effect.fail(VisualShowError.make({ kind, message }));

/** What the preparation did, in counts only, for the span. */
export type VisualCounts = {
  readonly images: number;
  readonly stylesheets: number;
  readonly scripts: number;
  readonly secrets: number;
  readonly hints: number;
};

export type PreparedVisual = {
  readonly title: string;
  readonly summary: string;
  readonly source: VisualSource;
  readonly html: string;
  readonly bytes: number;
  readonly warnings: ReadonlyArray<VisualWarning>;
  readonly counts: VisualCounts;
};

/** `text`'s UTF-8 bytes. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const sizeOf = visualSizeText;

// ---------------------------------------------------------------------------------------------------------------------
// Paths

/** A POSIX path with `.` and `..` resolved; never above the root. */
const normalize = (path: string): string => {
  const parts: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return `/${parts.join("/")}`;
};

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** Whether `reference` names a file beside the page (no scheme, no `//host`, no fragment-only or empty reference). */
const isLocal = (reference: string): boolean =>
  reference !== "" &&
  !reference.startsWith("#") &&
  !reference.startsWith("//") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(reference);

/** The absolute path a local `reference` names, from the file it is in: absolute, or relative to that file's directory. */
const resolveFrom = (file: string, reference: string): string => {
  const bare = reference.split(/[?#]/, 1)[0] ?? reference;
  const decoded = safeDecode(bare);

  return normalize(decoded.startsWith("/") ? decoded : `${directoryOf(file)}/${decoded}`);
};

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// Reading

const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);

    return text;
  } catch {
    return undefined;
  }
};

/** The value of attribute `name` in the tag text `tag`, unquoted; none when it has no such attribute. */
const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);

  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
};

/** The images a page inlines, by extension: PNG, JPEG, WebP, GIF and SVG. */
const IMAGE_TYPES = [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
] as const;

const imageMime = (path: string): string | undefined => {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  return IMAGE_TYPES.find(([each]) => each === extension)?.[1];
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(binary);
};

// ---------------------------------------------------------------------------------------------------------------------
// Checks

/** Viewport-height units in CSS: `100vh`, `50svh`, `.5dvh`, `-10lvh`. */
const VIEWPORT_HEIGHT = /(?<![\w-])-?(?:\d+\.?\d*|\.\d+)(?:s|l|d)?vh\b/i;

/**
 * Whether the page's own CSS uses viewport-height units, `url()`s set aside: a `data:` URL's base64 (`+12VH/`) or a file
 * name is no unit.
 */
const usesViewportHeight = (html: string): boolean =>
  ownCss(html).some((css) =>
    VIEWPORT_HEIGHT.test(css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, "url()")),
  );

/** The page's own CSS: its `<style>` blocks and `style` attributes. */
const ownCss = (html: string): ReadonlyArray<string> => [
  ...Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi), (match) => match[1] ?? ""),
  ...Array.from(
    html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
    (match) => match[1] ?? match[2] ?? "",
  ),
];

/** The page's inline scripts' text (an import map and JSON included, which hold no calls). */
const scriptTexts = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => match[1] ?? "");

const NETWORK_CALL =
  /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bEventSource\s*\(|\bsendBeacon\s*\(/;

/** A module's import of a file beside it (`import x from "./x.js"`, `import("../y.js")`): a module graph. */
const RELATIVE_IMPORT = /\bimport\b[^;]*?["'`]\.{1,2}\//;

/** A touch listener the page adds without `passive: true`. */
const activeTouchListener = (script: string): boolean =>
  Array.from(
    script.matchAll(/addEventListener\s*\(\s*["'`]touch(?:start|move)["'`]([^;]*)/g),
    (match) => match[1] ?? "",
  ).some((rest) => !/passive\s*:\s*true/.test(rest));

/** The hosts of the resources a page loads that are not on the list: tags' `src`/`href` and CSS `url()` and `@import`. */
const unlistedHosts = (html: string): ReadonlyArray<string> => {
  const hosts = new Set<string>();

  const note = (reference: string) => {
    const absolute = reference.startsWith("//") ? `https:${reference}` : reference;

    if (!/^https?:\/\//i.test(absolute)) return;

    try {
      const url = new URL(absolute);

      if (url.protocol !== "https:" || !isVisualHost(url.hostname)) hosts.add(url.host);
    } catch {
      // Not a URL: nothing loads from it.
    }
  };

  for (const tag of html.matchAll(
    /<(?:script|link|img|source|video|audio|track|embed|object|image|use)\b[^>]*>/gi,
  )) {
    const text = tag[0];
    const isLink = /^<link\b/i.test(text);
    // A link that only names a page (`rel="canonical"`, a hint that is stripped) loads nothing.
    const rel = attribute(text, "rel")?.toLowerCase() ?? "";

    if (isLink && !/stylesheet|icon|preload|modulepreload|manifest/.test(rel)) continue;

    for (const name of ["src", "href", "xlink:href", "data", "poster"]) {
      const value = attribute(text, name);

      if (value !== undefined) note(value.trim());
    }
  }

  for (const css of ownCss(html)) {
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
      note((match[1] ?? match[2] ?? match[3] ?? "").trim());
    }

    for (const match of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
      note((match[1] ?? match[2] ?? "").trim());
    }
  }

  for (const script of scriptTexts(html)) {
    for (const match of script.matchAll(
      /\bimport\s*(?:[^"'`;]*?\bfrom\s*)?\(?\s*["'`]([^"'`]+)["'`]/g,
    )) {
      note((match[1] ?? "").trim());
    }
  }

  return Array.from(hosts);
};

/** Static resource hints that reach a host before any script runs (`preconnect`, `dns-prefetch`, `prerender`, `prefetch`). */
const RESOURCE_HINT =
  /<link\b[^>]*\srel\s*=\s*["']?[^"'>]*\b(?:preconnect|dns-prefetch|prerender|prefetch)\b[^>]*>/gi;

const isDocument = (html: string): boolean => /<html[\s>]|<!doctype\s/i.test(html);

const wrapped = (fragment: string): string =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>\n${fragment}\n</body></html>`;

/** Text that may sit inside a `<script>` or `<style>` without closing it early. */
const escapeClose = (text: string, tag: "script" | "style"): string =>
  text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

// ---------------------------------------------------------------------------------------------------------------------
// The preparation

export type PrepareOptions = {
  /** The calling conversation's Workspace; none when it has no environment, and a `path` fails. */
  readonly files: VisualFiles | undefined;
  /** `text` with every Secret the Session holds replaced by its reference. */
  readonly redact: (text: string) => string;
  /** The values of the Secrets the Session holds: a binary image that holds one's bytes is left out, never kept. */
  readonly secretValues: ReadonlyArray<string>;
};

/** Whether `bytes` hold `needle` anywhere. */
const holds = (bytes: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0 || needle.length > bytes.length) return false;

  const first = needle[0];

  for (let at = bytes.indexOf(first ?? 0); at !== -1; at = bytes.indexOf(first ?? 0, at + 1)) {
    if (at + needle.length > bytes.length) return false;

    let same = true;

    for (let index = 1; index < needle.length; index++) {
      if (bytes[at + index] !== needle[index]) {
        same = false;
        break;
      }
    }

    if (same) return true;
  }

  return false;
};

/** How many Secret References `text` holds, by their opening. */
const referenceCount = (text: string): number => {
  const open = secretReference("").slice(0, -2);

  return text.split(open).length - 1;
};

/**
 * The copy `visual_show` keeps for `input` (`docs/architecture/visuals.md` → The copy), or why there is none. A `path` is
 * read from the Workspace and its local assets inlined; an `html` page is taken as it is (its references are the agent's to
 * make absolute or inline). Both are wrapped into a document when they are a fragment, redacted, checked and bounded.
 */
export const prepareVisual = (
  input: VisualShowInput,
  options: PrepareOptions,
): Effect.Effect<PreparedVisual, VisualShowError> =>
  Effect.gen(function* () {
    const warnings: VisualWarning[] = [];

    const warn = (kind: VisualWarningKind, message: string) => {
      warnings.push({ kind, message });
    };

    const counts = { images: 0, stylesheets: 0, scripts: 0, secrets: 0, hints: 0 };

    /** `text` redacted, counting the Secrets it held. */
    const redactCounting = (text: string): string => {
      const redacted = options.redact(text);

      counts.secrets += Math.max(0, referenceCount(redacted) - referenceCount(text));

      return redacted;
    };

    // The title and summary are shown and exported wherever the page is not, so they are redacted as the page is, and
    // bounded as they are kept: a Secret's reference may be longer than its value.
    const title = redactCounting(input.title.trim());
    const summary = redactCounting(input.summary.trim());

    const redactedNote = (text: string, original: string) =>
      text === original.trim() ? "" : " with its Secrets replaced by their references";

    if (title === "" || title.length > MAX_VISUAL_TITLE) {
      return yield* fail(
        "bad_title",
        `title must be 1 to ${MAX_VISUAL_TITLE} characters; it is ${title.length}${redactedNote(title, input.title)}`,
      );
    }

    if (summary === "" || summary.length > MAX_VISUAL_SUMMARY) {
      return yield* fail(
        "bad_summary",
        `summary must be 1 to ${MAX_VISUAL_SUMMARY} characters; it is ${summary.length}${redactedNote(summary, input.summary)}: it stands for the page wherever it is not rendered`,
      );
    }

    const hasPath = input.path !== undefined && input.path.trim() !== "";

    const hasHtml = input.html !== undefined;

    if (hasPath && hasHtml)
      return yield* fail("two_sources", "Give exactly one of path or html, not both");

    if (!hasPath && !hasHtml) return yield* fail("no_source", "Give exactly one of path or html");

    let source: VisualSource = { kind: "inline" };
    let html = input.html ?? "";
    let file: string | undefined;
    const files = options.files;

    if (hasPath) {
      if (files === undefined) {
        return yield* fail(
          "no_workspace",
          "This conversation has no Workspace to read a path from: pass html",
        );
      }

      const absolute = yield* files.absolute(input.path?.trim() ?? "");

      if (absolute === undefined) {
        return yield* fail("missing", `${input.path} is not a path in this Workspace`);
      }

      const read = yield* files.read(absolute, MAX_VISUAL_BYTES);

      if (read.kind === "missing") return yield* fail("missing", `${absolute} does not exist`);

      if (read.kind === "not_file") {
        return yield* fail("unreadable", `${absolute} is not a regular file`);
      }

      if (read.kind === "too_large") {
        return yield* fail(
          "too_large",
          `${absolute} is ${sizeOf(read.size)}, over the ${sizeOf(MAX_VISUAL_BYTES)} a Visual may be`,
        );
      }

      if (read.kind === "unreadable") {
        return yield* fail("unreadable", `${absolute} could not be read: ${read.message}`);
      }

      const text = decodeUtf8(read.bytes);

      if (text === undefined) return yield* fail("not_utf8", `${absolute} is not UTF-8 text`);

      html = text;
      file = absolute;
      source = { kind: "path", path: absolute };
    }

    if (html.trim() === "") return yield* fail("empty", "The page is empty");

    if (!isDocument(html)) {
      html = wrapped(html);
      warn(
        "wrapped",
        "The page was a fragment, so it was wrapped into a document; write a whole <!doctype html> page",
      );
    }

    /** The bytes of every asset read so far, which may not pass the page's own bound: what is read is held. */
    let assetBytes = 0;

    /**
     * The local asset `reference` names, at its resolved `path`, read from the page's Workspace, or a warning that it is
     * missing or too large. Each kind of asset keeps what it makes of a file, by its resolved path, never the file's bytes,
     * so a file the page names many times is read, and warned of, once; and the show fails once the files it has read come
     * to more than a page may be.
     */
    const asset = (reference: string, path: string) =>
      Effect.gen(function* () {
        if (files === undefined) return undefined;

        const read = yield* files.read(path, MAX_VISUAL_ASSET_BYTES);

        if (read.kind === "too_large") {
          warn(
            "asset_too_large",
            `${reference} is ${sizeOf(read.size)}, over the ${sizeOf(MAX_VISUAL_ASSET_BYTES)} an asset may be: it was left out`,
          );

          return undefined;
        }

        if (read.kind !== "file") {
          warn(
            "asset_missing",
            `${reference} (${path}) ${ASSET_UNREAD[read.kind]}: it was left out`,
          );

          return undefined;
        }

        assetBytes += read.bytes.length;

        if (assetBytes > MAX_VISUAL_BYTES) {
          return yield* fail(
            "too_large",
            `The files the page names come to over the ${sizeOf(MAX_VISUAL_BYTES)} a Visual may be`,
          );
        }

        return read.bytes;
      });

    /** What each kind of asset made of a file, by its resolved path: none when it was left out. */
    const made = () => new Map<string, string | undefined>();

    /** `make` of the asset `reference` names, made once for each resolved path; none for a reference that is not local. */
    const once = (
      cache: Map<string, string | undefined>,
      reference: string,
      make: (bytes: Uint8Array, path: string) => string | undefined,
    ) =>
      Effect.gen(function* () {
        if (file === undefined || !isLocal(reference)) return undefined;

        const path = resolveFrom(file, reference);

        if (cache.has(path)) return cache.get(path);

        const bytes = yield* asset(reference, path);
        const product = bytes === undefined ? undefined : make(bytes, path);

        cache.set(path, product);

        return product;
      });

    /** `bytes` as UTF-8 text, or a warning that the asset was left out for not being text. */
    const textOf = (reference: string, bytes: Uint8Array): string | undefined => {
      const text = decodeUtf8(bytes);

      if (text === undefined)
        warn("asset_missing", `${reference} is not UTF-8 text: it was left out`);

      return text;
    };

    /** The page has grown past its bound while its assets were inlined: no more is read or built. */
    const overBound = () =>
      fail(
        "too_large",
        `The page is over the ${sizeOf(MAX_VISUAL_BYTES)} a Visual may be after inlining`,
      );

    /**
     * `text` with each match of `pattern` replaced by what `replace` gives (its own text when it gives none), in order. It
     * fails as soon as what it has built passes the page's bound: a string's length never exceeds its UTF-8 bytes, so a
     * page this stops is over it, and one it lets through is measured exactly at the end.
     */
    const replaceEach = (
      text: string,
      pattern: RegExp,
      replace: (match: RegExpExecArray) => Effect.Effect<string | undefined, VisualShowError>,
    ) =>
      Effect.gen(function* () {
        let out = "";
        let last = 0;

        for (const match of text.matchAll(pattern)) {
          const replaced = yield* replace(match);

          out += text.slice(last, match.index) + (replaced ?? match[0]);
          last = match.index + match[0].length;

          if (out.length > MAX_VISUAL_BYTES) return yield* overBound();
        }

        const built = out + text.slice(last);

        if (built.length > MAX_VISUAL_BYTES) return yield* overBound();

        return built;
      });

    if (file !== undefined) {
      const stylesheets = made();
      const scripts = made();

      // Stylesheets first: their `url()`s are made absolute from the stylesheet's own place, for the images after.
      html = yield* replaceEach(html, /<link\b[^>]*>/gi, (match) =>
        Effect.gen(function* () {
          const tag = match[0];

          if (!/\bstylesheet\b/i.test(attribute(tag, "rel") ?? "")) return undefined;

          const href = attribute(tag, "href");

          if (href === undefined) return undefined;

          return yield* once(stylesheets, href, (bytes, path) => {
            const css = textOf(href, bytes);

            if (css === undefined) return undefined;

            const located = css.replace(
              /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi,
              (whole, a?: string, b?: string, c?: string) => {
                const reference = (a ?? b ?? c ?? "").trim();

                return isLocal(reference) ? `url("${resolveFrom(path, reference)}")` : whole;
              },
            );

            counts.stylesheets += 1;

            return `<style>${escapeClose(located, "style")}</style>`;
          });
        }),
      );

      html = yield* replaceEach(
        html,
        /<script\b([^>]*)\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script\s*>/gi,
        (match) =>
          Effect.gen(function* () {
            const reference = match[2] ?? match[3] ?? match[4] ?? "";

            const script = yield* once(scripts, reference, (bytes) => {
              const text = textOf(reference, bytes);

              if (text !== undefined) counts.scripts += 1;

              return text === undefined ? undefined : escapeClose(text, "script");
            });

            if (script === undefined) return undefined;

            return `<script${match[1] ?? ""}${match[5] ?? ""}>${script}</script>`;
          }),
      );
    }

    // Checked on the page's own CSS before images are inlined: a `data:` URL's base64 is no unit.
    if (usesViewportHeight(html)) {
      return yield* fail(
        "viewport_units",
        "The page's CSS uses viewport-height units (vh, svh, lvh, dvh): the frame fits its height to the content, so they would loop or mislead; use content height, or a fixed height in px",
      );
    }

    // Redacted before the images are inlined: a Secret is text, and a `data:` URL is not read for one. An SVG is text, and
    // is redacted before it is inlined; a binary image that holds a Secret's bytes is left out.
    html = redactCounting(html);

    const secretBytes = options.secretValues
      .filter((value) => value !== "")
      .map((value) => new TextEncoder().encode(value));

    let imagesDropped = 0;

    if (file !== undefined) {
      /** Each image's `data:` URL, by its resolved path: built, and redacted or left out, once however often it is named. */
      const images = made();

      const inlineImage = (reference: string) => {
        const mime = imageMime(reference.split(/[?#]/, 1)[0] ?? reference);

        return mime === undefined
          ? Effect.undefined
          : once(images, reference, (read) => {
              let bytes = read;

              if (mime === "image/svg+xml") {
                const text = decodeUtf8(bytes);

                if (text === undefined) {
                  warn("asset_missing", `${reference} is not an SVG in UTF-8: it was left out`);

                  return undefined;
                }

                bytes = new TextEncoder().encode(redactCounting(text));
              } else if (secretBytes.some((secret) => holds(bytes, secret))) {
                imagesDropped += 1;
                counts.secrets += 1;

                return undefined;
              }

              counts.images += 1;

              return `data:${mime};base64,${base64(bytes)}`;
            });
      };

      html = yield* replaceEach(html, /<img\b[^>]*>/gi, (match) =>
        Effect.gen(function* () {
          const tag = match[0];
          const src = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);

          if (src === null) return undefined;

          const data = yield* inlineImage((src[2] ?? src[3] ?? src[4] ?? "").trim());

          return data === undefined ? undefined : tag.replace(src[0], `${src[1]}"${data}"`);
        }),
      );

      html = yield* replaceEach(html, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (match) =>
        Effect.map(inlineImage((match[1] ?? match[2] ?? match[3] ?? "").trim()), (data) =>
          data === undefined ? undefined : `url("${data}")`,
        ),
      );
    }

    if (counts.secrets > 0) {
      warn(
        "secrets_replaced",
        imagesDropped > 0
          ? `The page held a Secret's value, replaced by its reference in the copy, and ${imagesDropped === 1 ? "an image that held one was" : `${imagesDropped} images that held one were`} left out: never put Secrets in a Visual`
          : "The page held a Secret's value, replaced by its reference in the copy: never put Secrets in a Visual",
      );
    }

    // A speed bump: a static hint reaches its host before any script runs, and the CSP does not govern it.
    html = html.replace(RESOURCE_HINT, () => {
      counts.hints += 1;

      return "";
    });

    for (const host of unlistedHosts(html)) {
      warn(
        "host_not_listed",
        `${host} is not on the list (https://cdnjs.cloudflare.com, https://fonts.googleapis.com, https://fonts.gstatic.com): what the page loads from it will not load`,
      );
    }

    const scripts = scriptTexts(html);

    if (scripts.some((script) => NETWORK_CALL.test(script))) {
      warn(
        "network",
        "The page's scripts make network calls (fetch, XHR, WebSocket, EventSource), which the frame blocks: embed the data in the page",
      );
    }

    if (scripts.some((script) => RELATIVE_IMPORT.test(script))) {
      warn(
        "module_graph",
        "A module script imports a relative module, which is not inlined or served: bundle it into one file, or import from the list",
      );
    }

    if (/<(?:iframe|form)\b/i.test(html)) {
      warn("frame_or_form", "The page has an <iframe> or a <form>, which the frame blocks");
    }

    if (
      ownCss(html).some((css) => /touch-action|overscroll-behavior/i.test(css)) ||
      scripts.some(activeTouchListener)
    ) {
      warn(
        "touch",
        "The page sets touch-action or overscroll-behavior, or a non-passive touch listener: on a phone it can trap the chat's scrolling, so keep them to where a gesture needs them",
      );
    }

    const bytes = utf8Bytes(html);

    if (bytes > MAX_VISUAL_BYTES) {
      return yield* fail(
        "too_large",
        `The page is ${sizeOf(bytes)} after inlining, over the ${sizeOf(MAX_VISUAL_BYTES)} a Visual may be`,
      );
    }

    return { title, summary, source, html, bytes, warnings, counts };
  });
