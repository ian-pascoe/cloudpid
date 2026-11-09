// docs/architecture/visuals.md → The check, Testing; docs/architecture/browser.md. `checkVisual` over a scripted `CdpTransport`:
// the order of its commands, the page it fulfils and the requests it lets through, what it collects, the screenshot's ladder, and
// that the context is disposed on success, on a timeout and on a throw.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off preferEffectRecord:off schemaSync:off
import { Schema } from "effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  VISUAL_CHECK_IMAGE_CHARACTERS,
  type VisualCheckInput,
} from "@cloudpid/extensions/browser/contract";
import { bytesFromBase64 } from "@cloudpid/protocol/base64";
import { visualCheckPolicy } from "@cloudpid/protocol/visuals";
import type { CdpEvent, CdpParams } from "./cdp.ts";
import { fakeTransport, type Reply } from "./cdp.testing.ts";
import { checkVisual, VISUAL_CHECK_URL, VisualCheckTimeout, within } from "./visual-check.ts";

const Fulfilled = Schema.Struct({
  responseHeaders: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  body: Schema.String,
});

const PAGE = "cdp-page-1";
const HTML = "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>";
const INPUT: VisualCheckInput = { html: HTML, width: 736, theme: "light", top: 0 };

type Script = {
  /** The heights the page reports at `max-content`, one per measure; the last repeats. */
  readonly heights?: ReadonlyArray<number>;
  /** Events the page emits (in its session) once it has loaded, in order. */
  readonly events?: ReadonlyArray<CdpEvent>;
  /** Requests the page makes after it loads: each is paused for the check to answer. */
  readonly requests?: ReadonlyArray<{ readonly url: string; readonly resourceType?: string }>;
  /** The base64 length of the screenshot each call returns, in order; the last repeats. */
  readonly screenshots?: ReadonlyArray<number>;
  /** Whether the page never loads. */
  readonly neverLoads?: boolean;
  /** Replies of the browser, over the defaults of this script. */
  readonly replies?: Partial<Record<string, Reply>>;
};

const inPage = (method: string, params: Schema.Json): CdpEvent => ({
  method,
  params,
  sessionId: PAGE,
});

/** A scripted Browser Run: it makes a context and a page, pauses the page's navigation, loads what is fulfilled and measures it. */
const scripted = (script: Script = {}) => {
  const heights = script.heights ?? [400];
  const screenshots = script.screenshots ?? [1_000];
  let measured = 0;
  let shots = 0;

  // The events a reply causes come after it, as the browser's do.
  const later = (run: () => void) => void setTimeout(run, 0);

  const fake = fakeTransport({
    "Target.createBrowserContext": { browserContextId: "ctx-1" },
    "Target.createTarget": { targetId: "page-1" },
    "Target.attachToTarget": { sessionId: PAGE },
    "Target.disposeBrowserContext": {},
    "Page.navigate": () => {
      later(() =>
        fake.emit(
          inPage("Fetch.requestPaused", {
            requestId: "doc-1",
            request: { url: VISUAL_CHECK_URL },
            resourceType: "Document",
          }),
        ),
      );

      return { frameId: "frame-1" };
    },
    "Fetch.fulfillRequest": () => {
      if (script.neverLoads !== true) {
        later(() => {
          for (const event of script.events ?? []) fake.emit(event);

          for (const [index, request] of (script.requests ?? []).entries()) {
            fake.emit(
              inPage("Fetch.requestPaused", {
                requestId: `req-${index}`,
                request: { url: request.url },
                resourceType: request.resourceType ?? "Script",
              }),
            );
          }

          fake.emit(inPage("Page.loadEventFired", { timestamp: 1 }));
        });
      }

      return {};
    },
    "Runtime.evaluate": (params) => {
      const asked = params?.["expression"];
      const expression = Predicate.isString(asked) ? asked : "";

      if (expression.includes("max-content")) {
        const height = heights[Math.min(measured, heights.length - 1)] ?? 0;

        measured += 1;

        return { result: { type: "number", value: height } };
      }

      return { result: { type: "undefined" } };
    },
    "Page.captureScreenshot": () => {
      const length = screenshots[Math.min(shots, screenshots.length - 1)] ?? 0;

      shots += 1;

      return { data: "A".repeat(length) };
    },
    ...script.replies,
  });

  return fake;
};

const run = (
  fake: ReturnType<typeof fakeTransport>,
  rest: Partial<Parameters<typeof checkVisual>[2]> = {},
  input = INPUT,
) =>
  checkVisual(fake.transport, input, {
    coldStart: false,
    timeoutMs: 2_000,
    loadMs: 500,
    disposeMs: 100,
    ...rest,
  });

const sentOf = (fake: ReturnType<typeof fakeTransport>, method: string) =>
  fake.sent.filter((command) => command.method === method);

const paramsOf = (fake: ReturnType<typeof fakeTransport>, method: string): CdpParams =>
  sentOf(fake, method)[0]?.params ?? {};

describe("checkVisual: the commands", () => {
  it("makes a throwaway context and a page in it, prepares the page, loads it, measures, takes a shot, and disposes", async () => {
    const fake = scripted();

    const result = await run(fake);

    const methods = fake.methods();
    const at = (method: string) => methods.indexOf(method);

    expect(methods.slice(0, 3)).toEqual([
      "Target.createBrowserContext",
      "Target.createTarget",
      "Target.attachToTarget",
    ]);

    // The page's domains and emulation are all set before it navigates.
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "Log.enable",
      "Audits.enable",
      "Network.enable",
      "Fetch.enable",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setEmulatedMedia",
    ]) {
      expect(at(method), method).toBeGreaterThan(2);
      expect(at(method), method).toBeLessThan(at("Page.navigate"));
    }

    expect(at("Page.navigate")).toBeLessThan(at("Fetch.fulfillRequest"));
    expect(at("Fetch.fulfillRequest")).toBeLessThan(at("Page.captureScreenshot"));
    expect(methods.at(-1)).toBe("Target.disposeBrowserContext");
    expect(paramsOf(fake, "Target.disposeBrowserContext")).toEqual({ browserContextId: "ctx-1" });
    expect(fake.state.closed).toBe(true);

    expect(result.screenshot?.mimeType).toBe("image/jpeg");
    expect(result.contentHeight).toBe(400);
  });

  it("emulates the width with mobile off, and the color scheme", async () => {
    const fake = scripted();

    await run(fake, {}, { ...INPUT, width: 360, theme: "dark" });

    expect(paramsOf(fake, "Emulation.setDeviceMetricsOverride")).toMatchObject({
      width: 360,
      mobile: false,
      deviceScaleFactor: 1,
    });
    expect(paramsOf(fake, "Emulation.setEmulatedMedia")).toEqual({
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
  });
});

describe("checkVisual: the page", () => {
  it("fulfils https://visual.invalid/ with the page, the real CSP and the frame's flags, and the theme first in its head", async () => {
    const fake = scripted();

    await run(fake, {}, { ...INPUT, theme: "dark" });

    const fulfil = paramsOf(fake, "Fetch.fulfillRequest");
    const { responseHeaders: headers, body: encoded } = Schema.decodeUnknownSync(Fulfilled)(fulfil);
    const body = new TextDecoder().decode(bytesFromBase64(encoded));

    expect(fulfil).toMatchObject({ requestId: "doc-1", responseCode: 200 });
    expect(headers.find((header) => header.name === "Content-Security-Policy")?.value).toBe(
      visualCheckPolicy(),
    );
    expect(headers.find((header) => header.name === "Content-Type")?.value).toContain("text/html");
    expect(body).toContain("<p>hi</p>");
    expect(body.indexOf("data-theme")).toBeLessThan(body.indexOf("<title>"));
    expect(paramsOf(fake, "Page.navigate")).toEqual({ url: VISUAL_CHECK_URL });
  });

  it("lets requests to the list's hosts through and fails every other one", async () => {
    const fake = scripted({
      requests: [
        { url: "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.2/d3.min.js" },
        { url: "https://fonts.gstatic.com/s/inter.woff2", resourceType: "Font" },
        { url: "https://evil.example/steal" },
        { url: "http://cdnjs.cloudflare.com/not-https.js" },
      ],
    });

    await run(fake);

    expect(sentOf(fake, "Fetch.continueRequest").map((command) => command.params)).toEqual([
      { requestId: "req-0" },
      { requestId: "req-1" },
    ]);
    expect(sentOf(fake, "Fetch.failRequest").map((command) => command.params)).toEqual([
      { requestId: "req-2", errorReason: "BlockedByClient" },
      { requestId: "req-3", errorReason: "BlockedByClient" },
    ]);
  });
});

describe("checkVisual: a navigation", () => {
  it("fails every document but the page's, in any frame, so the page cannot leave the CSP behind", async () => {
    const fake = scripted({
      requests: [
        // `location = "https://cdnjs..."`: a top-level navigation to a host the list allows.
        { url: "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.2/", resourceType: "Document" },
        // A frame in the page, and a frame of the page's own address.
        { url: "https://evil.example/", resourceType: "Document" },
        { url: "https://cdnjs.cloudflare.com/ok.js", resourceType: "Script" },
      ],
    });

    await run(fake);

    expect(sentOf(fake, "Fetch.failRequest").map((command) => command.params)).toEqual([
      { requestId: "req-0", errorReason: "BlockedByClient" },
      { requestId: "req-1", errorReason: "BlockedByClient" },
    ]);
    expect(sentOf(fake, "Fetch.continueRequest").map((command) => command.params)).toEqual([
      { requestId: "req-2" },
    ]);
    // Only the page's own document was fulfilled.
    expect(sentOf(fake, "Fetch.fulfillRequest")).toHaveLength(1);
  });
});

describe("checkVisual: what it measures", () => {
  it("reports the content height, and a page that settles does not grow", async () => {
    const fake = scripted({ heights: [500, 500] });

    const result = await run(fake);

    expect(result.contentHeight).toBe(500);
    expect(result.growth).toEqual({ grows: false, heights: [500, 500] });
  });

  it("resizes the viewport to the fitted height, as the frame does, and measures again", async () => {
    const fake = scripted({ heights: [500, 500] });

    await run(fake);

    const sizes = sentOf(fake, "Emulation.setDeviceMetricsOverride").map(
      (command) => command.params?.["height"],
    );

    expect(sizes).toEqual([160, 500]);
  });

  it("finds a page that grows after each of the frame's resizes", async () => {
    const fake = scripted({ heights: [300, 400, 500, 600] });

    const result = await run(fake);

    expect(result.growth).toEqual({ grows: true, heights: [300, 400, 500, 600] });
  });

  it("does not take the cap for growth: a page over 20,000 px is fitted at 20,000 each time", async () => {
    const fake = scripted({ heights: [25_000, 25_000, 25_000, 25_000] });

    const result = await run(fake);

    expect(result.growth.grows).toBe(false);
  });

  it("collects console messages and errors the page threw", async () => {
    const fake = scripted({
      events: [
        inPage("Runtime.consoleAPICalled", {
          type: "log",
          args: [
            { type: "string", value: "hello" },
            { type: "number", value: 3, description: "3" },
          ],
        }),
        inPage("Runtime.consoleAPICalled", {
          type: "error",
          args: [{ type: "object", description: "TypeError: x is not a function" }],
        }),
        inPage("Runtime.exceptionThrown", {
          exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: y" } },
        }),
      ],
    });

    const result = await run(fake);

    expect(result.console).toEqual([
      { type: "log", text: "hello 3" },
      { type: "error", text: "TypeError: x is not a function" },
      { type: "uncaught", text: "ReferenceError: y" },
    ]);
  });

  it("collects CSP violations from the log and the audits, each once, and drops the sandbox directive's own warning", async () => {
    const fake = scripted({
      events: [
        inPage("Log.entryAdded", {
          entry: {
            source: "security",
            level: "error",
            // What Browser Run's Chrome 152 says (#661): its `url` is the page's, the blocked address is in the text.
            url: "https://visual.invalid/",
            text: "Loading the script 'https://evil.example/x.js' violates the following Content Security Policy directive: \"script-src 'self' 'unsafe-inline'\". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.",
          },
        }),
        inPage("Audits.issueAdded", {
          issue: {
            code: "ContentSecurityPolicyIssue",
            details: {
              contentSecurityPolicyIssueDetails: {
                blockedURL: "https://evil.example/x.js",
                violatedDirective: "script-src-elem",
              },
            },
          },
        }),
        inPage("Audits.issueAdded", {
          issue: {
            code: "ContentSecurityPolicyIssue",
            details: {
              contentSecurityPolicyIssueDetails: {
                violatedDirective: "script-src",
                contentSecurityPolicyViolationType: "kEvalViolation",
              },
            },
          },
        }),
        inPage("Log.entryAdded", {
          entry: {
            source: "security",
            level: "warning",
            text: "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.",
          },
        }),
        inPage("Log.entryAdded", {
          entry: {
            source: "security",
            level: "error",
            text: "Blocked opening 'https://evil.example/' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.",
          },
        }),
        inPage("Log.entryAdded", {
          entry: { source: "network", level: "error", text: "Failed to load resource" },
        }),
      ],
    });

    const result = await run(fake);

    expect(result.violations).toEqual([
      "script-src-elem blocked https://evil.example/x.js",
      "script-src blocked eval",
      "Blocked opening 'https://evil.example/' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.",
    ]);
  });

  it("collects failed loads with their reason, leaving out the favicon and cancelled requests", async () => {
    const fake = scripted({
      events: [
        inPage("Network.requestWillBeSent", {
          requestId: "n1",
          request: { url: "https://evil.example/a.png" },
        }),
        inPage("Network.loadingFailed", {
          requestId: "n1",
          errorText: "net::ERR_BLOCKED_BY_CSP",
          blockedReason: "csp",
        }),
        inPage("Network.requestWillBeSent", {
          requestId: "n2",
          request: { url: "https://visual.invalid/favicon.ico" },
        }),
        inPage("Network.loadingFailed", {
          requestId: "n2",
          errorText: "net::ERR_BLOCKED_BY_CLIENT",
        }),
        inPage("Network.requestWillBeSent", {
          requestId: "n3",
          request: { url: "https://cdnjs.cloudflare.com/x.js" },
        }),
        inPage("Network.loadingFailed", {
          requestId: "n3",
          errorText: "net::ERR_ABORTED",
          canceled: true,
        }),
        inPage("Network.requestWillBeSent", {
          requestId: "n4",
          request: { url: "https://fonts.gstatic.com/f.woff2" },
        }),
        inPage("Network.loadingFailed", {
          requestId: "n4",
          errorText: "net::ERR_CONNECTION_RESET",
        }),
      ],
    });

    const result = await run(fake);

    expect(result.failedLoads).toEqual([
      { url: "https://evil.example/a.png", reason: "csp" },
      { url: "https://fonts.gstatic.com/f.woff2", reason: "net::ERR_CONNECTION_RESET" },
    ]);
  });

  it("ignores what other pages of the browser say, and bounds what it reports", async () => {
    const noisy = Array.from({ length: 80 }, (_, index) =>
      inPage("Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: `line ${index} ${"x".repeat(1_000)}` }],
      }),
    );

    const fake = scripted({
      events: [
        {
          method: "Runtime.consoleAPICalled",
          params: { type: "log", args: [{ type: "string", value: "elsewhere" }] },
          sessionId: "cdp-other",
        },
        ...noisy,
      ],
    });

    const result = await run(fake);

    expect(result.console).toHaveLength(50);
    expect(result.console[0]?.text).toHaveLength(500);
    expect(result.console.some((message) => message.text === "elsewhere")).toBe(false);
    expect(result.warnings).toEqual([
      "There may be more console messages than the 50 shown: the check stopped collecting them at that cap.",
    ]);
  });
});

describe("checkVisual: what it keeps as it hears", () => {
  it("keeps the first of each list and counts the rest as they come, and cuts one text before it is joined", async () => {
    const loop = Array.from({ length: 5_000 }, (_, index) =>
      inPage("Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: `line ${index}` }],
      }),
    );

    const audits = Array.from({ length: 3_000 }, (_, index) =>
      inPage("Audits.issueAdded", {
        issue: {
          code: "ContentSecurityPolicyIssue",
          details: {
            contentSecurityPolicyIssueDetails: {
              blockedURL: `https://evil.example/${index}`,
              violatedDirective: "img-src",
            },
          },
        },
      }),
    );

    const huge = inPage("Runtime.consoleAPICalled", {
      type: "log",
      args: Array.from({ length: 40 }, () => ({ type: "string", value: "y".repeat(100_000) })),
    });

    const fake = scripted({ events: [huge, ...loop, ...audits] });

    const started = Date.now();
    const result = await run(fake);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.console).toHaveLength(50);
    expect(result.console[0]?.text).toHaveLength(500);
    expect(result.console[1]?.text).toBe("line 0");
    expect(result.violations).toHaveLength(50);
    // Past the cap the sources are off, so no count is told.
    expect(result.warnings).toContain(
      "There may be more console messages than the 50 shown: the check stopped collecting them at that cap.",
    );
    expect(result.warnings).toContain(
      "There may be more CSP violations than the 50 shown: the check stopped collecting them at that cap.",
    );
    expect(result.warnings.join(" ")).not.toMatch(/\d+ more/);
  });

  it("tells of violations left out once, and counts no other kind of issue", async () => {
    const both = Array.from({ length: 80 }, (_, index) => [
      inPage("Audits.issueAdded", {
        issue: {
          code: "ContentSecurityPolicyIssue",
          details: {
            contentSecurityPolicyIssueDetails: {
              blockedURL: `https://evil.example/${index}.js`,
              violatedDirective: "script-src-elem",
            },
          },
        },
      }),
      inPage("Log.entryAdded", {
        entry: {
          source: "security",
          text: `Loading the script 'https://evil.example/${index}.js' violates the following Content Security Policy directive: "script-src 'self'".`,
        },
      }),
    ]).flat();

    // Issues of other kinds (a cookie, a deprecation) are not violations: not listed, not counted, and they use no room.
    const others = Array.from({ length: 100 }, () =>
      inPage("Audits.issueAdded", { issue: { code: "CookieIssue", details: {} } }),
    );

    const result = await run(scripted({ events: [...others, ...both] }));

    expect(result.violations).toHaveLength(50);
    expect(result.warnings).toEqual([
      "There may be more CSP violations than the 50 shown: the check stopped collecting them at that cap.",
    ]);
  });

  it("turns a source off once its list is full, once, and goes on with the check", async () => {
    const lines = Array.from({ length: 80 }, (_, index) =>
      inPage("Runtime.consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: `line ${index}` }],
      }),
    );

    const fake = scripted({ events: lines });
    const result = await run(fake);

    expect(sentOf(fake, "Runtime.disable")).toEqual([
      { method: "Runtime.disable", params: {}, sessionId: PAGE },
    ]);
    expect(sentOf(fake, "Log.disable")).toHaveLength(0);
    // The check's own commands still ran.
    expect(result.contentHeight).toBe(400);
    expect(result.screenshot).toBeDefined();
  });

  it("keeps no more than a bounded number of the page's requests to name the ones that fail", async () => {
    const sent = Array.from({ length: 3_000 }, (_, index) =>
      inPage("Network.requestWillBeSent", {
        requestId: `r${index}`,
        request: { url: `https://cdnjs.cloudflare.com/${index}.js` },
      }),
    );

    const failed = inPage("Network.loadingFailed", {
      requestId: "r2999",
      errorText: "net::ERR_FAILED",
    });

    const result = await run(scripted({ events: [...sent, failed] }));

    // Past the cap a request's address is not kept, so the failure is told without one.
    expect(result.failedLoads).toEqual([{ url: "", reason: "net::ERR_FAILED" }]);
  });
});

describe("checkVisual: the screenshot", () => {
  it("is a JPEG at quality 80, clipped to 3,000 px from top", async () => {
    const fake = scripted({ heights: [10_000, 10_000], screenshots: [5_000] });

    const result = await run(fake, {}, { ...INPUT, top: 2_000 });

    expect(paramsOf(fake, "Page.captureScreenshot")).toEqual({
      format: "jpeg",
      quality: 80,
      captureBeyondViewport: true,
      clip: { x: 0, y: 2_000, width: 736, height: 3_000, scale: 1 },
    });
    expect(result.screenshot).toMatchObject({ top: 2_000, height: 3_000, quality: 80 });
    expect(result.screenshot?.data).toHaveLength(5_000);
    expect(result.clipped).toBe(true);
  });

  it("is not clipped when it shows the whole page", async () => {
    const fake = scripted({ heights: [900, 900] });

    const result = await run(fake);

    expect(result.clipped).toBe(false);
    expect(result.screenshot).toMatchObject({ top: 0, height: 900 });
  });

  it("is retaken at quality 60 over the bound, then with the clip halved", async () => {
    const over = VISUAL_CHECK_IMAGE_CHARACTERS + 1;
    const fake = scripted({ heights: [9_000, 9_000], screenshots: [over, over, 100_000] });

    const result = await run(fake);

    expect(sentOf(fake, "Page.captureScreenshot").map((command) => command.params)).toMatchObject([
      { quality: 80, clip: { height: 3_000 } },
      { quality: 60, clip: { height: 3_000 } },
      { quality: 60, clip: { height: 1_500 } },
    ]);
    expect(result.screenshot).toMatchObject({ quality: 60, height: 1_500 });
    expect(result.clipped).toBe(true);
  });

  it("is left out, with a warning, when even the halved clip is over the bound", async () => {
    const over = VISUAL_CHECK_IMAGE_CHARACTERS + 1;
    const fake = scripted({ heights: [9_000, 9_000], screenshots: [over] });

    const result = await run(fake);

    expect(result.screenshot).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("too large"))).toBe(true);
    expect(fake.methods().at(-1)).toBe("Target.disposeBrowserContext");
  });

  it("is left out when top is past the end of the page", async () => {
    const fake = scripted({ heights: [500, 500] });

    const result = await run(fake, {}, { ...INPUT, top: 800 });

    expect(sentOf(fake, "Page.captureScreenshot")).toHaveLength(0);
    expect(result.screenshot).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("past the end"))).toBe(true);
  });
});

describe("checkVisual: a partial result", () => {
  it("warns when the page has not loaded by the time it is measured, and still measures and shoots", async () => {
    const fake = scripted({ neverLoads: true });

    const result = await run(fake, { loadMs: 30 });

    expect(result.warnings.some((warning) => warning.includes("had not finished loading"))).toBe(
      true,
    );
    expect(result.screenshot).toBeDefined();
    expect(fake.methods().at(-1)).toBe("Target.disposeBrowserContext");
  });

  it("warns, and leaves the screenshot out, when the screenshot fails", async () => {
    const fake = scripted({
      replies: {
        "Page.captureScreenshot": () => {
          throw new Error("Page.captureScreenshot: Unable to capture screenshot");
        },
      },
    });

    const result = await run(fake);

    expect(result.screenshot).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("screenshot failed"))).toBe(true);
    expect(result.contentHeight).toBe(400);
  });

  it("gives what it heard, with a warning, when the page stops responding: nothing answers its commands", async () => {
    const fake = scripted({
      events: [
        inPage("Runtime.consoleAPICalled", {
          type: "log",
          args: [{ type: "string", value: "starting" }],
        }),
        inPage("Log.entryAdded", {
          entry: {
            source: "security",
            text: "Loading the script 'https://evil.example/a.js' violates the following Content Security Policy directive: \"script-src 'self'\".",
          },
        }),
      ],
      // The page's main thread is stuck (`while (true) {}`): it answers none of the commands that run in it.
      replies: { "Runtime.evaluate": () => new Promise<Schema.Json>(() => undefined) },
    });

    const result = await run(fake, { timeoutMs: 200, loadMs: 30 });

    expect(result.console).toEqual([{ type: "log", text: "starting" }]);
    expect(result.violations).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/stopped responding/);
    expect(result.contentHeight).toBeUndefined();
    expect(result.screenshot).toBeUndefined();
    expect(fake.methods().at(-1)).toBe("Target.disposeBrowserContext");
    expect(fake.state.closed).toBe(true);
  });

  it("says the page had not finished loading, not that it hung, when its load never fired by the bound", async () => {
    const result = await run(scripted({ neverLoads: true }), { timeoutMs: 400, loadMs: 5_000 });

    expect(result.warnings[0]).toMatch(/had not finished loading within the check's/);
    expect(result.warnings[0]).not.toMatch(/hung/);
    expect(result.contentHeight).toBeUndefined();
  });

  it("gives the measurement it already had when the page stops responding after it", async () => {
    const fake = scripted({
      heights: [400],
      replies: { "Page.captureScreenshot": () => new Promise<Schema.Json>(() => undefined) },
    });

    const result = await run(fake, { timeoutMs: 300, loadMs: 100 });

    expect(result.contentHeight).toBe(400);
    expect(result.growth.heights).toEqual([400, 400]);
    expect(result.screenshot).toBeUndefined();
    expect(result.warnings[0]).toMatch(/stopped responding/);
    expect(fake.state.closed).toBe(true);
  });

  it("says whether the check started the browser", async () => {
    const cold = await checkVisual(scripted().transport, INPUT, {
      coldStart: true,
      timeoutMs: 2_000,
      loadMs: 500,
    });

    expect(cold.coldStart).toBe(true);
  });
});

describe("checkVisual: the dispose", () => {
  it("disposes the context and closes the connection when the browser stops answering before the page is asked to load", async () => {
    const fake = scripted({
      replies: { "Target.createTarget": () => new Promise<Schema.Json>(() => undefined) },
    });

    await expect(run(fake, { timeoutMs: 100, loadMs: 30 })).rejects.toThrow(VisualCheckTimeout);

    expect(fake.methods().at(-1)).toBe("Target.disposeBrowserContext");
    expect(fake.state.closed).toBe(true);
  });

  it("ends within its bound in all: the page's work and a dispose that never answers share it", async () => {
    const fake = scripted({
      replies: {
        "Runtime.evaluate": () => new Promise<Schema.Json>(() => undefined),
        "Target.disposeBrowserContext": () => new Promise<Schema.Json>(() => undefined),
      },
    });

    const started = Date.now();
    const result = await run(fake, { timeoutMs: 400, disposeMs: 150, loadMs: 30 });
    const took = Date.now() - started;

    expect(result.warnings[0]).toMatch(/stopped responding/);
    expect(took).toBeGreaterThanOrEqual(380);
    expect(took).toBeLessThan(400 + 100);
    expect(fake.state.closed).toBe(true);
  });

  it("disposes the context and closes the connection when a command throws", async () => {
    const fake = scripted({
      replies: {
        "Target.attachToTarget": () => {
          throw new Error("Target.attachToTarget: No target with given id");
        },
      },
    });

    await expect(run(fake)).rejects.toThrow(/No target with given id/);

    expect(paramsOf(fake, "Target.disposeBrowserContext")).toEqual({ browserContextId: "ctx-1" });
    expect(fake.state.closed).toBe(true);
  });

  it("disposes nothing when no context was made, and still closes the connection", async () => {
    const fake = scripted({
      replies: {
        "Target.createBrowserContext": () => {
          throw new Error("Target.createBrowserContext: not allowed");
        },
      },
    });

    await expect(run(fake)).rejects.toThrow(/not allowed/);

    expect(sentOf(fake, "Target.disposeBrowserContext")).toHaveLength(0);
    expect(fake.state.closed).toBe(true);
  });

  it("closes the connection even when the dispose itself fails", async () => {
    const fake = scripted({
      replies: {
        "Target.disposeBrowserContext": () => {
          throw new Error("Target.disposeBrowserContext: gone");
        },
      },
    });

    const result = await run(fake);

    expect(result.contentHeight).toBe(400);
    expect(fake.state.closed).toBe(true);
  });

  it("fails when the connection is lost mid-check", async () => {
    const fake = scripted({ neverLoads: true });

    const result = run(fake, { timeoutMs: 5_000, loadMs: 300 });

    setTimeout(() => {
      fake.state.closed = true;
    }, 10);

    await expect(result).rejects.toThrow();
    expect(Predicate.isString(fake.methods()[0])).toBe(true);
  });
});

describe("within", () => {
  it("answers with the work's answer, or fails when it takes longer, and hands a late answer on", async () => {
    await expect(within(100, Promise.resolve(1), "x")).resolves.toBe(1);
    await expect(within(100, Promise.reject(new Error("no")), "x")).rejects.toThrow("no");

    const late: number[] = [];

    await expect(
      within(
        20,
        new Promise<number>((resolve) => setTimeout(() => resolve(7), 60)),
        "The browser",
        (value) => late.push(value),
      ),
    ).rejects.toThrow(/The browser did not answer within/);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(late).toEqual([7]);
  });
});
