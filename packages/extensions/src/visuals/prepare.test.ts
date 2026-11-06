// docs/architecture/visuals.md → Testing: the preparation of a show. A `path` or `html` page becomes a redacted, inlined, bounded
// copy, failing only when nothing faithful can show (visuals.md → Tools: Fails) and warning of the rest (Warns).
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off -- fixtures over native maps; vitest awaits.
import { MAX_VISUAL_BYTES } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { secretReference } from "../secrets/references.ts";
import { prepareVisual, type VisualFiles, type VisualShowInput } from "./prepare.ts";

const SECRET = "hunter2-very-secret";

/** A Workspace of `files` (a string is UTF-8 text), whose working directory is `/workspace/repo`. */
const workspace = (files: Record<string, string | Uint8Array>): VisualFiles => ({
  absolute: (path) =>
    Effect.succeed(path.startsWith("/") ? path : `/workspace/repo/${path.replace(/^\.\//, "")}`),
  read: (path) =>
    Effect.sync(() => {
      const found = files[path];

      if (found === undefined) return { kind: "missing" as const };

      return {
        kind: "file" as const,
        bytes: found instanceof Uint8Array ? found : new TextEncoder().encode(found),
      };
    }),
});

const redact = (text: string) => text.replaceAll(SECRET, secretReference("TOKEN"));

const show = (input: Partial<VisualShowInput>, files: Record<string, string | Uint8Array> = {}) =>
  Effect.runPromise(
    prepareVisual(
      { title: "Chart", summary: "Sales by month", ...input },
      { files: workspace(files), redact },
    ),
  );

const failure = async (
  input: Partial<VisualShowInput>,
  files: Record<string, string | Uint8Array> = {},
) => {
  const exit = await Effect.runPromiseExit(
    prepareVisual(
      { title: "Chart", summary: "Sales by month", ...input },
      { files: workspace(files), redact },
    ),
  );

  if (Exit.isSuccess(exit)) throw new Error("The show did not fail");

  const error = Cause.findErrorOption(exit.cause);

  return Option.getOrUndefined(error);
};

const kinds = (warnings: ReadonlyArray<{ readonly kind: string }>) =>
  warnings.map((warning) => warning.kind);

const PAGE = "<!doctype html><html><head></head><body><p>Hi</p></body></html>";

describe("what a show fails on", () => {
  it("needs exactly one source", async () => {
    expect(await failure({})).toMatchObject({ kind: "no_source" });
    expect(await failure({ path: "a.html", html: PAGE })).toMatchObject({ kind: "two_sources" });
  });

  it("fails on a file that is missing or not UTF-8, and on an empty page", async () => {
    expect(await failure({ path: "gone.html" })).toMatchObject({
      kind: "missing",
      message: "/workspace/repo/gone.html does not exist",
    });
    expect(
      await failure(
        { path: "bad.html" },
        { "/workspace/repo/bad.html": Uint8Array.of(0xff, 0xfe, 0x00) },
      ),
    ).toMatchObject({ kind: "not_utf8" });
    expect(await failure({ html: "   \n" })).toMatchObject({ kind: "empty" });
  });

  it("fails on a path with no Workspace to read it from", async () => {
    const exit = await Effect.runPromiseExit(
      prepareVisual({ path: "a.html", title: "t", summary: "s" }, { files: undefined, redact }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails on viewport-height units in the page's own CSS, and not in its text", async () => {
    for (const css of ["height: 100vh", "min-height:50svh", "top: .5dvh", "height: -10lvh"]) {
      expect(
        await failure({ html: `<!doctype html><style>main { ${css} }</style><main></main>` }),
      ).toMatchObject({ kind: "viewport_units" });
    }

    expect(
      await failure({ html: `<!doctype html><div style="height: 80vh"></div>` }),
    ).toMatchObject({
      kind: "viewport_units",
    });

    const prose = await show({ html: "<!doctype html><p>Use 100vh with care.</p>" });

    expect(prose.warnings).toEqual([]);
  });

  it("fails on a page over 2 MiB after inlining", async () => {
    const half = "x".repeat(MAX_VISUAL_BYTES / 2);

    expect(await failure({ html: `<!doctype html><p>${half}</p><p>${half}</p>` })).toMatchObject({
      kind: "too_large",
    });
  });

  it("fails on a bad title or summary", async () => {
    expect(await failure({ html: PAGE, title: " " })).toMatchObject({ kind: "bad_title" });
    expect(await failure({ html: PAGE, title: "t".repeat(201) })).toMatchObject({
      kind: "bad_title",
    });
    expect(await failure({ html: PAGE, summary: "" })).toMatchObject({ kind: "bad_summary" });
    expect(await failure({ html: PAGE, summary: "s".repeat(301) })).toMatchObject({
      kind: "bad_summary",
    });
  });
});

describe("the copy of a path", () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

  it("is the file as shown, with its stylesheets, scripts and images inlined", async () => {
    const shown = await show(
      { path: "out/page.html" },
      {
        "/workspace/repo/out/page.html": [
          "<!doctype html><html><head>",
          '<link rel="stylesheet" href="style.css">',
          '<script src="./app.js"></script>',
          "</head><body>",
          '<img src="img/logo.png" alt="Logo">',
          '<img src="/workspace/shared/a.png" alt="A">',
          "</body></html>",
        ].join(""),
        "/workspace/repo/out/style.css": "body { background: url(bg/dots.png) }",
        "/workspace/repo/out/bg/dots.png": PNG,
        "/workspace/repo/out/app.js": "document.title = '</script>';",
        "/workspace/repo/out/img/logo.png": PNG,
        "/workspace/shared/a.png": PNG,
      },
    );

    expect(shown.source).toEqual({ kind: "path", path: "/workspace/repo/out/page.html" });
    expect(shown.html).toBe(
      [
        "<!doctype html><html><head>",
        '<style>body { background: url("data:image/png;base64,iVBORw==") }</style>',
        "<script>document.title = '<\\/script>';</script>",
        "</head><body>",
        '<img src="data:image/png;base64,iVBORw==" alt="Logo">',
        '<img src="data:image/png;base64,iVBORw==" alt="A">',
        "</body></html>",
      ].join(""),
    );
    expect(shown.counts).toMatchObject({ images: 3, stylesheets: 1, scripts: 1 });
    expect(shown.warnings).toEqual([]);
    expect(shown.bytes).toBe(new TextEncoder().encode(shown.html).length);
  });

  it("warns of a local asset that is missing or too large, and shows the page all the same", async () => {
    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html": '<!doctype html><img src="gone.png"><img src="big.png">',
        "/workspace/repo/big.png": new Uint8Array(1024 * 1024 + 1),
      },
    );

    expect(kinds(shown.warnings)).toEqual(["asset_missing", "asset_too_large"]);
    expect(shown.html).toContain('<img src="gone.png">');
  });

  it("reports a module graph, not resolving it", async () => {
    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html": '<!doctype html><script type="module" src="main.js"></script>',
        "/workspace/repo/main.js": 'import { draw } from "./draw.js"; draw();',
      },
    );

    expect(kinds(shown.warnings)).toEqual(["module_graph"]);
  });
});

describe("what a show warns of", () => {
  it("redacts the Session's Secrets before images are inlined, and says so", async () => {
    const shown = await show({ html: `<!doctype html><p>token ${SECRET}</p>` });

    expect(shown.html).not.toContain(SECRET);
    expect(shown.html).toContain(secretReference("TOKEN"));
    expect(shown.counts.secrets).toBe(1);
    expect(kinds(shown.warnings)).toEqual(["secrets_replaced"]);
  });

  it("wraps a fragment into a document", async () => {
    const shown = await show({ html: "<svg><title>Chart</title></svg>" });

    expect(shown.html).toMatch(/^<!doctype html>/);
    expect(shown.html).toContain("<svg><title>Chart</title></svg>");
    expect(kinds(shown.warnings)).toEqual(["wrapped"]);
  });

  it("warns of a host not on the list, and not of the list's", async () => {
    const shown = await show({
      html: [
        "<!doctype html>",
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.2/d3.min.js"></script>',
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
        '<script src="https://cdn.jsdelivr.net/npm/x"></script>',
        '<img src="http://cdnjs.cloudflare.com/x.png">',
        '<a href="https://example.com">a link loads nothing</a>',
      ].join(""),
    });

    expect(shown.warnings.map((warning) => warning.message.split(" ")[0])).toEqual([
      "cdn.jsdelivr.net",
      "cdnjs.cloudflare.com",
    ]);
    expect(kinds(shown.warnings)).toEqual(["host_not_listed", "host_not_listed"]);
  });

  it("warns of network calls, frames and forms, and touch handling", async () => {
    const shown = await show({
      html: [
        "<!doctype html>",
        "<script>fetch('/data.json')</script>",
        "<iframe></iframe>",
        '<div style="touch-action: none"></div>',
      ].join(""),
    });

    expect(kinds(shown.warnings)).toEqual(["network", "frame_or_form", "touch"]);

    const passive = await show({
      html: "<!doctype html><script>el.addEventListener('touchmove', f, { passive: true });</script>",
    });

    expect(passive.warnings).toEqual([]);

    const active = await show({
      html: "<!doctype html><script>el.addEventListener('touchstart', f);</script>",
    });

    expect(kinds(active.warnings)).toEqual(["touch"]);
  });

  it("strips static resource hints", async () => {
    const shown = await show({
      html: '<!doctype html><head><link rel="preconnect" href="https://x.example"><link rel="dns-prefetch" href="//y.example"></head>',
    });

    expect(shown.html).toBe("<!doctype html><head></head>");
    expect(shown.counts.hints).toBe(2);
    expect(shown.warnings).toEqual([]);
  });
});
