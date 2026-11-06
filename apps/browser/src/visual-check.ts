// @effect-diagnostics globalDate:off missedPipeableOpportunity:off asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off schemaSync:off preferTypedSchemaDecoder:off extendsNativeError:off missingPipeableSignature:off
// docs/architecture/visuals.md → The check; docs/architecture/browser.md. `visual_check`'s side in the browser host: render a
// Visual's page in a throwaway browser context of the Session's browser, on a CDP connection of the host's own (never a
// conversation's tab or an Owner tab), and say what was measured and seen. The context is made `disposeOnDetach` and disposed in
// a `finally`, whatever came of the check: on success, on its own bound (`VISUAL_CHECK_MS`), and on any failure.
//
// The page is the document `Fetch` fulfils at `https://visual.invalid/` with the real CSP as a header (the sandbox's own
// policy, `visualCheckPolicy`) and the frame's flags (`sandbox allow-scripts allow-same-origin`, which without a frame the
// check adds itself: it also blocks a pop-up, a new target `Fetch` does not see). Requests to the list's hosts pass; every other
// request is failed, and so is every document but that one, in any frame: a page that navigates away (`location = ...`) would
// leave the CSP and the directive behind. What the page says is collected as it comes, each list kept to its first
// `VISUAL_CHECK_MAX_ITEMS` and each text cut, so a page that logs in a loop costs nothing past the cap. The check is bound to
// `timeoutMs` in all: a page that stops responding (a hung main thread) gives what it had done by then, with a warning.
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
  fitHeight,
  isVisualHost,
  VISUAL_GROWTH_RESIZES,
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
  /**
   * The longest the check runs in all, from its first command to the dispose (what the host spent before, to start the browser
   * and connect, is out of it). Defaults to `VISUAL_CHECK_MS`.
   */
  readonly timeoutMs?: number;
  /** The longest it waits for the load, the fonts and two frames. Defaults to `VISUAL_CHECK_LOAD_MS`. */
  readonly loadMs?: number;
  /** The longest the dispose takes, which `timeoutMs` includes. Defaults to `DISPOSE_MS`. */
  readonly disposeMs?: number;
};

/** Something the check waits for before it has a page (the browser, its connection, its first commands) ran past the bound. */
export class VisualCheckTimeout extends Error {
  override readonly name = "VisualCheckTimeout";
}

/** `ms` as seconds, to a tenth. */
const seconds = (ms: number): number => Math.round(ms / 100) / 10;

/**
 * `work`'s answer, or a `VisualCheckTimeout` that says `what` did not answer in `ms`. A `work` that answers later is handed to
 * `late` (to close the connection it opened); one that fails later is of no one's.
 */
export const within = <A>(
  ms: number,
  work: Promise<A>,
  what: string,
  late: (value: A) => void = () => undefined,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    let over = false;

    const timer = setTimeout(
      () => {
        over = true;
        reject(new VisualCheckTimeout(`${what} did not answer within ${seconds(ms)} s`));
      },
      Math.max(1, ms),
    );

    // A rejection after the bound is the promise's already: rejecting again does nothing.
    work
      .finally(() => clearTimeout(timer))
      .then((value) => {
        if (over) late(value);
        else resolve(value);
      }, reject);
  });

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

/** The type of a message that is an error the page's script did not catch (`VisualCheckMessage`). */
export const UNCAUGHT = "uncaught";

/** How much of an address or a log line is matched against another: past it, two of them are told apart by their start. */
const MATCH_CHARACTERS = 2_048;

/** The most requests whose address is kept to name a failed one: a page that makes more is not followed past them. */
const MAX_REQUESTS = 1_000;

/** The most arguments of one console call that are read. */
const MAX_ARGUMENTS = 20;

/** A console call's arguments as one text, read no further than the text may be, and cut. */
const consoleText = (args: ReadonlyArray<typeof Remote.Type>): string => {
  let text = "";

  for (const arg of args.slice(0, MAX_ARGUMENTS)) {
    if (text.length >= VISUAL_CHECK_MAX_TEXT) break;

    text += `${text === "" ? "" : " "}${cut(textOf(arg))}`;
  }

  return cut(text);
};

/**
 * A list that keeps the first `VISUAL_CHECK_MAX_ITEMS` and counts the rest, as they come: what a page says is unbounded, and
 * a page that logs in a loop must cost the host no more past the cap than a count.
 */
class Capped<A> {
  readonly items: A[] = [];
  dropped = 0;

  /** Whether there is room for one more, which the caller then adds; when there is not, the one is counted as left out. */
  take(): boolean {
    if (this.items.length < VISUAL_CHECK_MAX_ITEMS) return true;

    this.dropped += 1;

    return false;
  }
}

/** The CSP violations as lines, and how many were left out as they came. */
type ViolationLines = { readonly lines: string[]; readonly dropped: number };

/** A CDP domain whose events feed a list: it is turned off once the list is full. */
type Source = "Runtime" | "Log" | "Audits";

/**
 * What one check hears of its page: bounded as it is heard (`Capped`, `cut`). `stop` is told once for a source whose list is
 * full, to turn its events off, so the socket stops delivering what would be counted and dropped; `Runtime.evaluate` needs no
 * `Runtime.enable`, so the check's own commands go on.
 */
class Heard {
  readonly console = new Capped<VisualCheckMessage>();
  readonly logged = new Capped<Violation>();
  readonly audited = new Capped<Violation>();
  readonly failed = new Capped<VisualCheckFailedLoad>();
  readonly #urls = new Map<string, string>();
  readonly #stop: (source: Source) => void;
  readonly #stopped = new Set<Source>();
  /** Whether the violations are full: a list of them has reached the cap, so neither is taken any more. */
  #violationsFull = false;

  constructor(stop: (source: Source) => void) {
    this.#stop = stop;
  }

  /** Turn `source` off, once. */
  #turnOff(source: Source): void {
    if (this.#stopped.has(source)) return;

    this.#stopped.add(source);
    this.#stop(source);
  }

  /** Room in `list` for one more (see `Capped.take`); once it is full, its `source` is turned off. */
  #take<A>(list: Capped<A>, source: Source): boolean {
    if (list.take()) return true;

    this.#turnOff(source);

    return false;
  }

  /**
   * Room for one more violation in `list`. A violation is an issue and a log line (`violations`), so the two lists are full
   * together: once either has reached the cap, no more of either is taken and both sources are turned off, or the log lines
   * of the violations the issues left out would be listed as violations of their own.
   */
  #takeViolation(list: Capped<Violation>, source: "Log" | "Audits"): boolean {
    if (this.#violationsFull) {
      list.dropped += 1;

      return false;
    }

    return this.#take(list, source);
  }

  /** Whether a violation list has reached the cap; if so, both sources are turned off. */
  #settleViolations(): void {
    if (
      this.audited.items.length < VISUAL_CHECK_MAX_ITEMS &&
      this.logged.items.length < VISUAL_CHECK_MAX_ITEMS
    ) {
      return;
    }

    this.#violationsFull = true;
    this.#turnOff("Audits");
    this.#turnOff("Log");
  }

  onPage(method: string, params: Schema.Json | undefined): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        if (!this.#take(this.console, "Runtime")) return;

        const called = decodeConsole(params);

        if (Option.isSome(called)) {
          this.console.items.push({
            type: called.value.type,
            text: consoleText(called.value.args ?? []),
          });
        }

        return;
      }

      case "Runtime.exceptionThrown": {
        if (!this.#take(this.console, "Runtime")) return;

        const thrown = decodeException(params);

        if (Option.isSome(thrown)) {
          const { text, exception } = thrown.value.exceptionDetails;

          // Its own type, which the page cannot write (a console call's is the browser's: `log`, `error`...), so what the page
          // says with `console.error("uncaught: ...")` cannot pass for it.
          this.console.items.push({
            type: UNCAUGHT,
            text: cut(exception?.description ?? text ?? ""),
          });
        }

        return;
      }

      case "Log.entryAdded": {
        const log = decodeLog(params);

        if (Option.isNone(log) || log.value.entry.source !== "security") return;

        const text = log.value.entry.text.slice(0, MATCH_CHARACTERS);

        if (SANDBOX_WARNING.test(text) || !this.#takeViolation(this.logged, "Log")) return;

        this.logged.items.push({
          directive: LOGGED_DIRECTIVE.exec(text)?.[1],
          blocked: LOGGED_BLOCKED.exec(text)?.[1],
          text: cut(text),
        });

        this.#settleViolations();

        return;
      }

      case "Audits.issueAdded": {
        const added = decodeIssue(params);

        const details = Option.isSome(added)
          ? added.value.issue.details?.contentSecurityPolicyIssueDetails
          : undefined;

        // Only a CSP issue is a violation: any other kind of issue is neither listed nor counted.
        if (details === undefined || !this.#takeViolation(this.audited, "Audits")) return;

        const directive = details.violatedDirective;

        const blocked =
          details.blockedURL?.slice(0, MATCH_CHARACTERS) ??
          blockedWithoutUrl(details.contentSecurityPolicyViolationType);

        this.audited.items.push({
          directive,
          blocked,
          text: cut(`${directive ?? "a directive"} blocked ${blocked ?? "a resource"}`),
        });

        this.#settleViolations();

        return;
      }

      case "Network.requestWillBeSent": {
        if (this.#urls.size >= MAX_REQUESTS) return;

        const sent = decodeRequested(params);

        if (Option.isSome(sent)) {
          this.#urls.set(sent.value.requestId, sent.value.request.url.slice(0, MATCH_CHARACTERS));
        }

        return;
      }

      case "Network.loadingFailed": {
        const failed = decodeFailed(params);

        if (Option.isNone(failed) || failed.value.canceled === true) return;

        const url = this.#urls.get(failed.value.requestId) ?? "";

        this.#urls.delete(failed.value.requestId);

        if (url === `${VISUAL_CHECK_URL}favicon.ico` || !this.failed.take()) return;

        this.failed.items.push({
          url: cut(url),
          reason: cut(failed.value.blockedReason ?? failed.value.errorText),
        });
      }
    }
  }

  /**
   * The CSP violations the page caused, one line each: what the audits say, then what the log says that the audits did not
   * (the same block is both: the log line names the effective directive and the URL, the issue the directive that was
   * violated and what it blocked); and how many were left out at the cap. Each list holds at most `VISUAL_CHECK_MAX_ITEMS`,
   * so matching them is bounded.
   */
  violations(): ViolationLines {
    const lines = this.audited.items.map((violation) => violation.text);

    for (const entry of this.logged.items) {
      const same = this.audited.items.some(
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

    // Only whether any were left out is told: past the cap the sources are off, so there is no count to give.
    return { lines, dropped: this.audited.dropped + this.logged.dropped };
  }
}

/**
 * `items` cut at the bound, with a warning when some were left out. A list whose source is turned off at the cap (`stops`) has
 * no count past it: the warning says there may be more. Any other says how many (`dropped` more were left out as they came).
 */
const bounded = <A>(
  items: ReadonlyArray<A>,
  dropped: number,
  what: string,
  warnings: string[],
  stops: boolean,
): A[] => {
  if (stops) {
    if (items.length >= VISUAL_CHECK_MAX_ITEMS || dropped > 0) {
      warnings.push(
        `There may be more ${what} than the ${VISUAL_CHECK_MAX_ITEMS} shown: the check stopped collecting them at that cap.`,
      );
    }
  } else {
    const left = items.length - VISUAL_CHECK_MAX_ITEMS + dropped;

    if (left > 0) warnings.push(`${left} more ${what} are not shown.`);
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
 * What a check has so far: what it heard, measured and shot, kept as it goes so that a check cut off by its bound can say what
 * it had (`resultOf`).
 */
type Progress = {
  readonly coldStart: boolean;
  readonly heard: Heard;
  /** The page's session, once it is attached. */
  cdpSessionId: string | undefined;
  readonly warnings: string[];
  readonly heights: number[];
  grows: boolean;
  screenshot: VisualCheckScreenshot | undefined;
  clipped: boolean;
  /** Whether the page was asked to load: before that, nothing of the page is known and a bound is the browser's. */
  navigated: boolean;
  /** Whether the page's load event has fired. */
  loaded: boolean;
};

/** What `progress` comes to, as a result: each list bounded, and `warnings` as they are. */
const resultOf = (progress: Progress): VisualCheckResult => {
  const warnings = [...progress.warnings];
  const { heard } = progress;
  const violations = heard.violations();

  const found: Types.Mutable<VisualCheckResult> = {
    coldStart: progress.coldStart,
    clipped: progress.clipped,
    growth: { grows: progress.grows, heights: [...progress.heights] },
    console: bounded(
      heard.console.items,
      heard.console.dropped,
      "console messages",
      warnings,
      true,
    ),
    violations: bounded(violations.lines, violations.dropped, "CSP violations", warnings, true),
    failedLoads: bounded(heard.failed.items, heard.failed.dropped, "failed loads", warnings, false),
    warnings,
  };

  const contentHeight = progress.heights.at(-1);

  if (contentHeight !== undefined) found.contentHeight = contentHeight;

  if (progress.screenshot !== undefined) found.screenshot = progress.screenshot;

  return found;
};

const TIMED_OUT = "timed out";

/**
 * Render `input` on `transport` (a connection to the browser, which the check owns and closes) and say what it saw: see the
 * file's header. The check, with its dispose, takes at most `options.timeoutMs`. Fails when the browser cannot be driven, or
 * does not answer before the page is asked to load. A page that stops responding after (a hung main thread: nothing
 * answers a command) is not a failure: the result is what the check had by then, with a warning. The context is disposed
 * whatever came of it.
 */
export const checkVisual = async (
  transport: CdpTransport,
  input: VisualCheckInput,
  options: VisualCheckOptions,
): Promise<VisualCheckResult> => {
  const timeoutMs = options.timeoutMs ?? VISUAL_CHECK_MS;
  const loadMs = options.loadMs ?? VISUAL_CHECK_LOAD_MS;
  const disposeMs = options.disposeMs ?? DISPOSE_MS;
  // The dispose has its own bound, which the whole is not to pass: the page's work has what `timeoutMs` leaves.
  const workMs = Math.max(1, timeoutMs - disposeMs);
  let browserContextId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const progress: Progress = {
    coldStart: options.coldStart,
    heard: new Heard((source) => {
      // The page's session, once there is one; the page may be gone by the time it is told, which is the dispose's.
      transport.send(`${source}.disable`, {}, progress.cdpSessionId).catch(() => undefined);
    }),
    cdpSessionId: undefined,
    warnings: [],
    heights: [],
    grows: false,
    screenshot: undefined,
    clipped: false,
    navigated: false,
    loaded: false,
  };

  const work = measure(transport, input, progress, loadMs, (id) => {
    browserContextId = id;
  });

  // The loser of the race goes on against a connection that is closed by then; its failure is of no one's.
  work.catch(() => undefined);

  const bound = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), workMs);
  });

  try {
    const outcome = await Promise.race([work, bound]);

    if (outcome !== TIMED_OUT) return outcome;

    if (!progress.navigated) {
      throw new VisualCheckTimeout(
        `The browser did not answer within ${seconds(workMs)} s, before the page was loaded`,
      );
    }

    // A page whose load never fired has not finished loading in time (a slow one, or one stuck in its load); one that loaded
    // and then answers no command has stopped responding (a hung main thread).
    progress.warnings.unshift(
      progress.loaded
        ? `The page stopped responding within the check's ${seconds(workMs)} s (its main thread may be hung, for example by a script that never returns), so the check was cut off: this is what it had by then.`
        : `The page had not finished loading within the check's ${seconds(workMs)} s (it may be very slow to load, or a script may never return), so the check was cut off before it could measure it: this is what it had by then.`,
    );

    return resultOf(progress);
  } finally {
    clearTimeout(timer);
    await dispose(transport, browserContextId, disposeMs);
  }
};

/** Dispose the context, if one was made, and close the connection: the context goes with the connection anyway. */
const dispose = async (
  transport: CdpTransport,
  browserContextId: string | undefined,
  disposeMs: number,
) => {
  try {
    if (browserContextId !== undefined) {
      await within(
        disposeMs,
        transport.send("Target.disposeBrowserContext", { browserContextId }),
        "The dispose",
      );
    }
  } catch {
    // `disposeOnDetach` ties the context to this connection, which is closed next.
  } finally {
    transport.close();
  }
};

const measure = async (
  transport: CdpTransport,
  input: VisualCheckInput,
  progress: Progress,
  loadMs: number,
  made: (browserContextId: string) => void,
): Promise<VisualCheckResult> => {
  const { warnings, heard } = progress;

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

  progress.cdpSessionId = sessionId;

  const live = { transport, cdpSessionId: sessionId };

  const send = (method: string, params: CdpParams = {}) =>
    transport.send(method, params, sessionId);

  let loaded: () => void = () => undefined;
  const loadEvent = new Promise<void>((resolve) => (loaded = resolve));

  const body = base64FromBytes(
    new TextEncoder().encode(withVisualCheckPrelude(input.html, input.theme)),
  );

  /**
   * Answer a request the page made: its document is fulfilled, and no other document is (a navigation of the page or of a
   * frame in it would leave the CSP and the sandbox directive behind), the list's hosts pass, everything else fails.
   */
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

      if (paused.value.resourceType === "Document") {
        return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
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
    else if (event.method === "Page.loadEventFired") {
      progress.loaded = true;
      loaded();
    } else heard.onPage(event.method, event.params);
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

  progress.navigated = true;

  await send("Page.navigate", { url: VISUAL_CHECK_URL });

  // The load, the fonts and two frames, at most `loadMs` in all.
  const inTime = await within(loadMs, loadEvent, "The page's load").then(
    () => true,
    () => false,
  );

  if (inTime) await evaluate(settled(loadMs - (Date.now() - started)), true);
  else {
    warnings.push(
      `The page had not finished loading after ${loadMs / 1_000} s; it was measured as it was.`,
    );
  }

  // The frame starts at its minimum height and follows the page: its first report sets the frame's height, and each report
  // after that which fits a taller one, right after a resize, extends a streak; the page that grows after each of
  // `VISUAL_GROWTH_RESIZES` in a row would climb to the cap, and the frame freezes it (`apps/web/src/visual/height.ts`).
  const { heights } = progress;

  heights.push(await height());

  let applied: number | undefined;
  let streak = 0;

  for (let round = 0; round <= VISUAL_GROWTH_RESIZES + 2; round++) {
    const fit = fitHeight(heights.at(-1) ?? 0);

    if (applied !== undefined) {
      if (fit === applied) break;

      streak = fit > applied ? streak + 1 : 0;

      if (streak >= VISUAL_GROWTH_RESIZES) {
        progress.grows = true;
        break;
      }
    }

    applied = fit;
    await resize(fit);
    heights.push(await height());
  }

  const contentHeight = heights.at(-1) ?? 0;

  progress.screenshot = await shoot(send, input, contentHeight, warnings);

  progress.clipped =
    input.top > 0 ||
    (progress.screenshot !== undefined && input.top + progress.screenshot.height < contentHeight);

  return resultOf(progress);
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
