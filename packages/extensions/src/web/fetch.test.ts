// The tool seam: a scripted model calls `web_fetch` through a real Harness, over a fake network. Pages and the paging
// and output expectations follow pi-web-tools' `test/web-fetch.test.ts` (MIT; see ../../NOTICE.md).
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalDate:off
import { describe, expect, it } from "vitest";
import { WebToolError } from "./errors.ts";
import { openWebHarness } from "./harness.fixture.ts";
import { type WebRequest } from "./transport.ts";
import { ok, redirect } from "./web.fixture.ts";

const open = (
  answer: (request: WebRequest) => Response | WebToolError,
  hosts?: Record<string, string[]>,
) => openWebHarness({ answer, hosts }, {}, []);

const page = (html: string) => (request: WebRequest) =>
  request.url === "https://example.com/page"
    ? ok(html, "text/html; charset=utf-8")
    : new Response("", { status: 404 });

describe("web_fetch", () => {
  it("fetches a page as Markdown, sending format-weighted browser-like headers", async () => {
    const web = await open(
      page(
        "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad{}</style>",
      ),
    );

    expect(await web.call("web_fetch", { url: "https://example.com/page" })).toEqual({
      text: "# Hello\n\nworld **wide**",
      isError: false,
    });

    expect(web.sent).toHaveLength(1);
    expect(web.sent[0]?.headers.accept).toContain("text/markdown;q=1.0");
    expect(web.sent[0]?.headers["accept-language"]).toBe("en-US,en;q=0.9");
    expect(web.sent[0]?.headers["user-agent"]).toContain("Mozilla/5.0");
  });

  it("returns text and raw HTML formats", async () => {
    const html = "<h1>Hello</h1><p>world <strong>wide</strong></p>";
    const web = await open(page(html));

    expect(
      (await web.call("web_fetch", { url: "https://example.com/page", format: "text" })).text,
    ).toBe("Hello\n\nworld wide");
    expect(
      (await web.call("web_fetch", { url: "https://example.com/page", format: "html" })).text,
    ).toBe(html);
    expect(web.sent[0]?.headers.accept).toContain("text/plain;q=1.0");
    expect(web.sent[1]?.headers.accept).toContain("text/html;q=1.0");
  });

  describe("the SSRF guard", () => {
    it.each([
      ["http://169.254.169.254/latest/meta-data/", "cloud metadata address"],
      ["http://[fd00:ec2::254]/", "unique-local address"],
      ["http://metadata.google.internal/computeMetadata/v1/", "private or local hostname"],
      ["http://127.0.0.1:8787/", "loopback address"],
      ["http://localhost/", "private or local hostname"],
      ["http://2130706433/", "loopback address"],
      ["http://[::ffff:7f00:1]/", "loopback address"],
      ["http://10.0.0.1/", "private address"],
      ["http://100.64.0.1/", "shared address space (carrier-grade NAT)"],
      ["http://192.168.0.1/", "private address"],
    ])("refuses %s as the model would see it, and sends nothing", async (url, reason) => {
      const web = await open(() => ok("secret"));

      expect(await web.call("web_fetch", { url })).toEqual({
        text: `Unable to fetch ${new URL(url).toString()}: blocked: ${reason}`,
        isError: true,
      });
      expect(web.sent).toEqual([]);
    });

    it("refuses a redirect from a public page to the metadata service", async () => {
      const web = await open((request) =>
        request.url === "https://example.com/go"
          ? redirect("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
          : ok("secret"),
      );

      expect(await web.call("web_fetch", { url: "https://example.com/go" })).toEqual({
        text: "Unable to fetch https://example.com/go: redirect blocked: cloud metadata address",
        isError: true,
      });
      expect(web.sent.map((request) => request.url)).toEqual(["https://example.com/go"]);
    });

    it("refuses a name that resolves to a private address", async () => {
      const web = await open(() => ok("secret"), { "rebind.example.net": ["10.1.2.3"] });

      expect((await web.call("web_fetch", { url: "https://rebind.example.net/" })).text).toBe(
        "Unable to fetch https://rebind.example.net/: blocked: host resolves to a private address",
      );
      expect(web.sent).toEqual([]);
    });

    it("tells programs the same", async () => {
      const web = await open(() => ok("secret"));
      const result = await web.callAsProgram("web_fetch", { url: "http://127.0.0.1/" });

      expect(result.isError).toBe(true);
    });
  });

  it("reports the final URL after redirects, without credentials", async () => {
    const web = await open((request) =>
      request.url === "https://example.com/a" ? redirect("/b") : ok("final", "text/plain"),
    );

    const result = await web.callAsProgram("web_fetch", { url: "https://example.com/a" });

    expect(result.structuredOutput).toMatchObject({
      url: "https://example.com/b",
      content: "final",
    });
  });

  it("redacts user information from errors", async () => {
    const web = await open(() => ok("x"));

    expect((await web.call("web_fetch", { url: "https://user:hunter2@example.com/" })).text).toBe(
      "Unable to fetch https://example.com/: URLs with credentials are not supported",
    );
  });

  it("names a failing status with its standard phrase, not the server's text", async () => {
    const web = await open(
      () => new Response("Teapot says no", { status: 404, statusText: "Custom" }),
    );

    expect((await web.call("web_fetch", { url: "https://example.com/page" })).text).toBe(
      "Unable to fetch https://example.com/page: HTTP 404 Not Found",
    );
  });

  it.each(["image/png", "application/pdf", "application/octet-stream"])(
    "rejects unsupported content type %s",
    async (contentType) => {
      const web = await open(() => ok("binary", `${contentType}; charset=binary`));

      expect((await web.call("web_fetch", { url: "https://example.com/file" })).text).toBe(
        `Unable to fetch https://example.com/file: unsupported content type ${contentType} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
      );
    },
  );

  it("rejects a body over 5 MiB, declared or streamed", async () => {
    const declared = await open(
      () =>
        new Response("x", {
          headers: { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) },
        }),
    );

    const streamed = await open(() => ok("x".repeat(6 * 1024 * 1024)));

    const message =
      "Unable to fetch https://example.com/big: response body exceeds the 5 MiB limit";

    expect((await declared.call("web_fetch", { url: "https://example.com/big" })).text).toBe(
      message,
    );
    expect((await streamed.call("web_fetch", { url: "https://example.com/big" })).text).toBe(
      message,
    );
  });

  it("retries a Cloudflare challenge once, with the honest user agent", async () => {
    const web = await open((request) =>
      request.headers["user-agent"]?.startsWith("Mozilla") === true
        ? new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } })
        : ok("through"),
    );

    expect((await web.call("web_fetch", { url: "https://example.com/page" })).text).toBe("through");
    expect(web.sent.map((request) => request.headers["user-agent"])).toEqual([
      expect.stringContaining("Mozilla"),
      "cloudpid-web-tools",
    ]);
  });

  it("fails, quickly, on a page nested too deeply to convert, and still returns it as html", async () => {
    const bomb = `<main>${"<div>".repeat(500_000)}text`;
    const web = await open(page(bomb));
    const started = Date.now();
    const result = await web.call("web_fetch", { url: "https://example.com/page" });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the page could not be converted");

    expect(
      (await web.call("web_fetch", { url: "https://example.com/page", format: "html" })).isError,
    ).toBe(false);
  });

  it("does not retry other failures", async () => {
    const web = await open(() => new Response("", { status: 403 }));

    expect((await web.call("web_fetch", { url: "https://example.com/page" })).text).toBe(
      "Unable to fetch https://example.com/page: HTTP 403 Forbidden",
    );
    expect(web.sent).toHaveLength(1);
  });

  it("reports a network failure", async () => {
    const web = await open(() => WebToolError.make({ message: "network error" }));

    expect((await web.call("web_fetch", { url: "https://example.com/page" })).text).toBe(
      "Unable to fetch https://example.com/page: network error",
    );
  });

  it("times out", async () => {
    const hang = () => new Promise<never>(() => undefined);

    // A response whose body never arrives.
    const web = await open(
      () =>
        new Response(new ReadableStream({ pull: hang }), {
          headers: { "content-type": "text/plain" },
        }),
    );

    expect(
      (await web.call("web_fetch", { url: "https://example.com/page", timeout: 0.05 })).text,
    ).toBe("Unable to fetch https://example.com/page: timed out after 0.05 seconds");
  });

  it("rejects arguments the schema does not allow, without fetching", async () => {
    const web = await open(() => ok("x"));

    expect(
      (await web.call("web_fetch", { url: "https://example.com/", timeout: 500 })).isError,
    ).toBe(true);
    expect((await web.call("web_fetch", { url: "https://example.com/", offset: -1 })).isError).toBe(
      true,
    );
    expect((await web.call("web_fetch", { url: "https://example.com/", extra: 1 })).isError).toBe(
      true,
    );
    expect(web.sent).toEqual([]);
  });

  describe("line window", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const plain = () => ok(text);

    it("returns the page unchanged, with no note, without offset and limit", async () => {
      const web = await open(plain);

      expect((await web.call("web_fetch", { url: "https://example.com/p" })).text).toBe(text);
    });

    it("reads limit lines from a 1-indexed offset and says how many remain and where to continue", async () => {
      const web = await open(plain);

      expect(
        (await web.call("web_fetch", { url: "https://example.com/p", offset: 11, limit: 5 })).text,
      ).toBe(
        "line 11\nline 12\nline 13\nline 14\nline 15\n\n[Showing lines 11-15 of 100. 85 lines remain. Use offset=16 to continue.]",
      );
    });

    it("fails with the line count when offset is past the end", async () => {
      const web = await open(plain);

      expect(
        (await web.call("web_fetch", { url: "https://example.com/p", offset: 101 })).text,
      ).toBe(
        "Unable to fetch https://example.com/p: Offset 101 is beyond end of content (100 lines total)",
      );
    });

    it("windows the converted Markdown, not the source HTML", async () => {
      const html = `<h1>Title</h1>${Array.from({ length: 20 }, (_, index) => `<p>para ${index}</p>`).join("")}`;
      const web = await open(() => ok(html, "text/html"));

      const { text: seen } = await web.call("web_fetch", {
        url: "https://example.com/p",
        offset: 3,
        limit: 3,
      });

      expect(seen).toBe(
        "para 0\n\npara 1\n\n[Showing lines 3-5 of 41. 36 lines remain. Use offset=6 to continue.]",
      );
    });

    it("tells programs the total and the next offset only when a window was requested", async () => {
      const web = await open(plain);
      const whole = await web.callAsProgram("web_fetch", { url: "https://example.com/p" });

      const windowed = await web.callAsProgram("web_fetch", {
        url: "https://example.com/p",
        offset: 11,
        limit: 5,
      });

      const last = await web.callAsProgram("web_fetch", {
        url: "https://example.com/p",
        offset: 96,
      });

      expect(whole.structuredOutput).not.toHaveProperty("total_lines");
      expect(whole.structuredOutput).not.toHaveProperty("next_offset");
      expect(windowed.structuredOutput).toMatchObject({
        content: "line 11\nline 12\nline 13\nline 14\nline 15",
        total_lines: 100,
        next_offset: 16,
        truncated: false,
        structured_truncated: false,
        format: "markdown",
        content_type: "text/plain",
      });
      expect(last.structuredOutput).toMatchObject({ total_lines: 100 });
      expect(last.structuredOutput).not.toHaveProperty("next_offset");
    });
  });

  describe("long pages", () => {
    const long = Array.from({ length: 5000 }, (_, index) => `row ${index + 1}`).join("\n");

    it("cuts at the output limit, names the next line, and pages to the end without gaps", async () => {
      const web = await open(() => ok(long));
      const seen: string[] = [];
      let offset = 1;

      for (let guard = 0; guard < 10; guard++) {
        const { text } = await web.call("web_fetch", {
          url: "https://example.com/p",
          offset,
        });

        const next = /Use offset=(\d+) to continue\.\]$/.exec(text);

        seen.push(
          ...(next === null ? text : text.slice(0, text.lastIndexOf("\n\n[Showing"))).split("\n"),
        );

        if (next === null) break;

        offset = Number(next[1]);
      }

      expect(seen).toEqual(long.split("\n"));
    });

    it("tells programs the model's text was cut, and gives them the whole window up to 1 MiB", async () => {
      const web = await open(() => ok(long));
      const result = await web.callAsProgram("web_fetch", { url: "https://example.com/p" });

      // The probe reports a long `content` by its length.
      expect(result.structuredOutput).toMatchObject({
        truncated: true,
        structured_truncated: false,
        content: `<${long.length} characters>`,
      });
    });

    it("cuts the programs' content at 1 MiB and then omits next_offset", async () => {
      const huge = Array.from(
        { length: 40_000 },
        (_, index) => `row ${index} ${"y".repeat(40)}`,
      ).join("\n");

      const web = await open(() => ok(huge));

      const { structuredOutput } = await web.callAsProgram("web_fetch", {
        url: "https://example.com/p",
        offset: 1,
        limit: 40_000,
      });

      expect(structuredOutput).toMatchObject({ truncated: true, structured_truncated: true });
      expect(structuredOutput).not.toHaveProperty("next_offset");
    });
  });

  describe("JSON", () => {
    const minified = JSON.stringify({ a: { b: [1, 2, { c: null }] }, id: 0 }).replace(
      '"id":0',
      '"id":12345678901234567890',
    );

    it("re-indents JSON without changing its values", async () => {
      const web = await open(() => ok(minified, "application/json"));
      const { text } = await web.call("web_fetch", { url: "https://example.com/j" });

      expect(text.split("\n").length).toBeGreaterThan(5);
      expect(text.replace(/\s+/g, "")).toBe(minified);
      expect(text).toContain('"id": 12345678901234567890');
    });

    it("leaves a JSON body that cannot be re-indented, and format html, unchanged", async () => {
      const jsonp = await open(() => ok('callback({"a":1})', "application/json"));
      const raw = await open(() => ok(minified, "application/json"));

      expect((await jsonp.call("web_fetch", { url: "https://example.com/j" })).text).toBe(
        'callback({"a":1})',
      );
      expect(
        (await raw.call("web_fetch", { url: "https://example.com/j", format: "html" })).text,
      ).toBe(minified);
    });
  });
});
