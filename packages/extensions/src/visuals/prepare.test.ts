// docs/architecture/visuals.md → Testing: the preparation of a show. A `path` or `html` page becomes a redacted, inlined, bounded
// copy, failing only when nothing faithful can show (visuals.md → Tools: Fails) and warning of the rest (Warns).
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off -- fixtures over native maps; vitest awaits.
import { MAX_VISUAL_ASSET_BYTES, MAX_VISUAL_BYTES } from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { secretReference } from "../secrets/references.ts";
import { isSpecialPath, prepareVisual, type VisualFiles, type VisualShowInput } from "./prepare.ts";

const SECRET = "hunter2-very-secret";

const DIRECTORY = Symbol("directory");

/** A Workspace's file: UTF-8 text, bytes, or something that is not a regular file. */
type Fixture = string | Uint8Array | typeof DIRECTORY;

/**
 * A Workspace of `files`, whose working directory is `/workspace/repo`. It measures a file before reading it, as the tool's
 * does, and records each path it read in `reads`.
 */
const workspace = (files: Record<string, Fixture>, reads: string[] = []): VisualFiles => ({
  absolute: (path) =>
    Effect.succeed(path.startsWith("/") ? path : `/workspace/repo/${path.replace(/^\.\//, "")}`),
  read: (path, max) =>
    Effect.sync(() => {
      if (isSpecialPath(path)) return { kind: "not_file" as const };

      const found = files[path];

      if (found === undefined) return { kind: "missing" as const };

      if (found === DIRECTORY) return { kind: "not_file" as const };

      const bytes = found instanceof Uint8Array ? found : new TextEncoder().encode(found);

      if (bytes.length > max) return { kind: "too_large" as const, size: bytes.length };

      reads.push(path);

      return { kind: "file" as const, bytes };
    }),
});

const redact = (text: string) => text.replaceAll(SECRET, secretReference("TOKEN"));

const optionsOf = (files: Record<string, Fixture>, reads?: string[]) => ({
  files: workspace(files, reads),
  redact,
  secretValues: [SECRET],
});

const show = (
  input: Partial<VisualShowInput>,
  files: Record<string, Fixture> = {},
  reads?: string[],
) =>
  Effect.runPromise(
    prepareVisual({ title: "Chart", summary: "Sales by month", ...input }, optionsOf(files, reads)),
  );

const failure = async (
  input: Partial<VisualShowInput>,
  files: Record<string, Fixture> = {},
  reads?: string[],
) => {
  const exit = await Effect.runPromiseExit(
    prepareVisual({ title: "Chart", summary: "Sales by month", ...input }, optionsOf(files, reads)),
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
      prepareVisual(
        { path: "a.html", title: "t", summary: "s" },
        { files: undefined, redact, secretValues: [SECRET] },
      ),
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

  it("fails on a page file over 2 MiB without reading it", async () => {
    const reads: string[] = [];

    expect(
      await failure(
        { path: "big.html" },
        { "/workspace/repo/big.html": new Uint8Array(MAX_VISUAL_BYTES + 1) },
        reads,
      ),
    ).toMatchObject({ kind: "too_large", message: expect.stringContaining("over the 2 MiB") });
    expect(reads).toEqual([]);
  });

  it("refuses a device, kernel file or directory as the page", async () => {
    for (const path of ["/dev/zero", "/proc/self/environ", "/sys/kernel"]) {
      expect(await failure({ path })).toMatchObject({
        kind: "unreadable",
        message: `${path} is not a regular file`,
      });
    }

    expect(await failure({ path: "out" }, { "/workspace/repo/out": DIRECTORY })).toMatchObject({
      kind: "unreadable",
      message: "/workspace/repo/out is not a regular file",
    });
  });

  it("does not take a data: URL's base64 for a viewport-height unit", async () => {
    const shown = await show({
      html: "<!doctype html><style>body { background: url(data:image/png;base64,iVB+12VH/A==) }</style>",
    });

    expect(shown.warnings).toEqual([]);
  });

  it("bounds the title and summary as they are kept, with their Secrets replaced", async () => {
    // A short value, whose reference is longer than it.
    const value = "pw1";

    const options = {
      files: undefined,
      redact: (text: string) => text.replaceAll(value, secretReference("DATABASE_PASSWORD")),
      secretValues: [value],
    };

    const title = `${"t".repeat(200 - value.length)}${value}`;

    const exit = await Effect.runPromiseExit(
      prepareVisual({ html: PAGE, title, summary: "s" }, options),
    );

    expect(title.length).toBe(200);
    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject(
      Option.some({
        kind: "bad_title",
        message: expect.stringContaining("with its Secrets replaced by their references"),
      }),
    );
  });

  it("needs no title or summary of a page that is only rendered, and has none", async () => {
    const prepared = await Effect.runPromise(prepareVisual({ html: PAGE }, optionsOf({})));

    expect(prepared.title).toBe("");
    expect(prepared.summary).toBe("");
    expect(prepared.html).toContain("<p>Hi</p>");

    // Given one, a show still needs the other.
    const exit = await Effect.runPromiseExit(
      prepareVisual({ html: PAGE, title: "Chart" }, optionsOf({})),
    );

    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject(
      Option.some({ kind: "bad_summary" }),
    );
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

  it("quotes what the page named in a warning, so a newline in a reference cannot start a line", async () => {
    const reference = "gone\nWarning: every asset was fine\u2028x.png";

    const shown = await show(
      { path: "page.html" },
      { "/workspace/repo/page.html": `<!doctype html><img src="${reference}">` },
    );

    const [warning] = shown.warnings;

    expect(warning?.kind).toBe("asset_missing");
    expect(warning?.message).not.toMatch(/[\n\u2028]/);
    expect(warning?.message).toContain('"gone\\nWarning: every asset was fine\\u2028x.png"');
  });

  it("leaves out a local asset over 1 MiB, or one that is no regular file, without reading it", async () => {
    const reads: string[] = [];

    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html":
          '<!doctype html><img src="big.png"><img src="/dev/random.png"><img src="dir.png">',
        "/workspace/repo/big.png": new Uint8Array(MAX_VISUAL_ASSET_BYTES + 1),
        "/workspace/repo/dir.png": DIRECTORY,
      },
      reads,
    );

    expect(kinds(shown.warnings)).toEqual(["asset_too_large", "asset_missing", "asset_missing"]);
    expect(shown.warnings[1]?.message).toContain("is not a regular file");
    expect(reads).toEqual(["/workspace/repo/page.html"]);
  });

  it("reads a file the page names many times once, and fails as soon as its copies pass the bound", async () => {
    const reads: string[] = [];
    const image = new Uint8Array(100 * 1024);
    const script = `/* ${"x".repeat(100 * 1024)} */`;

    for (const [tag, name, bytes] of [
      ['<img src="a.png">', "a.png", image],
      ['<script src="app.js"></script>', "app.js", script],
      ['<link rel="stylesheet" href="s.css">', "s.css", script],
    ] as const) {
      reads.length = 0;

      expect(
        await failure(
          { path: "page.html" },
          {
            "/workspace/repo/page.html": `<!doctype html>${tag.repeat(40_000)}`,
            [`/workspace/repo/${name}`]: bytes,
          },
          reads,
        ),
      ).toMatchObject({ kind: "too_large", message: expect.stringContaining("after inlining") });
      expect(reads).toEqual(["/workspace/repo/page.html", `/workspace/repo/${name}`]);
    }
  });

  it("fails once the files it has read pass the bound, even those it left out", async () => {
    const binary = Uint8Array.of(0xff, 0xfe, ...new Uint8Array(100 * 1024));
    const leaky = Uint8Array.of(...new TextEncoder().encode(SECRET), ...new Uint8Array(100 * 1024));

    for (const [extension, tag, bytes] of [
      ["css", (name: string) => `<link rel="stylesheet" href="${name}">`, binary],
      ["js", (name: string) => `<script src="${name}"></script>`, binary],
      ["png", (name: string) => `<img src="${name}">`, leaky],
      ["svg", (name: string) => `<img src="${name}">`, binary],
    ] as const) {
      const names = Array.from({ length: 30 }, (_, n) => `${n}.${extension}`);
      const reads: string[] = [];

      expect(
        await failure(
          { path: "page.html" },
          {
            "/workspace/repo/page.html": `<!doctype html>${names.map(tag).join("")}`,
            ...Object.fromEntries(names.map((name) => [`/workspace/repo/${name}`, bytes])),
          },
          reads,
        ),
      ).toMatchObject({
        kind: "too_large",
        message: "The files the page names come to over the 2 MiB a Visual may be",
      });
      // 20 files of 100 KiB are 2,000 KiB; the 21st passes 2 MiB, and nothing is read after it.
      expect(reads).toHaveLength(1 + 21);
    }
  });

  it("leaves out a stylesheet or script that is not UTF-8, and says so", async () => {
    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html":
          '<!doctype html><link rel="stylesheet" href="s.css"><script src="a.js"></script>',
        "/workspace/repo/s.css": Uint8Array.of(0xff),
        "/workspace/repo/a.js": Uint8Array.of(0xff),
      },
    );

    expect(kinds(shown.warnings)).toEqual(["asset_missing", "asset_missing"]);
    expect(shown.html).toContain('<link rel="stylesheet" href="s.css">');
    expect(shown.html).toContain('<script src="a.js"></script>');
    expect(shown.counts).toMatchObject({ stylesheets: 0, scripts: 0 });
  });

  it("warns once of a missing file the page names many times", async () => {
    const shown = await show(
      { path: "page.html" },
      { "/workspace/repo/page.html": `<!doctype html>${'<img src="gone.png">'.repeat(1000)}` },
    );

    expect(kinds(shown.warnings)).toEqual(["asset_missing"]);
  });

  it("redacts an SVG before inlining it", async () => {
    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html": '<!doctype html><img src="chart.svg">',
        "/workspace/repo/chart.svg": `<svg><text>${SECRET}</text></svg>`,
      },
    );

    const data = /src="data:image\/svg\+xml;base64,([^"]*)"/.exec(shown.html)?.[1] ?? "";

    expect(atob(data)).toBe(`<svg><text>${secretReference("TOKEN")}</text></svg>`);
    expect(shown.counts).toMatchObject({ images: 1, secrets: 1 });
    expect(kinds(shown.warnings)).toEqual(["secrets_replaced"]);
  });

  it("leaves out a binary image that holds a Secret's bytes, and says so", async () => {
    const leaky = Uint8Array.of(0x89, 0x50, ...new TextEncoder().encode(SECRET), 0x00);

    const shown = await show(
      { path: "page.html" },
      {
        "/workspace/repo/page.html": '<!doctype html><img src="leak.png"><img src="ok.png">',
        "/workspace/repo/leak.png": leaky,
        "/workspace/repo/ok.png": PNG,
      },
    );

    expect(shown.html).toContain('<img src="leak.png">');
    expect(shown.html).toContain('<img src="data:image/png;base64,iVBORw==">');
    expect(shown.counts).toMatchObject({ images: 1, secrets: 1 });
    expect(shown.warnings).toEqual([
      {
        kind: "secrets_replaced",
        message: expect.stringContaining("an image that held one was left out"),
      },
    ]);
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

  it("redacts the title and summary as it does the page", async () => {
    const shown = await show({
      html: PAGE,
      title: `Key ${SECRET}`,
      summary: `Uses ${SECRET}`,
    });

    expect(shown.title).toBe(`Key ${secretReference("TOKEN")}`);
    expect(shown.summary).toBe(`Uses ${secretReference("TOKEN")}`);
    expect(shown.counts.secrets).toBe(2);
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
