// What an argument form asks of the Session as the owner types, and what it keeps of the answers
// (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): a request on focus, then 120 ms after typing stops;
// one request in flight for each field, a newer keystroke cancelling the older request; answers cached for the form's life by
// the argument, its value and the other fields' values; and, while a newer answer is awaited, the last one narrowed locally
// with `rank`. Completions are never retried. Plain state with a subscription, so a test drives it with timers and the form
// only renders it.

// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off globalTimers:off -- the form's state is a few native maps and timers.

import {
  completionStatusOf,
  MAX_MCP_COMPLETE_CONTEXT_ARGUMENTS,
  MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS,
  MCP_COMPLETION_STATUS,
  type McpCompletion,
  rank,
} from "@cloudpid/protocol";

/** How long the form waits after a keystroke before it asks, in ms (it asks at once when a field takes the focus). */
export const COMPLETE_DEBOUNCE_MS = 120;

/** What one request asks: the field's own argument and value, and the other fields' non-empty values. */
export interface CompletionAsk {
  /** The field's name in the form: the Session cancels the older request of a field when a newer one comes. */
  readonly field: string;
  readonly argument: { readonly name: string; readonly value: string };
  readonly context: Readonly<Record<string, string>>;
}

/** Ask the Session; `signal` aborts when a newer keystroke, or closing the form, makes the answer useless. */
export type CompleteFn = (ask: CompletionAsk, signal: AbortSignal) => Promise<McpCompletion>;

/** How a field's suggestions stand. */
export type SuggestionStatus =
  | "idle"
  | "loading"
  | "ok"
  /** The server does not declare completions, or this Session cannot ask: nothing is asked again. */
  | "unsupported"
  /** A stdio server whose Container is not running, which a completion never starts: nothing is asked again. */
  | "not_running"
  /** The server wants the owner signed in: nothing is asked again. */
  | "sign_in"
  /** The last request failed or timed out: the next value is asked as usual. */
  | "failed";

/** A field's suggestions as the form shows them. */
export interface FieldSuggestions {
  readonly status: SuggestionStatus;
  /** What the last answer held, in the server's order. */
  readonly values: readonly string[];
  readonly total?: number | undefined;
  /** The server has more than `values` holds: the form says to keep typing. */
  readonly hasMore: boolean;
  /** The value `values` answered; they are narrowed locally for any other. */
  readonly answered: string | undefined;
}

const NOTHING: FieldSuggestions = {
  status: "idle",
  values: [],
  hasMore: false,
  answered: undefined,
};

/** The statuses after which nothing is asked of the server again, whatever the field. */
const BLOCKING: ReadonlySet<SuggestionStatus> = new Set(["unsupported", "not_running", "sign_in"]);

/** The other fields' values a completion carries: the non-empty ones, not over the bound, at most `MAX_MCP_COMPLETE_CONTEXT_ARGUMENTS`. */
export const completionContext = (
  values: Readonly<Record<string, string>>,
  except: string,
): Record<string, string> => {
  const context: Record<string, string> = {};
  let count = 0;

  for (const [name, value] of Object.entries(values)) {
    if (name === except || value.trim() === "") continue;

    if (value.length > MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS) continue;

    if (count >= MAX_MCP_COMPLETE_CONTEXT_ARGUMENTS) break;

    context[name] = value;
    count += 1;
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- an open dictionary of the fields, filled key by key
  return context;
};

/** The key an answer is cached under: the form's server and ref (`scope`), the argument, its value and the context. */
const cacheKey = (scope: string, ask: CompletionAsk): string =>
  JSON.stringify([
    scope,
    ask.argument.name,
    ask.argument.value,
    Object.entries(ask.context).toSorted(([a], [b]) => a.localeCompare(b)),
  ]);

/** What a form does with its completions. */
export interface Completer {
  /** A field took the focus with `value`: asks at once. */
  readonly focus: (field: string, value: string, values: Readonly<Record<string, string>>) => void;
  /** A field's value changed: cancels the request in flight for it, and asks once typing stops. */
  readonly edit: (field: string, value: string, values: Readonly<Record<string, string>>) => void;
  /** The field's suggestions now. */
  readonly state: (field: string) => FieldSuggestions;
  /** The values to list under the field for `value`: the answer's own, or the last answer narrowed to it. */
  readonly suggestions: (field: string, value: string) => readonly string[];
  /** Notified after every change of any field's state. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The form closed: every request is cancelled, every timer cleared, nothing more is asked or told. */
  readonly close: () => void;
}

/**
 * The completions of one form. `scope` names its server and ref, so a cache is never shared between forms; `debounceMs` is
 * the wait after a keystroke (`COMPLETE_DEBOUNCE_MS`).
 */
export const createCompleter = (options: {
  readonly scope: string;
  readonly complete: CompleteFn;
  readonly debounceMs?: number;
}): Completer => {
  const debounceMs = options.debounceMs ?? COMPLETE_DEBOUNCE_MS;
  const fields = new Map<string, FieldSuggestions>();
  const cache = new Map<string, McpCompletion>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const flying = new Map<string, { readonly stop: AbortController; readonly token: number }>();
  const listeners = new Set<() => void>();
  let tokens = 0;
  let blocked: SuggestionStatus | undefined;
  let closed = false;

  const tell = () => {
    // A listener may unsubscribe as it is told, so the set is copied.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) listener();
  };

  const state = (field: string): FieldSuggestions => {
    const own = fields.get(field) ?? NOTHING;

    return blocked === undefined ? own : { ...NOTHING, status: blocked };
  };

  const set = (field: string, next: FieldSuggestions) => {
    fields.set(field, next);
    tell();
  };

  /** What a field shows for an answer to `value`. */
  const answered = (answer: McpCompletion, value: string): FieldSuggestions => {
    const status = completionStatusOf(answer.status);

    if (status === MCP_COMPLETION_STATUS.ok) {
      return {
        status: "ok",
        values: answer.values,
        total: answer.total,
        hasMore: answer.hasMore,
        answered: value,
      };
    }

    // SAFETY: `status` is one of the other `MCP_COMPLETION_STATUS` values, each of which is a `SuggestionStatus`.
    return { ...NOTHING, status: status as SuggestionStatus };
  };

  /** Cancel the request in flight for `field`, and the ask waiting for its debounce. */
  const cancel = (field: string) => {
    const timer = timers.get(field);

    if (timer !== undefined) clearTimeout(timer);

    timers.delete(field);

    const running = flying.get(field);

    if (running !== undefined) {
      flying.delete(field);
      running.stop.abort();
    }
  };

  const ask = (field: string, value: string, values: Readonly<Record<string, string>>) => {
    if (closed || blocked !== undefined) return;

    // A value over the bound is not asked about: a suggestion depends on what the owner types first.
    if (value.length > MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS) return;

    const request: CompletionAsk = {
      field,
      argument: { name: field, value },
      context: completionContext(values, field),
    };

    const hit = cache.get(cacheKey(options.scope, request));

    cancel(field);

    if (hit !== undefined) {
      set(field, answered(hit, value));

      return;
    }

    const stop = new AbortController();

    tokens += 1;

    const token = tokens;
    const before = fields.get(field) ?? NOTHING;

    flying.set(field, { stop, token });
    // The last answer stays, narrowed, while the next is awaited.
    set(field, { ...before, status: "loading" });

    const settle = (answer: McpCompletion) => {
      // A newer request took the field's place, or the form closed: this answer is for a value nobody has now.
      if (closed || flying.get(field)?.token !== token) return;

      flying.delete(field);

      const next = answered(answer, value);

      if (next.status === "ok") cache.set(cacheKey(options.scope, request), answer);

      if (BLOCKING.has(next.status)) blocked = next.status;

      set(field, next);
    };

    options.complete(request, stop.signal).then(settle, () => {
      settle({ status: MCP_COMPLETION_STATUS.failed, values: [], hasMore: false });
    });
  };

  return {
    focus: (field, value, values) => {
      ask(field, value, values);
    },
    edit: (field, value, values) => {
      if (closed) return;

      // The request in flight is for a value the owner has typed past: it is cancelled now, not when the next is sent.
      cancel(field);

      if (blocked !== undefined) return;

      const before = fields.get(field) ?? NOTHING;

      // Nothing waits any more, but what the last answer holds is narrowed to the new value as it is typed.
      if (before.status === "loading")
        set(field, { ...before, status: before.values.length > 0 ? "ok" : "idle" });

      timers.set(
        field,
        setTimeout(() => {
          timers.delete(field);
          ask(field, value, values);
        }, debounceMs),
      );
    },
    state,
    suggestions: (field, value) => {
      const own = state(field);

      if (own.values.length === 0) return [];

      return own.answered === value ? own.values : rank(value, own.values, (each) => each);
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;

      for (const field of [...fields.keys(), ...timers.keys(), ...flying.keys()]) cancel(field);

      listeners.clear();
    },
  };
};

/** The line a field's status says under it, or undefined when it says none (`server` is the configured name). */
export const suggestionNote = (
  suggestions: FieldSuggestions,
  server: string,
): { readonly kind: "text" | "sign_in"; readonly text: string } | undefined => {
  switch (suggestions.status) {
    case "loading":
      return { kind: "text", text: "Loading suggestions…" };
    case "failed":
      return { kind: "text", text: "Suggestions unavailable" };
    case "sign_in":
      return { kind: "sign_in", text: `Sign in to ${server} for suggestions` };
    case "not_running":
      return { kind: "text", text: `Suggestions once ${server} is running` };
    case "ok":
      return suggestions.hasMore
        ? {
            kind: "text",
            text:
              suggestions.total === undefined
                ? "More suggestions: keep typing"
                : `${suggestions.total} suggestions: keep typing`,
          }
        : undefined;
    default:
      return undefined;
  }
};
