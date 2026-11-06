// @effect-diagnostics globalDate:off missedPipeableOpportunity:off asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off schemaSync:off preferTypedSchemaDecoder:off extendsNativeError:off missingPipeableSignature:off
// docs/architecture/visuals.md → The check; docs/architecture/browser.md. `visual_check`'s side in the browser host: render a
// Visual's page in a throwaway browser context of the Session's browser, on a CDP connection of the host's own (never a
// conversation's tab or an Owner tab), and say what was measured and seen. The context is made `disposeOnDetach` and disposed in
// a `finally`, whatever came of the check: on success, on its own bound (`VISUAL_CHECK_MS`), and on any failure.
//
// The page is the document `Fetch` fulfils at `https://visual.invalid/` with the real CSP as a header (the sandbox's own
// policy, `visualCheckPolicy`) and the frame's flags (`sandbox allow-scripts allow-same-origin`, which without a frame the
// check adds itself: it also blocks a pop-up, a new target `Fetch` does not see). Requests to the list's hosts pass; every other
// request is failed.
import {
  VISUAL_CHECK_CLIP_PX,
  VISUAL_CHECK_IMAGE_CHARACTERS,
  VISUAL_CHECK_LOAD_MS,
  VISUAL_CHECK_MAX_ITEMS,
  VISUAL_CHECK_MAX_TEXT,
  VISUAL_CHECK_MS,
  type VisualCheckFailedLoad,
  type VisualCheckInput,
  type VisualCheckMessage,
  type VisualCheckResult,
  type VisualCheckScreenshot,
} from "@cloudpid/extensions/browser/contract";
import { base64FromBytes } from "@cloudpid/protocol/base64";
import {
  isVisualHost,
  VISUAL_GROWTH_RESIZES,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  visualCheckPolicy,
  withVisualCheckPrelude,
} from "@cloudpid/protocol/visuals";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { ask, type CdpEvent, type CdpParams, type CdpTransport } from "./cdp.ts";

/** The address the page is fulfilled at: an https origin that can never resolve, so a real header on it matches a frame's. */
export const VISUAL_CHECK_URL = "https://visual.invalid/";

/** The longest a resize waits for the page to draw two frames. */
const FRAMES_MS = 1_000;

/** How long the dispose may take: the context goes with the connection (`disposeOnDetach`) if it does not answer. */
const DISPOSE_MS = 3_000;

/** What the check was asked to do beyond its input, and how long it may take (tests shorten both). */
export type VisualCheckOptions = {
  /** Whether this check started the browser. */
  readonly coldStart: boolean;
  /** The longest the check runs in all. Defaults to `VISUAL_CHECK_MS`. */
  readonly timeoutMs?: number;
  /** The longest it waits for the load, the fonts and two frames. Defaults to `VISUAL_CHECK_LOAD_MS`. */
  readonly loadMs?: number;
};

/** The check ran past its bound. */
export class VisualCheckTimeout extends Error {
  override readonly name = "VisualCheckTimeout";
}

/** The height a frame gives a page that reports `reported` px (`fitHeight` in `apps/web/src/visual/height.ts`). */
const fitHeight = (reported: number): number =>
  Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.ceil(reported)));

// ---------------------------------------------------------------------------------------------------------------------
// What the page is asked

/** The page's height at `max-content`, as the shim measures it, so a page shorter than its frame reports its own height. */
const MEASURE = `(() => {
  const root = document.documentElement;
  const before = root.style.getPropertyValue("height");
  const priority = root.style.getPropertyPriority("height");
  root.style.setProperty("height", "max-content", "important");
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (before) root.style.setProperty("height", before, priority);
  else root.style.removeProperty("height");
  return height;
})()`;

/** Resolves once the fonts are ready (or `ms` passes) and two frames have been drawn (or `ms` passes). */
const settled = (ms: number): string =>
  `new Promise((resolve) => {
  const stop = setTimeout(resolve, ${Math.max(1, Math.floor(ms))});
  const frames = () => requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(stop); resolve(); }));
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(frames, frames);
})`;

// ---------------------------------------------------------------------------------------------------------------------
// What the page says

const Remote = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Json),
  description: Schema.optionalKey(Schema.String),
});

const ConsoleCalled = Schema.Struct({
  type: Schema.String,
  args: Schema.optionalKey(Schema.Array(Remote)),
});

const ExceptionThrown = Schema.Struct({
  exceptionDetails: Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    exception: Schema.optionalKey(
      Schema.Struct({ description: Schema.optionalKey(Schema.String) }),
    ),
  }),
});

const LogEntry = Schema.Struct({
  entry: Schema.Struct({
    source: Schema.String,
    text: Schema.String,
  }),
});

const Issue = Schema.Struct({
  issue: Schema.Struct({
    code: Schema.String,
    details: Schema.optionalKey(
      Schema.Struct({
        contentSecurityPolicyIssueDetails: Schema.optionalKey(
          Schema.Struct({
            blockedURL: Schema.optionalKey(Schema.String),
            violatedDirective: Schema.optionalKey(Schema.String),
            contentSecurityPolicyViolationType: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  }),
});

const Requested = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({ url: Schema.String }),
});

const Failed = Schema.Struct({
  requestId: Schema.String,
  errorText: Schema.String,
  blockedReason: Schema.optionalKey(Schema.String),
  canceled: Schema.optionalKey(Schema.Boolean),
});

const Paused = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({ url: Schema.String }),
  resourceType: Schema.optionalKey(Schema.String),
});

const decode =
  <A>(schema: Schema.Decoder<A>) =>
  (value: Schema.Json | undefined): Option.Option<A> =>
    Schema.decodeUnknownOption(schema)(value, { onExcessProperty: "ignore" });

const decodeConsole = decode(ConsoleCalled);
const decodeException = decode(ExceptionThrown);
const decodeLog = decode(LogEntry);
const decodeIssue = decode(Issue);
const decodeRequested = decode(Requested);
const decodeFailed = decode(Failed);
const decodePaused = decode(Paused);

/** What a violation that names no URL blocked, by the issue's kind of violation. */
const blockedWithoutUrl = (kind: string | undefined): string | undefined => {
  if (kind === "kEvalViolation") return "eval";

  return kind === "kInlineViolation" ? "inline" : undefined;
};

/**
 * The warning the `sandbox` directive adds of its own, which is not the page's: "An iframe which has both allow-scripts and
 * allow-same-origin for its sandbox attribute can escape its sandboxing." (Chrome 152 on Browser Run, #661).
 */
const SANDBOX_WARNING = /both allow-scripts and allow-same-origin/i;

/** What a log line names it blocked: the first quoted address of "Loading the script 'https://…' violates …". */
const LOGGED_BLOCKED = /'([^']+)'/;

/** The directive a log line's text names: `... violates the following Content Security Policy directive: "script-src 'self'"`. */
const LOGGED_DIRECTIVE = /Content Security Policy directive: "([^"\s]+)/i;

type Violation = {
  readonly directive: string | undefined;
  readonly blocked: string | undefined;
  readonly text: string;
};

const textOf = (remote: typeof Remote.Type): string => {
  if (remote.value !== undefined) {
    return Predicate.isString(remote.value) ? remote.value : JSON.stringify(remote.value);
  }

  return remote.description ?? remote.type ?? "";
};

const cut = (text: string): string => text.slice(0, VISUAL_CHECK_MAX_TEXT);

/** What one check hears of its page. */
class Heard {
  readonly console: VisualCheckMessage[] = [];
  readonly logged: Violation[] = [];
  readonly audited: Violation[] = [];
  readonly failed: VisualCheckFailedLoad[] = [];
  readonly #urls = new Map<string, string>();

  onPage(method: string, params: Schema.Json | undefined): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const called = decodeConsole(params);

        if (Option.isSome(called)) {
          this.console.push({
            type: called.value.type,
            text: cut((called.value.args ?? []).map(textOf).join(" ")),
          });
        }

        return;
      }

      case "Runtime.exceptionThrown": {
        const thrown = decodeException(params);

        if (Option.isSome(thrown)) {
          const { text, exception } = thrown.value.exceptionDetails;

          this.console.push({ type: "error", text: cut(exception?.description ?? text ?? "") });
        }

        return;
      }

      case "Log.entryAdded": {
        const log = decodeLog(params);

        if (Option.isNone(log) || log.value.entry.source !== "security") return;

        const { text } = log.value.entry;

        if (SANDBOX_WARNING.test(text)) return;

        this.logged.push({
          directive: LOGGED_DIRECTIVE.exec(text)?.[1],
          blocked: LOGGED_BLOCKED.exec(text)?.[1],
          text,
        });

        return;
      }

      case "Audits.issueAdded": {
        const added = decodeIssue(params);

        const details = Option.isSome(added)
          ? added.value.issue.details?.contentSecurityPolicyIssueDetails
          : undefined;

        if (details === undefined) return;

        const directive = details.violatedDirective;

        const blocked =
          details.blockedURL ?? blockedWithoutUrl(details.contentSecurityPolicyViolationType);

        this.audited.push({
          directive,
          blocked,
          text: `${directive ?? "a directive"} blocked ${blocked ?? "a resource"}`,
        });

        return;
      }

      case "Network.requestWillBeSent": {
        const sent = decodeRequested(params);

        if (Option.isSome(sent)) this.#urls.set(sent.value.requestId, sent.value.request.url);

        return;
      }

      case "Network.loadingFailed": {
        const failed = decodeFailed(params);

        if (Option.isNone(failed) || failed.value.canceled === true) return;

        const url = this.#urls.get(failed.value.requestId) ?? "";

        if (url === `${VISUAL_CHECK_URL}favicon.ico`) return;

        this.failed.push({
          url: cut(url),
          reason: failed.value.blockedReason ?? failed.value.errorText,
        });
      }
    }
  }

  /**
   * The CSP violations the page caused, one line each: what the audits say, then what the log says that the audits did not
   * (the same block is both: the log line names the effective directive and the URL, the issue the directive that was
   * violated and what it blocked).
   */
  violations(): string[] {
    const lines = this.audited.map((violation) => violation.text);

    for (const entry of this.logged) {
      const same = this.audited.some(
        (audit) =>
          (entry.blocked !== undefined &&
            entry.blocked !== "" &&
            audit.blocked === entry.blocked) ||
          (entry.directive !== undefined &&
            audit.directive !== undefined &&
            entry.directive === audit.directive &&
            (entry.blocked === undefined || entry.blocked === "")),
      );

      if (!same) lines.push(entry.text);
    }

    return lines.map(cut);
  }
}

/** `items` cut at the bound, with a warning that says how many were left out. */
const bounded = <A>(items: ReadonlyArray<A>, what: string, warnings: string[]): A[] => {
  if (items.length > VISUAL_CHECK_MAX_ITEMS) {
    warnings.push(`${items.length - VISUAL_CHECK_MAX_ITEMS} more ${what} are not shown.`);
  }

  return items.slice(0, VISUAL_CHECK_MAX_ITEMS);
};

// ---------------------------------------------------------------------------------------------------------------------
// The check

const Context = Schema.Struct({ browserContextId: Schema.String });
const Created = Schema.Struct({ targetId: Schema.String });
const Attached = Schema.Struct({ sessionId: Schema.String });
const Shot = Schema.Struct({ data: Schema.String });

const Evaluated = Schema.Struct({
  result: Schema.Struct({ value: Schema.optionalKey(Schema.Json) }),
  exceptionDetails: Schema.optionalKey(Schema.Json),
});

/**
 * Render `input` on `transport` (a connection to the browser, which the check owns and closes) and say what it saw: see the
 * file's header. Fails when the browser cannot be driven or the check passes `options.timeoutMs`; the context is disposed in
 * either case.
 */
export const checkVisual = async (
  transport: CdpTransport,
  input: VisualCheckInput,
  options: VisualCheckOptions,
): Promise<VisualCheckResult> => {
  const timeoutMs = options.timeoutMs ?? VISUAL_CHECK_MS;
  const loadMs = options.loadMs ?? VISUAL_CHECK_LOAD_MS;
  let browserContextId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = measure(transport, input, options.coldStart, loadMs, (id) => {
    browserContextId = id;
  });

  // The loser of the race goes on against a connection that is closed by then; its failure is of no one's.
  work.catch(() => undefined);

  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new VisualCheckTimeout(`The check timed out after ${timeoutMs / 1_000} s`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
    await dispose(transport, browserContextId);
  }
};

/** Dispose the context, if one was made, and close the connection: the context goes with the connection anyway. */
const dispose = async (transport: CdpTransport, browserContextId: string | undefined) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (browserContextId !== undefined) {
      await Promise.race([
        transport.send("Target.disposeBrowserContext", { browserContextId }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISPOSE_MS);
        }),
      ]);
    }
  } catch {
    // `disposeOnDetach` ties the context to this connection, which is closed next.
  } finally {
    clearTimeout(timer);
    transport.close();
  }
};

const measure = async (
  transport: CdpTransport,
  input: VisualCheckInput,
  coldStart: boolean,
  loadMs: number,
  made: (browserContextId: string) => void,
): Promise<VisualCheckResult> => {
  const warnings: string[] = [];
  const heard = new Heard();

  const { browserContextId } = await ask(
    { transport, cdpSessionId: undefined },
    "Target.createBrowserContext",
    { disposeOnDetach: true },
    Context,
  );

  made(browserContextId);

  const { targetId } = await ask(
    { transport, cdpSessionId: undefined },
    "Target.createTarget",
    { url: "about:blank", browserContextId },
    Created,
  );

  const { sessionId } = await ask(
    { transport, cdpSessionId: undefined },
    "Target.attachToTarget",
    { targetId, flatten: true },
    Attached,
  );

  const live = { transport, cdpSessionId: sessionId };

  const send = (method: string, params: CdpParams = {}) =>
    transport.send(method, params, sessionId);

  let loaded: () => void = () => undefined;
  const loadEvent = new Promise<void>((resolve) => (loaded = resolve));

  const body = base64FromBytes(
    new TextEncoder().encode(withVisualCheckPrelude(input.html, input.theme)),
  );

  /** Answer a request the page made: the document is fulfilled, the list's hosts pass, everything else fails. */
  const answer = (params: Schema.Json | undefined) => {
    const paused = decodePaused(params);

    if (Option.isNone(paused)) return;

    const { requestId, request } = paused.value;

    const reply = (() => {
      if (request.url === VISUAL_CHECK_URL) {
        return send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Content-Security-Policy", value: visualCheckPolicy() },
          ],
          body,
        });
      }

      const url = URL.canParse(request.url) ? new URL(request.url) : undefined;

      return url?.protocol === "https:" && isVisualHost(url.hostname)
        ? send("Fetch.continueRequest", { requestId })
        : send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    })();

    // The page may be gone by the time it is answered; that is the dispose's.
    reply.catch(() => undefined);
  };

  transport.onEvent((event: CdpEvent) => {
    if (event.sessionId !== sessionId) return;

    if (event.method === "Fetch.requestPaused") answer(event.params);
    else if (event.method === "Page.loadEventFired") loaded();
    else heard.onPage(event.method, event.params);
  });

  const evaluate = async (expression: string, awaitPromise = false) => {
    const answered = await ask(
      live,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      Evaluated,
    );

    if (answered.exceptionDetails !== undefined) {
      throw new Error("Runtime.evaluate: the page's script threw");
    }

    return answered.result.value;
  };

  /** Resize the viewport to `height`, as a frame is resized, and wait for two frames. */
  const resize = async (height: number) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(settled(Math.min(loadMs, FRAMES_MS)), true);
  };

  /** The page's height now. */
  const height = async (): Promise<number> => {
    const value = await evaluate(MEASURE);

    if (!Predicate.isNumber(value)) throw new Error("The page's height could not be measured");

    return value;
  };

  // Everything is set before the page navigates; the ten commands are independent, so they go together.
  await Promise.all([
    send("Page.enable"),
    send("Runtime.enable"),
    send("Log.enable"),
    send("Audits.enable"),
    send("Network.enable"),
    send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
    send("Emulation.setDeviceMetricsOverride", {
      width: input.width,
      height: VISUAL_MIN_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: input.theme }],
    }),
  ]);

  const started = Date.now();

  await send("Page.navigate", { url: VISUAL_CHECK_URL });

  // The load, the fonts and two frames, at most `loadMs` in all.
  let loadTimer: ReturnType<typeof setTimeout> | undefined;

  const inTime = await Promise.race([
    loadEvent.then(() => true),
    new Promise<boolean>((resolve) => {
      loadTimer = setTimeout(() => resolve(false), loadMs);
    }),
  ]);

  clearTimeout(loadTimer);

  if (inTime) await evaluate(settled(loadMs - (Date.now() - started)), true);
  else {
    warnings.push(
      `The page had not finished loading after ${loadMs / 1_000} s; it was measured as it was.`,
    );
  }

  // The frame starts at its minimum height and follows the page: its first report sets the frame's height, and each report
  // after that which fits a taller one, right after a resize, extends a streak; the page that grows after each of
  // `VISUAL_GROWTH_RESIZES` in a row would climb to the cap, and the frame freezes it (`apps/web/src/visual/height.ts`).
  const heights = [await height()];
  let applied: number | undefined;
  let streak = 0;
  let grows = false;

  for (let round = 0; round <= VISUAL_GROWTH_RESIZES + 2; round++) {
    const fit = fitHeight(heights.at(-1) ?? 0);

    if (applied !== undefined) {
      if (fit === applied) break;

      streak = fit > applied ? streak + 1 : 0;

      if (streak >= VISUAL_GROWTH_RESIZES) {
        grows = true;
        break;
      }
    }

    applied = fit;
    await resize(fit);
    heights.push(await height());
  }

  const contentHeight = heights.at(-1) ?? 0;

  const screenshot = await shoot(send, input, contentHeight, warnings);

  const clipped =
    input.top > 0 || (screenshot !== undefined && input.top + screenshot.height < contentHeight);

  const found: Types.Mutable<VisualCheckResult> = {
    coldStart,
    contentHeight,
    clipped,
    growth: { grows, heights },
    console: bounded(heard.console, "console messages", warnings),
    violations: bounded(heard.violations(), "CSP violations", warnings),
    failedLoads: bounded(heard.failed, "failed loads", warnings),
    warnings,
  };

  if (screenshot !== undefined) found.screenshot = screenshot;

  return found;
};

/**
 * The JPEG of the page from `input.top`, clipped to `VISUAL_CHECK_CLIP_PX`, at quality 80; over the bound the transcript
 * holds images to, it is retaken at quality 60, then with the clip halved. A screenshot that cannot be taken or kept is left
 * out, and a warning says why.
 */
const shoot = async (
  send: (method: string, params?: CdpParams) => Promise<Schema.Json>,
  input: VisualCheckInput,
  contentHeight: number,
  warnings: string[],
): Promise<VisualCheckScreenshot | undefined> => {
  if (input.top >= contentHeight) {
    warnings.push(
      `No screenshot: top (${input.top} px) is past the end of the page, which is ${contentHeight} px tall.`,
    );

    return undefined;
  }

  const full = Math.min(VISUAL_CHECK_CLIP_PX, contentHeight - input.top);

  const attempts = [
    { quality: 80, height: full },
    { quality: 60, height: full },
    { quality: 60, height: Math.max(1, Math.floor(full / 2)) },
  ];

  try {
    for (const { quality, height } of attempts) {
      const { data } = Schema.decodeUnknownSync(Shot)(
        await send("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          captureBeyondViewport: true,
          clip: { x: 0, y: input.top, width: input.width, height, scale: 1 },
        }),
        { onExcessProperty: "ignore" },
      );

      if (data.length <= VISUAL_CHECK_IMAGE_CHARACTERS) {
        return { data, mimeType: "image/jpeg", top: input.top, height, quality };
      }
    }
  } catch (error) {
    warnings.push(
      `The screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  }

  warnings.push(
    "No screenshot: it is too large to keep even at quality 60 with the clip halved. Check a smaller part of the page with `top`, or a simpler one.",
  );

  return undefined;
};
