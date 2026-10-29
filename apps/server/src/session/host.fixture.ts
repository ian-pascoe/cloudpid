// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off globalDateInEffect:off preferEffectArray:off preferEffectRecord:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` and its `SessionSockets` over the faux provider,
// as the Session DO hosts them over the model proxy. Tests drive it with `runInDurableObject()` and client sockets,
// evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import { callDurable, defineEffectTool, Harness } from "@cloudpid/effect-durable";
import {
  Browser,
  BrowserError,
  BrowserHost,
  type BrowserHostService,
  BrowserSession,
  BrowserHandoffs,
  browserPaneLayer,
  type HandoffStartInput,
  type HandoffStatus,
  imageLimitedModels,
  LIVE_VIEW_HANDOFF_OVER,
  type LiveViewLinks,
  makeBrowserSession,
  OWNER_TAB_GONE,
  type OwnerTabDrivers,
  type OwnerTabLinks,
  type OwnerTabListing,
  type OwnerTabPageRead,
} from "@cloudpid/extensions/browser";
import { readingOwnerTabPages } from "@cloudpid/extensions/browser/pages.testing";
import {
  type AgentChangeLog,
  DeployCredentials,
  Environments,
  EnvironmentTools,
} from "@cloudpid/extensions/environment";
import { ApprovalTools, EnvironmentRemoval } from "@cloudpid/extensions/approval-tools";
import { Approvals } from "@cloudpid/extensions/approvals";
import { Instructions, InstructionsSettings } from "@cloudpid/extensions/instructions";
import { OwnerNotifications } from "@cloudpid/extensions/notify";
import { SettingsAccess, type SettingsReload, SettingsTools } from "@cloudpid/extensions/settings";
import { scrubbingModels, Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { Todo, TodoDoc } from "@cloudpid/extensions/todo";
import type {
  Annotation,
  AnnotationDraft,
  Catalog,
  ChangeFile,
  CommandOutcome,
  CompareResult,
  Comparison,
  ConversationId,
  FileMatches,
  HistoryPage,
  LastRun,
  Navigated,
  PullList,
  RunDiff,
  SessionAgent,
  SessionTree,
  SettingsOverridesState,
  ViewedFile,
  WorkspaceChanges,
} from "@cloudpid/protocol";
import { ToolSearch, ToolSearchSettings } from "@cloudpid/extensions/tool-search";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  type AgentChange,
  defineExtension,
  type EntryRecord,
  type Extension,
  type HarnessOptions,
  ROOT_CONVERSATION_ID,
  type SnapshotEvent,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import type * as Types from "effect/Types";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { testEnvironments, unusedRemoval } from "./environments.fixture.ts";
import type { SettingsChange } from "../registry/settings-changes.ts";
import { type SettingsRegistry, sessionSettingsAccess } from "./settings-access.ts";
import { sessionBrowserHandoffsLayer } from "./handoffs.ts";
import type { HeldStop } from "../workspace/idle.ts";
import { sessionOwnerTabDriversLayer } from "./owner-tab-drivers.ts";
import { pricedModels, REQUEST_COST } from "./priced.fixture.ts";
import { sessionTotals } from "./spend.ts";
import { sessionSecretsLayer } from "./secrets.ts";
import { sessionApprovalsLayer } from "./approvals.ts";
import {
  instructionsSettings,
  reloadSessionExtensions,
  SessionSettings,
  sessionSettingsLayer,
  type SettingsSource,
  toolSearchSettings,
} from "./settings.ts";
import {
  type Answer,
  SessionHost,
  sessionHostLayer,
  type SessionHostService,
  type SlashCommand,
} from "./host.ts";
import type { NavigateRequest } from "./branches.ts";
import { fillSession, type ForkPlan, type ForkSourceRequest } from "./fork.ts";
import { destroySession } from "./lifecycle.ts";
import { onIdle, wakeAt } from "./wake.ts";
import {
  annotationsMessage,
  send,
  SessionSockets,
  sessionSocketsLayer,
  type SessionSocketsService,
  viewedMessage,
} from "./sockets.ts";
import { ViewedStore, viewedStoreLayer, type ViewedStoreService } from "./viewed.ts";
import {
  AnnotationStore,
  annotationStoreLayer,
  type AnnotationStoreService,
} from "./annotations.ts";
import { SessionReviews, sessionReviewsLayer, type SessionReviewsService } from "./reviews.ts";
import {
  type ChangesSource,
  SessionChanges,
  sessionChangesLayer,
  type SessionChangesService,
} from "./changes.ts";
import {
  type CompareQuery,
  type ComparisonsSource,
  SessionComparisons,
  sessionComparisonsLayer,
} from "./comparisons.ts";
import { type RunsSource, runsOpeningTools, SessionRuns, sessionRunsLayer } from "./runs.ts";
import type { PushEvent } from "../push/notification.ts";
import { ReportError, SessionRegistry, type SessionStatus } from "./status.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

/** How long after an agent's write the test Session lists the Changes again. */
export const CHANGES_TEST_DEBOUNCE_MS = 100;

const CHANGES_FIXTURE_KEY = "test:changes";
const CHANGES_CALLS_KEY = "test:changes-calls";

/** The Changes a test Session's Workspace lists (`setChanges`). */
export type ChangesFixture = {
  /** As the Container lists them, or the Workspace DO itself. */
  readonly running: WorkspaceChanges;
  /** As a listing that may not start the Container shows them, until one that may has run. */
  readonly stopped?: WorkspaceChanges;
  readonly delayMs?: number;
  readonly fails?: boolean;
  readonly started?: boolean;
  /** Each file's working text, by `repo/path`; one not named reads as its own name. */
  readonly files?: Readonly<Record<string, string>>;
};

const COMPARISON_FIXTURE_KEY = "test:comparison";
const COMPARE_CALLS_KEY = "test:compare-calls";
const RUN_FIXTURE_KEY = "test:run";
const RUN_CALLS_KEY = "test:run-calls";
const RUN_HANG_KEY = "test:run-hang-start";
const RUN_END_DELAY_KEY = "test:run-end-delay";

/** A call the fake Workspace was made: the request of a start or of an end. */
type RecordedRunCall =
  | { readonly start: Parameters<RunsSource["start"]>[0] }
  | { readonly end: Parameters<RunsSource["end"]>[0] };

/** What the Session's Workspace answers for the Last run: its Run diff, and each file's sides by `repo/path`. */
export type RunFixture = {
  readonly diff: RunDiff | null;
  readonly files?: Readonly<Record<string, ChangeFile>>;
};

/** The Comparisons a test Session's Workspace makes (`setComparison`). */
export type ComparisonFixture = {
  /** What `compare` answers for each repo. */
  readonly results: Readonly<Record<string, CompareResult>>;
  /** Each file's text on the head, by `repo/path`; one not named reads as its own name. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * The open pull requests `comparison_sources` lists (when asked for them), by repo. A pull request's `compare` is
   * answered from `results` under `repo#number`.
   */
  readonly pulls?: Readonly<Record<string, PullList>>;
};

/** A tool to call, so a Run has a tool call in its transcript: `echo` answers `echo: <text>`. */
const Echo = defineEffectTool({
  name: "echo",
  description: "Echo text back",
  parameters: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: [{ type: "text", text: `echo: ${text}` }] }),
});

/** A tool that writes (`WRITING_TOOLS`), for the Sessions named `runs-…`: it changes nothing, but a Run opens at its call. */
const Write = defineEffectTool({
  name: "write",
  description: "Write a file",
  parameters: Schema.Struct({ path: Schema.String }),
  execute: ({ path }) => Effect.succeed({ output: [{ type: "text", text: `wrote ${path}` }] }),
});

/** The credential in every Live View link the test browser host mints, to look for where it must not be. */
export const LIVE_VIEW_TOKEN = "SECRET-LIVE-VIEW-TOKEN";

/** The Live View links the test browser host mints: recognisable, so a test can look for them where they must not be. */
export const LIVE_VIEW_LINKS: LiveViewLinks = {
  tab: {
    targetId: "tab-1",
    link: `wss://live.browser.run/api/devtools/browser/s/page/tab-1?jwt=${LIVE_VIEW_TOKEN}`,
  },
  windows: [
    {
      targetId: "popup-1",
      openerId: "tab-1",
      title: "Sign in",
      link: `wss://live.browser.run/api/devtools/browser/s/page/popup-1?jwt=${LIVE_VIEW_TOKEN}`,
    },
  ],
};

/** The Browser Pane's links the test browser host mints, to the Owner tab and a window it opened: recognisable too. */
export const OWNER_TAB_LINKS: OwnerTabLinks = {
  ownerTabId: "owner-1",
  tab: {
    targetId: "owner-tab-1",
    link: `wss://live.browser.run/api/devtools/browser/s/page/owner-tab-1?jwt=${LIVE_VIEW_TOKEN}`,
  },
  windows: [
    {
      targetId: "owner-popup-1",
      openerId: "owner-tab-1",
      title: "Sign in",
      link: `wss://live.browser.run/api/devtools/browser/s/page/owner-popup-1?jwt=${LIVE_VIEW_TOKEN}`,
    },
  ],
  opened: false,
  replaced: false,
};

/** How long one round of waiting on the test browser host lasts at most, and how long a call may wait past a deadline. */
const HANDOFF_ROUND_MS = 10_000;
const HANDOFF_GRACE_MS = 50;

/** The object's key-value storage, as the test browser host uses it. */
type Kv = DurableObjectStorage["kv"];

/** The Owner tabs of the test browser host, in the object's storage. */
const ownerTabListing = (kv: Kv): OwnerTabListing =>
  kv.get<OwnerTabListing>("owner-tab-list") ?? { tabs: [] };

/** Rounds of waiting on a handoff, which end early when the test completes it. */
const roundWaiters = new Map<string, () => void>();

/**
 * A browser host that hands a tab over at once and finishes the handoff when the test says (`completeHandoff`). Its
 * state is in the object's storage, as the real host's is in its own object: it outlives an instance of the Session.
 */
const testBrowserHost = (kv: Kv): BrowserHostService => ({
  describe: Effect.succeed("Drives a browser."),
  run: (input) =>
    Effect.sync(() => {
      kv.put("browser-runs", [...(kv.get<unknown[]>("browser-runs") ?? []), input]);

      return { output: [{ type: "text", text: "ok" }] };
    }),
  close: Effect.sync(() => {
    kv.put("browser-closes", (kv.get<number>("browser-closes") ?? 0) + 1);

    return false;
  }),
  startHandoff: (input) =>
    Effect.sync(() => {
      kv.put("handoff-starts", [...(kv.get<HandoffStartInput[]>("handoff-starts") ?? []), input]);

      if (kv.get<HandoffStatus>(`handoff-status:${input.requestId}`) === undefined) {
        kv.put(`handoff-status:${input.requestId}`, { state: "waiting" } satisfies HandoffStatus);
      }

      return { startedAt: Date.now() };
    }),
  liveView: (requestId) =>
    kv.get<HandoffStatus>(`handoff-status:${requestId}`)?.state === "waiting"
      ? Effect.sync(() => {
          kv.put("live-views", [...(kv.get<string[]>("live-views") ?? []), requestId]);

          return LIVE_VIEW_LINKS;
        })
      : Effect.fail(BrowserError.make({ message: `liveView: Error: ${LIVE_VIEW_HANDOFF_OVER}` })),
  waitHandoff: (requestId, maxMs) =>
    Effect.promise(
      () =>
        new Promise<HandoffStatus>((resolve) => {
          const status = () =>
            kv.get<HandoffStatus>(`handoff-status:${requestId}`) ?? { state: "unknown" as const };

          if (status().state !== "waiting") {
            resolve(status());

            return;
          }

          // A round that ends on a timer is a pending timer, which keeps workerd from evicting the object: a test that
          // evicts it mid-wait asks for rounds with no timer (`quiet`), which end only when the test completes the handoff.
          const timer =
            kv.get<boolean>("handoff-quiet") === true
              ? undefined
              : setTimeout(() => resolve(status()), maxMs);

          roundWaiters.set(requestId, () => {
            clearTimeout(timer);
            resolve(status());
          });
        }),
    ),
  ownerTabView: (open) =>
    Effect.suspend(() => {
      kv.put("owner-tab-views", [...(kv.get<boolean[]>("owner-tab-views") ?? []), open]);

      // The Owner tab is there once a Pane opened it, until the test says its browser is gone; a new one replaces it.
      const opened = open && kv.get<boolean>("owner-tab") !== true;
      const replaced = opened && kv.get<boolean>("owner-tab-lost") === true;

      if (opened) {
        kv.put("owner-tab", true);
        kv.delete("owner-tab-lost");
      }

      return kv.get<boolean>("owner-tab") === true
        ? Effect.succeed({ ...OWNER_TAB_LINKS, opened, replaced })
        : Effect.fail(BrowserError.make({ message: `ownerTabView: Error: ${OWNER_TAB_GONE}` }));
    }),
  ownerTabs: Effect.sync(() => {
    kv.put("owner-tab-lists", (kv.get<number>("owner-tab-lists") ?? 0) + 1);

    return ownerTabListing(kv);
  }),
  openOwnerTab: Effect.sync(() => {
    const { tabs } = ownerTabListing(kv);
    const id = `owner-tab-${tabs.length + 1}`;

    kv.put("owner-tab-list", { tabs: [...tabs, { id, title: "" }], shown: id });

    return ownerTabListing(kv);
  }),
  showOwnerTab: (id) =>
    Effect.suspend(() => {
      const { tabs } = ownerTabListing(kv);

      if (!tabs.some((tab) => tab.id === id)) {
        return Effect.fail(
          BrowserError.make({ message: `showOwnerTab: Error: ${OWNER_TAB_GONE}` }),
        );
      }

      kv.put("owner-tab-list", { tabs, shown: id });

      return Effect.succeed(ownerTabListing(kv));
    }),
  closeOwnerTab: (id) =>
    Effect.sync(() => {
      const { tabs, shown } = ownerTabListing(kv);
      const left = tabs.filter((tab) => tab.id !== id);

      kv.put(
        "owner-tab-list",
        shown === undefined || shown === id ? { tabs: left } : { tabs: left, shown },
      );

      return ownerTabListing(kv);
    }),
  readOwnerTabPages: readingOwnerTabPages({
    open: () => kv.get<OwnerTabPageRead[]>("owner-tab-pages") ?? [],
    reading: (ids) => {
      kv.put("owner-tab-reads", [...(kv.get<string[][]>("owner-tab-reads") ?? []), [...ids]]);
    },
    // A page called "slow" takes a moment to read, for the tests of arrival order.
    delayMs: (ids) => (ids.includes("slow") ? 150 : 0),
  }),
  endHandoff: (requestId) =>
    Effect.sync(() => {
      kv.put("handoff-ended", [...(kv.get<string[]>("handoff-ended") ?? []), requestId]);
      kv.delete(`handoff-status:${requestId}`);

      return { windowOrigins: kv.get<string[]>("handoff-windows") ?? [] };
    }),
});

/** The models the test provider serves: those the default settings and a Session's choice may name. */
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export { REQUEST_COST };

/** The model and thinking level a request asked for. */
export type TestRequest = { readonly model: string; readonly thinking: string | undefined };

/** A request for a Session title as the model received it: the model asked, and its messages (system prompt included) as JSON. */
export type TitleRequest = { readonly model: string; readonly messages: string };

/** A scripted response that calls tool `name` with the JSON arguments `args`. */
const CALL = /^call:(\w+):(.*)$/;

/**
 * Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort,
 * `call:<tool>:<json arguments>` calls a tool, and `gate:<response>` gives `response` once the test opens the gate.
 */
type Script = { readonly responses: readonly string[]; readonly next: number };

/** The scripted response `text`: a tool call or an answer. */
const respond = (text: string) => {
  const call = CALL.exec(text);

  // `error:<message>` is a model error that is not worth retrying.
  if (text.startsWith("error:")) {
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: text.slice("error:".length),
    });
  }

  return call === null
    ? fauxAssistantMessage(text)
    : fauxAssistantMessage([fauxToolCall(call[1] ?? "", JSON.parse(call[2] ?? "{}"))], {
        stopReason: "toolUse",
      });
};

declare global {
  /** See `constructions`. */
  var testSessionConstructions: Map<string, number> | undefined;
}

/**
 * How many instances of each test Session were constructed, by object ID. Kept in the isolate's global scope, which
 * the tests share, so a test can read it without waking an object.
 */
export const constructions = (globalThis.testSessionConstructions ??= new Map<string, number>());

/** Text submitted to the root conversation, as the tests write it. */
type TestPrompt = { readonly requestId: string; readonly text: string };

/** The test Worker's `SECRETS_ENCRYPTION_KEY`. */
const SECRETS_KEY = Redacted.make("test-secrets-encryption-key-0123456789abcdef");

export class TestSession extends DurableObject {
  /**
   * The extensions this Session runs with, installed before any work resumes: `echo`, which uses Secrets, the secret
   * tools, the browser tools over a test browser host, and `todo`; for a Session whose name starts with
   * `environment-`, the `environment_*` tools over `testEnvironments`; for one whose name starts with `settings-`,
   * the `settings_*` tools and those that wait for Approval over the test Registry's Settings; for one whose name
   * starts with `instructions-`, the `owner_instructions` section over the Instructions the Session last read; and, for
   * one whose name starts with `tool-search-`, `tool_search` over the Registry's offered tools, which is installed
   * again when they change.
   */
  protected hostExtensions(): Effect.Effect<
    readonly Extension[],
    never,
    | Harness
    | Secrets
    | BrowserHandoffs
    | OwnerTabDrivers
    | SessionSettings
    | AgentChangeLog
    | SettingsReload
    | Approvals
    | SessionRuns
  > {
    const { kv } = this.ctx.storage;
    const writing = this.ctx.id.name?.startsWith("runs-") === true;
    const searching = this.#searching();
    const changing = this.ctx.id.name?.startsWith("environment-") === true;
    const configuring = this.ctx.id.name?.startsWith("settings-") === true;
    const instructing = this.ctx.id.name?.startsWith("instructions-") === true;
    const settingsRegistry = this.#settingsRegistry();
    const session = this.ctx.id.name;

    return Effect.gen(function* () {
      const tool = yield* Echo;
      const echo = defineExtension({ name: "echo", tools: [tool] });
      const host = testBrowserHost(kv);

      const browser = yield* Browser.pipe(
        Effect.provideService(BrowserHost, host),
        Effect.provideService(BrowserSession, makeBrowserSession({ host, storage: kv })),
      );

      const environment = changing
        ? [
            yield* EnvironmentTools.pipe(
              Effect.provideService(Environments, testEnvironments(kv)),
              Effect.provideService(DeployCredentials, { values: [] }),
            ),
          ]
        : [];

      const settings = configuring
        ? [
            yield* SettingsTools.pipe(
              Effect.provideService(
                SettingsAccess,
                sessionSettingsAccess({ registry: settingsRegistry, session }),
              ),
              Effect.provideService(DeployCredentials, { values: [] }),
            ),
            yield* ApprovalTools.pipe(
              Effect.provideService(
                SettingsAccess,
                sessionSettingsAccess({ registry: settingsRegistry, session }),
              ),
              Effect.provideService(Environments, testEnvironments(kv)),
              Effect.provideService(EnvironmentRemoval, unusedRemoval),
              Effect.provideService(DeployCredentials, { values: [] }),
            ),
          ]
        : [];

      const writer = writing ? [defineExtension({ name: "writer", tools: [yield* Write] })] : [];

      const instructions = instructing
        ? [
            yield* Instructions.pipe(
              Effect.provideServiceEffect(InstructionsSettings, instructionsSettings),
            ),
          ]
        : [];

      const extensions = [
        echo,
        ...writer,
        ...instructions,
        ...environment,
        ...settings,
        yield* secretsExtension([tool]),
        browser,
        yield* Todo,
      ];

      if (writing) {
        const runs = yield* SessionRuns;

        return [
          ...extensions,
          runsOpeningTools(
            Arr.flatMap(extensions, (extension) => extension.tools ?? []),
            runs,
          ),
        ];
      }

      if (!searching) return extensions;

      const search = yield* ToolSearch(
        Arr.flatMap(extensions, (extension) => Arr.map(extension.tools ?? [], (each) => each.name)),
      ).pipe(Effect.provideServiceEffect(ToolSearchSettings, toolSearchSettings));

      return [...extensions, search];
    });
  }

  /** Whether this Session defers the tools its settings do not offer (the tests that look at it name it so). */
  #searching(): boolean {
    return this.ctx.id.name?.startsWith("tool-search-") === true;
  }

  /** What builds a conversation's execution environment, if this Session has one. */
  protected hostEnv(): HarnessOptions["env"] | undefined {
    return undefined;
  }

  /** What builds a conversation's environment for the composer's lookups, if not `hostEnv`'s. */
  protected hostLookupEnv(): HarnessOptions["env"] | undefined {
    return undefined;
  }

  /** The spans this instance's Effects made, in the order they started. */
  readonly #spans: Tracer.NativeSpan[] = [];
  #host!: SessionHostService;
  #sockets!: SessionSocketsService;
  #changes!: SessionChangesService;
  #annotations!: AnnotationStoreService;
  #viewed!: ViewedStoreService;
  #reviews!: SessionReviewsService;
  #runtime!: ManagedRuntime.ManagedRuntime<
    | SessionHost
    | SessionSockets
    | SessionChanges
    | SessionComparisons
    | Harness
    | Secrets
    | AnnotationStore
    | ViewedStore
    | SessionReviews,
    unknown
  >;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Holds back this instance's `gate:` responses until `open()`. */
  readonly #gate = Promise.withResolvers<void>();
  /** Resolves when this instance's model request reaches the gate. */
  readonly gated = Promise.withResolvers<void>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    constructions.set(ctx.id.toString(), (constructions.get(ctx.id.toString()) ?? 0) + 1);

    // As the model proxy's provider is named, so the settings' model ids resolve.
    const faux = fauxProvider({
      provider: "anthropic",
      models: Arr.map(MODELS, (id) => ({ id, reasoning: true })),
    });

    faux.setResponses(Array.from({ length: 8 }, () => this.#step()));

    const models = createModels();

    models.setProvider(faux.provider);

    const browser = makeBrowserSession({
      host: testBrowserHost(ctx.storage.kv),
      storage: ctx.storage.kv,
    });

    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionSocketsLayer(ctx).pipe(
          Layer.provideMerge(sessionReviewsLayer(ctx.storage.kv)),
          Layer.provideMerge(
            sessionHostLayer({
              storage: ctx.storage,
              // As the Session DO's: every model call is scrubbed of the Secrets the Session holds.
              models: Effect.map(Effect.service(Secrets), (held) =>
                scrubbingModels(imageLimitedModels(pricedModels(models, REQUEST_COST)), held),
              ),
              reset: (reason) => ctx.abort(reason),
              extensions: this.hostExtensions(),
              onSettled: (newest) =>
                Effect.flatMap(Effect.service(SessionRuns), (runs) => runs.settled(newest)),
              reload: this.#searching() ? reloadSessionExtensions : undefined,
              env: this.hostEnv(),
              lookupEnv: this.hostLookupEnv(),
              // The Workspace's side of the hold cap: the activity noted is counted, and the held stops are what a
              // test put in `held-stops`.
              workspaceActivity: async () => {
                ctx.storage.kv.put(
                  "workspace-activity",
                  (ctx.storage.kv.get<number>("workspace-activity") ?? 0) + 1,
                );
              },
              containerHeldStops: async (after) =>
                Arr.filter(
                  ctx.storage.kv.get<ReadonlyArray<HeldStop>>("held-stops") ?? [],
                  (stop) => stop.at > after,
                ),
              // Short only for a Registry that hangs; a loaded runner can take longer than that for a report that
              // lands, which would count it failed and report it again.
              reportTimeout:
                ctx.storage.kv.get<string>("reportMode") === "hanging" ? "200 millis" : "5 seconds",
              // As the Session DO's: a held Secret's expiry, or the browser's idle close.
              wakeAt: Effect.flatMap(Effect.service(Secrets), (held) => wakeAt(held, browser)),
              // And what it does when it settles: the abandoned requests dropped, an idle browser closed.
              onIdle: Effect.flatMap(
                Effect.all([
                  Effect.service(Secrets),
                  Effect.service(BrowserHandoffs),
                  Effect.service(Approvals),
                ]),
                ([held, handoffs, approvals]) => onIdle(held, browser, handoffs, approvals),
              ),
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SessionRegistry, {
                    report: (status) =>
                      Effect.tryPromise({
                        try: () => this.#report(status),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                    reportAgents: (agents) =>
                      Effect.tryPromise({
                        try: () => this.#reportAgents(agents),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                    notify: (event) =>
                      Effect.tryPromise({
                        try: () => this.#notify(event),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                    titleWanted: Effect.tryPromise({
                      try: () => this.#titleWanted(),
                      catch: (cause) => ReportError.make({ message: String(cause) }),
                    }),
                    setTitle: (title) =>
                      Effect.tryPromise({
                        try: () => this.#setTitle(title),
                        catch: (cause) => ReportError.make({ message: String(cause) }),
                      }),
                  }),
                  sessionSettingsLayer({
                    read: Effect.orDie(Effect.tryPromise(() => this.#readSettings())),
                    kv: ctx.storage.kv,
                    // No test makes the read hang, and a loaded runner can take longer than 200 ms for one that
                    // lands: the Session then ran on the defaults (a `/compact` test kept everything and compacted
                    // nothing).
                    timeout: "5 seconds",
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            browserPaneLayer({
              host: testBrowserHost(ctx.storage.kv),
              archived: Effect.sync(() => ctx.storage.kv.get<boolean>("archived") === true),
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  BrowserSession,
                  makeBrowserSession({
                    host: testBrowserHost(ctx.storage.kv),
                    storage: ctx.storage.kv,
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(
            sessionBrowserHandoffsLayer({
              host: testBrowserHost(ctx.storage.kv),
              storage: ctx.storage.kv,
              sockets: ctx,
              // A short wait and a short deadline, so a test can see a handoff time out.
              timeoutMs: ctx.storage.kv.get<number>("handoff-timeout") ?? 30 * 60_000,
              pollMs: HANDOFF_ROUND_MS,
              graceMs: HANDOFF_GRACE_MS,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    BrowserSession,
                    makeBrowserSession({
                      host: testBrowserHost(ctx.storage.kv),
                      storage: ctx.storage.kv,
                    }),
                  ),
                  Layer.succeed(OwnerNotifications, {
                    notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(sessionOwnerTabDriversLayer(ctx)),
          Layer.provideMerge(
            sessionChangesLayer(
              // The test Session has no subagents, so no Subagent Workspace is ever listed.
              {
                session: this.#changesSource(),
                subagent: (workspace) => ({
                  list: () => Promise.reject(new Error(`No Workspace ${workspace.id} here`)),
                  file: () => Promise.reject(new Error(`No Workspace ${workspace.id} here`)),
                }),
              },
              { debounceMs: CHANGES_TEST_DEBOUNCE_MS },
            ),
          ),
          Layer.provideMerge(sessionComparisonsLayer(this.#comparisonsSource())),
          Layer.provideMerge(
            sessionRunsLayer(this.#runsSource(), ctx.storage.kv, {
              announce: (lastRun) =>
                Effect.forEach(
                  ctx.getWebSockets(),
                  (socket) => send(socket, { type: "last_run", lastRun }),
                  { discard: true },
                ),
              newId: () => `run${String(this.ctx.storage.kv.get<number>("test:run-id") ?? 0)}`,
              // A copy that never answers is given up on quickly.
              writeDeadlineMs: 200,
              endDeadlineMs: 200,
            }),
          ),
          Layer.provideMerge(
            annotationStoreLayer({
              storage: ctx.storage.kv,
              announce: (drafts) =>
                Effect.forEach(
                  ctx.getWebSockets(),
                  (socket) => send(socket, annotationsMessage(drafts)),
                  {
                    discard: true,
                  },
                ),
            }),
          ),
          Layer.provideMerge(
            viewedStoreLayer({
              storage: ctx.storage.kv,
              announce: (viewed) =>
                Effect.forEach(
                  ctx.getWebSockets(),
                  (socket) => send(socket, viewedMessage(viewed)),
                  {
                    discard: true,
                  },
                ),
            }),
          ),
          Layer.provideMerge(
            sessionApprovalsLayer({
              storage: ctx.storage.kv,
              sockets: ctx,
              notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
            }),
          ),
          Layer.provideMerge(
            sessionSecretsLayer({
              encryptionKey: SECRETS_KEY,
              session: ctx.id.toString(),
              storage: ctx.storage.kv,
              sockets: ctx,
              notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
            }),
          ),
          // The spans this instance's Effects make, kept to read.
          Layer.provideMerge(
            Layer.succeed(
              Tracer.Tracer,
              Tracer.make({
                span: (options) => {
                  const span = new Tracer.NativeSpan(options);

                  this.#spans.push(span);

                  return span;
                },
              }),
            ),
          ),
        ),
      );

      const context = await this.#runtime.context();

      this.#host = Context.get(context, SessionHost);
      this.#sockets = Context.get(context, SessionSockets);
      this.#changes = Context.get(context, SessionChanges);
      this.#annotations = Context.get(context, AnnotationStore);
      this.#viewed = Context.get(context, ViewedStore);
      this.#reviews = Context.get(context, SessionReviews);
    });
  }

  /** The Viewed boxes as the Session keeps them. */
  viewed(): Promise<ReadonlyArray<ViewedFile>> {
    return Effect.runPromise(this.#viewed.list);
  }

  /** A pull request's Comparison was made for a client: its Viewed boxes are checked, as the sockets do. */
  comparedPull(comparison: Comparison): Promise<void> {
    return Effect.runPromise(this.#viewed.reset(comparison));
  }

  /** The draft Annotations as the Session keeps them. */
  annotations(): Promise<ReadonlyArray<Annotation>> {
    return Effect.runPromise(this.#annotations.list);
  }

  /** Save `draft` as a client's `annotation_save` does, without telling the clients more than it would. */
  saveAnnotation(draft: AnnotationDraft): Promise<void> {
    return this.#runtime.runPromise(this.#annotations.save(draft));
  }

  /** A subagent was deleted: drop the drafts addressed to it, as the Session DO does after `deleteSubagent`. */
  pruneAnnotations(): Promise<void> {
    return Effect.runPromise(this.#reviews.prune);
  }

  /**
   * The Changes as the test set them (`setChanges`): the `running` list while the Container runs or a listing may start
   * it, else the `stopped` one. Each listing is recorded, by whether it may start the Container, and takes `delayMs`.
   */
  #changesSource(): ChangesSource {
    const kv = this.ctx.storage.kv;

    return {
      list: async (startContainer) => {
        const fixture = kv.get<ChangesFixture>(CHANGES_FIXTURE_KEY);

        kv.put(CHANGES_CALLS_KEY, [
          ...(kv.get<boolean[]>(CHANGES_CALLS_KEY) ?? []),
          startContainer,
        ]);

        if (fixture === undefined) return null;

        await new Promise((resolve) => setTimeout(resolve, fixture.delayMs ?? 0));

        if (fixture.fails === true) throw new Error("The Workspace is unreachable");

        if (startContainer) kv.put(CHANGES_FIXTURE_KEY, { ...fixture, started: true });

        return startContainer || fixture.started === true
          ? fixture.running
          : (fixture.stopped ?? fixture.running);
      },
      file: async (query) => {
        if (query.path === "missing") throw new Error("No such file in the Workspace's repos");

        const key = `${query.repo}/${query.path}`;
        const text = kv.get<ChangesFixture>(CHANGES_FIXTURE_KEY)?.files?.[key] ?? `${key}\n`;

        return { old: null, new: { kind: "text", text } };
      },
    };
  }

  /** The Comparisons as the test set them (`setComparison`); each `compare` is recorded. */
  #comparisonsSource(): ComparisonsSource {
    const kv = this.ctx.storage.kv;

    return {
      sources: async (pulls) => ({
        repos: Object.keys(kv.get<ComparisonFixture>(COMPARISON_FIXTURE_KEY)?.results ?? {})
          .filter((repo) => !repo.includes("#"))
          .map((repo) => {
            const list = kv.get<ComparisonFixture>(COMPARISON_FIXTURE_KEY)?.pulls?.[repo];
            const head = { commit: null, branch: null };

            return pulls && list !== undefined ? { repo, head, pulls: list } : { repo, head };
          }),
      }),
      compare: async (query) => {
        kv.put(COMPARE_CALLS_KEY, [...(kv.get<unknown[]>(COMPARE_CALLS_KEY) ?? []), query]);

        const result =
          kv.get<ComparisonFixture>(COMPARISON_FIXTURE_KEY)?.results[
            query.pull === undefined ? query.repo : `${query.repo}#${query.pull}`
          ];

        if (result === undefined) throw new Error("No such repo");

        return result;
      },
      file: async (query) => {
        const key = `${query.repo}/${query.path}`;
        const text = kv.get<ComparisonFixture>(COMPARISON_FIXTURE_KEY)?.files?.[key] ?? `${key}\n`;

        return { old: null, new: { kind: "text", text } };
      },
    };
  }

  #runsSource(): RunsSource {
    const kv = this.ctx.storage.kv;

    const note = (call: RecordedRunCall) => {
      kv.put(RUN_CALLS_KEY, [...(kv.get<RecordedRunCall[]>(RUN_CALLS_KEY) ?? []), call]);
    };

    const lastRun = (
      request: {
        readonly run: string;
        readonly conversationId: number;
        readonly firstCall: string;
      },
      ended: number | null,
    ): LastRun => ({
      run: request.run,
      // SAFETY: a number is what the Session passes for a conversation ID.
      conversationId: request.conversationId as LastRun["conversationId"],
      startedAt: 1,
      endedAt: ended === null ? null : 2,
      firstCall: request.firstCall,
      until: ended,
      repos: [{ repo: "app", start: "a".repeat(40), end: ended === null ? null : "b".repeat(40) }],
    });

    return {
      start: async (request) => {
        note({ start: request });

        // A Workspace that never answers: the write must go on without the copy.
        if (kv.get<boolean>(RUN_HANG_KEY) === true) await new Promise<never>(() => undefined);

        kv.put("test:run-open", request);
        kv.delete("test:run-ended");
        kv.put("test:run-id", (kv.get<number>("test:run-id") ?? 0) + 1);

        return lastRun(request, null);
      },
      end: async (request) => {
        note({ end: request });

        // A Workspace slow to end the Run: the Session stops waiting, and is told when the answer comes.
        const delay = kv.get<number>(RUN_END_DELAY_KEY) ?? 0;

        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

        kv.put("test:run-ended", true);

        const opened = kv.get<{ conversationId: number; firstCall: string }>("test:run-open");

        return opened === undefined
          ? null
          : lastRun({ ...opened, run: request.run }, request.until);
      },
      diff: async () => {
        const fixture = kv.get<RunFixture>(RUN_FIXTURE_KEY)?.diff;

        // Live until the Session ended the Run it opened.
        return fixture === undefined || fixture === null
          ? null
          : { ...fixture, live: kv.get<boolean>("test:run-ended") !== true };
      },
      file: async (query) => {
        const key = `${query.repo}/${query.path}`;
        const file = kv.get<RunFixture>(RUN_FIXTURE_KEY)?.files?.[key];

        if (file === undefined) throw new Error("No such file");

        return file;
      },
    };
  }

  /** From now on the fake Workspace never answers a Run's start (`false`: it does again). */
  hangRunStart(hang: boolean): void {
    this.ctx.storage.kv.put(RUN_HANG_KEY, hang);
  }

  /** From now on the fake Workspace takes `ms` to end a Run. */
  delayRunEnd(ms: number): void {
    this.ctx.storage.kv.put(RUN_END_DELAY_KEY, ms);
  }

  /** What the Session's Workspace answers for the Last run from now on. */
  setRun(fixture: RunFixture): void {
    this.ctx.storage.kv.put(RUN_FIXTURE_KEY, fixture);
  }

  /** Each start and end of a Run the Workspace was asked for so far. */
  runCalls(): ReadonlyArray<RecordedRunCall> {
    return this.ctx.storage.kv.get<RecordedRunCall[]>(RUN_CALLS_KEY) ?? [];
  }

  /** What the Session's Workspace compares from now on. */
  setComparison(fixture: ComparisonFixture): void {
    this.ctx.storage.kv.put(COMPARISON_FIXTURE_KEY, fixture);
  }

  /** Each `compare` so far. */
  compareCalls(): ReadonlyArray<CompareQuery> {
    return this.ctx.storage.kv.get<CompareQuery[]>(COMPARE_CALLS_KEY) ?? [];
  }

  /** A Comparison was made for a client: the drafts on its branch are checked, as the sockets do. */
  compared(comparison: Comparison): Promise<void> {
    return Effect.runPromise(this.#reviews.compared(comparison));
  }

  /** What the Session's Workspace lists as its Changes from now on. */
  setChanges(fixture: ChangesFixture): void {
    this.ctx.storage.kv.put(CHANGES_FIXTURE_KEY, fixture);
  }

  /** Each listing of the Changes so far, by whether it could start the Container. */
  changesCalls(): boolean[] {
    return this.ctx.storage.kv.get<boolean[]>(CHANGES_CALLS_KEY) ?? [];
  }

  /** An agent wrote to the Session's Workspace, as a writing tool's call reports. */
  wrote(): void {
    this.#changes.written(undefined);
  }

  /** A client's socket to the Session, as the Session DO answers the main Worker's upgrade. */
  override async fetch(): Promise<Response> {
    return new Response(null, {
      status: 101,
      webSocket: await Effect.runPromise(this.#sockets.connect),
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await Effect.runPromise(this.#sockets.receive(socket, message));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await Effect.runPromise(this.#sockets.drop(socket));
  }

  /** Delete the Session's own state, as the Session DO's `destroy` does. */
  destroy(): Promise<void> {
    return this.#runtime.runPromise(
      destroySession({
        state: this.ctx,
        closeBrowser: testBrowserHost(this.ctx.storage.kv).close,
      }),
    );
  }

  /** Let this instance's `gate:` responses through. */
  open(): void {
    this.#gate.resolve();
  }

  /** The snapshot a client's watch of the root conversation starts with, as the Session sends it. */
  snapshot(): Promise<SnapshotEvent> {
    const host = this.#host;

    return Effect.runPromise(
      Effect.flatMap(host.root, (root) => Stream.runHead(host.events(root))).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.die("No snapshot"), onSome: Effect.succeed }),
        ),
        Effect.flatMap((batch) => {
          const [first] = batch;

          return first?.type === "snapshot" ? Effect.succeed(first) : Effect.die("Not a snapshot");
        }),
      ),
    );
  }

  /** What the Session has spent, in US dollars: every conversation's requests and the title calls'. */
  spent(): Promise<number> {
    const { kv } = this.ctx.storage;

    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        return (yield* Effect.promise(() => sessionTotals(harness.harness, kv))).cost;
      }),
    );
  }

  /** Whether no work is live; reads only, so it never runs work itself. */
  idle(): Promise<boolean> {
    return Effect.runPromise(this.#host.idle);
  }

  submit({ requestId, text }: TestPrompt): Promise<number> {
    return this.#runtime.runPromise(this.#host.submit({ requestId, input: text }));
  }

  prompt({ requestId, text }: TestPrompt): Promise<Answer> {
    return this.#runtime.runPromise(this.#host.prompt({ requestId, input: text }));
  }

  /** The spans of this instance's Effects, as a test reads them: their names and attributes, and whether they ended. */
  spans(): ReadonlyArray<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly ended: boolean;
  }> {
    return Arr.map(this.#spans, (span) => ({
      name: span.name,
      attributes: Object.fromEntries(span.attributes),
      ended: Predicate.isTagged(span.status, "Ended"),
    }));
  }

  /** What the composer of the root conversation, or of a subagent's, offers. */
  catalog(conversationId?: ConversationId): Promise<Catalog> {
    return this.#runtime.runPromise(this.#host.catalog(conversationId));
  }

  /** What the composer's `@` menu offers for `query`. */
  files(query: string): Promise<FileMatches> {
    return this.#runtime.runPromise(this.#host.files({ query }));
  }

  /** A page of the root conversation's History before entry `before`, as a client's `history` gets it. */
  history(before: number): Promise<HistoryPage> {
    return this.#runtime.runPromise(this.#host.history({ before }));
  }

  /** The Session tree, as a client's `tree` gets it. */
  tree(): Promise<SessionTree> {
    return this.#runtime.runPromise(this.#host.tree);
  }

  /** The active branch's conversation. */
  activeBranch(): Promise<ConversationId> {
    return this.#runtime.runPromise(this.#host.activeBranch);
  }

  /** Navigate the Session tree as a client's `navigate` does: where it went, or why it could not. */
  navigate(
    request: NavigateRequest,
  ): Promise<{ readonly navigated: Navigated } | { readonly failure: string }> {
    return this.#runtime.runPromise(
      this.#host.navigate(request).pipe(
        Effect.map((navigated) => ({ navigated })),
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** Make `conversationId` the active branch, as the chevrons do. */
  switchBranch(conversationId: ConversationId): Promise<void> {
    return this.#runtime.runPromise(this.#host.switchBranch(conversationId));
  }

  /**
   * Copy this Session as a Fork or Clone into the `TestSession` named `name`, through its stub, as the main Worker does.
   */
  async forkInto(name: string, request: ForkSourceRequest): Promise<ForkPlan> {
    const plan = await this.#runtime.runPromise(this.#host.forkSource(request));
    const target = this.env.SESSIONS.getByName(name);

    await this.#runtime.runPromise(
      fillSession(
        { exportEntries: this.#host.exportEntries },
        {
          importStart: Effect.promise(() => target.importStart()),
          importEntries: (entries) => Effect.promise(() => target.importEntries(entries)),
          importFinish: (finished) => Effect.promise(() => target.importFinish(finished)),
        },
        plan,
      ),
    );

    return plan;
  }

  releaseFork(): Promise<void> {
    return this.#runtime.runPromise(this.#host.releaseFork);
  }

  importStart(): Promise<void> {
    return this.#runtime.runPromise(this.#host.importStart);
  }

  importEntries(entries: ReadonlyArray<EntryRecord>): Promise<void> {
    return this.#runtime.runPromise(this.#host.importEntries(entries));
  }

  importFinish(plan: ForkPlan): Promise<void> {
    return this.#runtime.runPromise(this.#host.importFinish(plan));
  }

  copying(): Promise<boolean> {
    return this.#runtime.runPromise(this.#host.copying);
  }

  /** Run the Session's Slash command `name`: what it did, or why it could not. */
  command(
    name: string,
    args: string,
    conversationId?: ConversationId,
  ): Promise<{ readonly outcome: CommandOutcome } | { readonly failure: string }> {
    const command: Types.Mutable<SlashCommand> = { name, args };

    if (conversationId !== undefined) command.conversationId = conversationId;

    return this.#runtime.runPromise(
      this.#host.command(command).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.catch((error) => Effect.succeed({ failure: error.message })),
      ),
    );
  }

  /** The root conversation's entries, oldest first: each one's kind, data, and the text of its message. */
  rootEntries(): Promise<
    ReadonlyArray<{ readonly kind: string; readonly data: unknown; readonly text: string }>
  > {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({ order: "ascending" }, 500, undefined, context),
        );

        return Arr.map(page.items, (entry) => {
          const message = entry.model?.[0];

          const text =
            message === undefined || message.role === "system"
              ? ""
              : Predicate.isString(message.content)
                ? message.content
                : Arr.join(
                    Arr.flatMap(
                      // SAFETY: a user's, an assistant's and a tool result's content are arrays of typed blocks; only
                      // the text ones are read.
                      message.content as ReadonlyArray<{ type: string; text?: string }>,
                      (block) =>
                        block.type === "text" && block.text !== undefined ? [block.text] : [],
                    ),
                    "",
                  );

          return { kind: entry.kind, data: entry.data, text };
        });
      }),
    );
  }

  /**
   * Watch the root conversation's Todo List as a client does: `lists` gets the titles of each list sent, the first being
   * how it stands, until `stop`.
   */
  watchTodos() {
    const lists: (readonly string[])[] = [];

    const fiber = this.#runtime.runFork(
      Stream.runForEach(this.#host.todos(ROOT_CONVERSATION_ID), (tasks) =>
        Effect.sync(() => {
          lists.push(Arr.map(tasks, (task) => task.title));
        }),
      ),
    );

    return { lists, stop: () => void fiber.pipe(Fiber.interrupt, Effect.runFork) };
  }

  /** The tasks of the root conversation's Todo List. */
  todoTitles(): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        const state = yield* callDurable("snapshot", (context) =>
          harness.harness.snapshot(TodoDoc, ROOT_CONVERSATION_ID, context),
        );

        return Arr.map(state?.tasks ?? [], (task) => task.title);
      }),
    );
  }

  /** The text of each tool result in the root transcript, oldest first. */
  toolResults(): Promise<readonly string[]> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({}, 100, undefined, context),
        );

        return Arr.flatMap(Arr.reverse(page.items), (entry) => {
          const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;

          return message?.role === "toolResult"
            ? [
                Arr.join(
                  Arr.flatMap(message.content, (block) =>
                    block.type === "text" ? [block.text] : [],
                  ),
                  "",
                ),
              ]
            : [];
        });
      }),
    );
  }

  /** The `details` of each tool result in the root transcript, as stored, oldest first. */
  toolResultDetails(): Promise<ReadonlyArray<unknown>> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({ order: "ascending" }, 100, undefined, context),
        );

        return Arr.flatMap(page.items, (entry) => {
          const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;

          return message?.role === "toolResult" ? [message.details] : [];
        });
      }),
    );
  }

  /** The images of the tool results in the root transcript, as stored, oldest first: each one's type and base64 length. */
  toolResultImages(): Promise<
    ReadonlyArray<{ readonly mimeType: string; readonly characters: number }>
  > {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({ order: "ascending" }, 100, undefined, context),
        );

        return Arr.flatMap(page.items, (entry) => {
          const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;

          return message?.role === "toolResult"
            ? Arr.flatMap(message.content, (block) =>
                block.type === "image"
                  ? [{ mimeType: block.mimeType, characters: block.data.length }]
                  : [],
              )
            : [];
        });
      }),
    );
  }

  /** The length of the longest row of the Harness's own storage, as JSON: what one SQLite row of it holds. */
  longestHarnessRow(): number {
    return Math.max(0, ...this.harnessRows().map((row) => row.length));
  }

  /** Each row of the Harness's own storage, as JSON. */
  harnessRows(): readonly string[] {
    const { sql } = this.ctx.storage;

    const tables = sql
      .exec(
        "select name from sqlite_master where type = 'table' and name like 'pi\\_%' escape '\\'",
      )
      .toArray();

    return tables.flatMap((table) => {
      const name = table["name"];

      return Predicate.isString(name)
        ? sql
            .exec(`select * from "${name}"`)
            .toArray()
            .map((row) => JSON.stringify(row))
        : [];
    });
  }

  /** Report this Session's status to the Registry object named `registry`, as the Session DO does to the Registry DO. */
  reportTo(registry: string): void {
    this.ctx.storage.kv.put("registry", registry);
  }

  /**
   * Let this Session name itself, as the Session DO does after its first answer: the `replies` are what the title
   * requests get, in order (`gate:<reply>` waits for `open()`), kept in storage like the script. Without it no title is
   * wanted, so a test that does not look at titles never sees a request for one. The Registry decides, as the real
   * one does, whether the title is wanted and whether it is kept.
   */
  titles(replies: readonly string[]): void {
    this.ctx.storage.kv.put("title-replies", { responses: replies, next: 0 } satisfies Script);
  }

  /** The requests for a title the model received, oldest first: its model and the messages as it saw them. */
  titleRequests(): readonly TitleRequest[] {
    return this.ctx.storage.kv.get<TitleRequest[]>("title-requests") ?? [];
  }

  /** Make the Registry unreachable for the title task until `titleRegistry("working")`. */
  titleRegistry(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("titleMode", mode);
  }

  /** Make status reports fail until `reports("working")`, or hang. */
  reports(mode: "working" | "failing" | "hanging"): void {
    this.ctx.storage.kv.put("reportMode", mode);
  }

  /** The statuses this Session reported, oldest first, counting only reports the Registry received. */
  reported(): readonly SessionStatus[] {
    return this.ctx.storage.kv.get<SessionStatus[]>("reported") ?? [];
  }

  /** Stop the root conversation's run, as a client's `abort` does. */
  abortRoot(): Promise<void> {
    return Effect.runPromise(this.#host.abort());
  }

  /** Make notifications fail until `notifications("working")`. */
  notifications(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("notifyMode", mode);
  }

  /** The notifications this Session made, oldest first, counting only those the Registry received. */
  notified(): readonly PushEvent[] {
    return this.ctx.storage.kv.get<PushEvent[]>("notified") ?? [];
  }

  /** How many status reports this Session has tried to make, delivered or not. */
  reportAttempts(): number {
    return this.ctx.storage.kv.get<number>("reportAttempts") ?? 0;
  }

  /** Pick the root conversation's model and thinking level, as a client's `configure` does. */
  configure(change: AgentChange): Promise<void> {
    return Effect.runPromise(this.#host.configure(change));
  }

  /** The system prompt sections the model's latest request carried, by key. */
  sections(): Readonly<Record<string, string>> {
    return this.ctx.storage.kv.get<Record<string, string>>("sections") ?? {};
  }

  /** The names of the tools each request offered the model, oldest first. */
  offeredTools(): readonly (readonly string[])[] {
    return this.ctx.storage.kv.get<string[][]>("request-tools") ?? [];
  }

  /** The content of the owner's messages in each request the model received, oldest request first. */
  requestUserMessages(): readonly (readonly unknown[])[] {
    return this.ctx.storage.kv.get<unknown[][]>("request-user-messages") ?? [];
  }

  /** The model and thinking level of each request the model received, oldest first. */
  requests(): readonly TestRequest[] {
    return this.ctx.storage.kv.get<TestRequest[]>("requests") ?? [];
  }

  /** Make reading the Registry's settings fail until `settingsRegistry("working")`. */
  settingsRegistry(mode: "working" | "failing"): void {
    this.ctx.storage.kv.put("settingsMode", mode);
  }

  /** Script subagent `agent`'s responses apart from the Run's, which it takes otherwise. */
  agentScript(agent: string, responses: readonly string[]): void {
    this.ctx.storage.kv.put(`script:${agent}`, { responses, next: 0 } satisfies Script);
  }

  script(responses: readonly string[]): void {
    this.ctx.storage.kv.put("script", { responses, next: 0 } satisfies Script);
  }

  override async alarm(): Promise<void> {
    await this.#runtime.runPromise(
      Effect.flatMap(Effect.service(Secrets), (held) => held.sweep).pipe(
        Effect.andThen(this.#host.alarm),
      ),
    );
  }

  /** The handoffs the test browser host was asked to start, oldest first. */
  handoffStarts(): readonly HandoffStartInput[] {
    return this.ctx.storage.kv.get<HandoffStartInput[]>("handoff-starts") ?? [];
  }

  /** The handoffs the test browser host minted Live View links for, oldest first. */
  liveViews(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("live-views") ?? [];
  }

  /** The runs the test browser host was asked for, oldest first. */
  browserRuns(): readonly unknown[] {
    return this.ctx.storage.kv.get<unknown[]>("browser-runs") ?? [];
  }

  /** Whether each `ownerTabView` the test browser host was sent asked to open, oldest first. */
  ownerTabViews(): readonly boolean[] {
    return this.ctx.storage.kv.get<boolean[]>("owner-tab-views") ?? [];
  }

  /** The Owner tabs the test browser host has open, the first one shown, as the composer lists and reads them. */
  setOwnerTabPages(pages: readonly OwnerTabPageRead[]): void {
    this.ctx.storage.kv.put("owner-tab-pages", pages);
  }

  /** The Owner tabs the test browser host was asked to read for a message, one list per message, oldest first. */
  ownerTabReads(): readonly (readonly string[])[] {
    return this.ctx.storage.kv.get<string[][]>("owner-tab-reads") ?? [];
  }

  /** The Owner tab's browser is gone: closed or replaced. */
  loseOwnerTab(): void {
    this.ctx.storage.kv.delete("owner-tab");
    this.ctx.storage.kv.put("owner-tab-lost", true);
  }

  /** The Registry says the Session is archived (or not): the Browser Pane may open nothing then. */
  setArchived(archived: boolean): void {
    this.ctx.storage.kv.put("archived", archived);
  }

  /** How many times the Session closed the browser through the test browser host. */
  browserCloses(): number {
    return this.ctx.storage.kv.get<number>("browser-closes") ?? 0;
  }

  /** How many times the test browser host was asked to list the Owner tabs, for any reason. */
  ownerTabLists(): number {
    return this.ctx.storage.kv.get<number>("owner-tab-lists") ?? 0;
  }

  /**
   * When the browser was last used and when a Browser Pane in view last beat, as the Session's keep-alive keeps them, and
   * when the object's alarm is set.
   */
  async browserUse(): Promise<{
    readonly lastUsed?: number;
    readonly watched?: number;
    readonly alarm: number | null;
  }> {
    const lastUsed = this.ctx.storage.kv.get<number>("browser-last-used");
    const watched = this.ctx.storage.kv.get<number>("browser-pane-watched");
    const alarm = await this.ctx.storage.getAlarm();

    const use: Types.Mutable<Awaited<ReturnType<TestSession["browserUse"]>>> = { alarm };

    if (lastUsed !== undefined) use.lastUsed = lastUsed;

    if (watched !== undefined) use.watched = watched;

    return use;
  }

  /** The browser's use and the Pane's beats are forgotten, and the alarm with them, as the idle close leaves them. */
  async forgetBrowserUse(): Promise<void> {
    this.ctx.storage.kv.delete("browser-last-used");
    this.ctx.storage.kv.delete("browser-pane-watched");
    await this.ctx.storage.deleteAlarm();
  }

  /** The browser's last use alone happened `ms` earlier than it did, so only a beat can hold the idle close off. */
  ageBrowserLastUse(ms: number): void {
    const at = this.ctx.storage.kv.get<number>("browser-last-used");

    if (at !== undefined) this.ctx.storage.kv.put("browser-last-used", at - ms);
  }

  /** The browser's last use and the Pane's last beat happened `ms` earlier than they did. */
  ageBrowserUse(ms: number): void {
    for (const key of ["browser-last-used", "browser-pane-watched"]) {
      const at = this.ctx.storage.kv.get<number>(key);

      if (at !== undefined) this.ctx.storage.kv.put(key, at - ms);
    }
  }

  /** The origins of the windows the test browser host says a handoff left open when it ends. */
  leaveWindows(origins: readonly string[]): void {
    this.ctx.storage.kv.put("handoff-windows", origins);
  }

  /** Everything in the object's key-value storage, as JSON. */
  kvDump(): string {
    return JSON.stringify([...this.ctx.storage.kv.list()]);
  }

  /** The handoffs the test browser host was told to end, oldest first. */
  endedHandoffs(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("handoff-ended") ?? [];
  }

  /** Make the test browser host's rounds of waiting end only when `completeHandoff` does, so the object can be evicted mid-wait. */
  quietHandoffs(): void {
    this.ctx.storage.kv.put("handoff-quiet", true);
  }

  /** Finish handoff `requestId` in the test browser host, as the owner does in Live View. */
  completeHandoff(requestId: string, status: HandoffStatus): void {
    this.ctx.storage.kv.put(`handoff-status:${requestId}`, status);
    roundWaiters.get(requestId)?.();
  }

  /** Every request the model received, as the provider would see its messages, oldest first. */
  requestMessages(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("request-messages") ?? [];
  }

  /** The Harness's own storage (the transcript and everything the Session keeps in `pi_` tables), as JSON. */
  harnessDump(): string {
    const { sql } = this.ctx.storage;

    const tables = sql
      .exec(
        "select name from sqlite_master where type = 'table' and name like 'pi\\_%' escape '\\'",
      )
      .toArray();

    return JSON.stringify(
      tables.flatMap((table) => {
        const name = table["name"];

        return Predicate.isString(name)
          ? [[name, sql.exec(`select * from "${name}"`).toArray()]]
          : [];
      }),
    );
  }

  /** Hold `values` as if the owner had entered them for a request. */
  hold(values: Readonly<Record<string, string>>): Promise<void> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const request = { id: "test-hold", conversationId: 1, names: Record.keys(values) };
        const asking = yield* Effect.forkChild(secrets.ask(request));

        yield* Effect.yieldNow;
        yield* secrets.answer(request.id, values);
        yield* Fiber.join(asking);
      }),
    );
  }

  /** This object's storage, as JSON, to check that no Secret value is in it. */
  storageDump(): string {
    return JSON.stringify([...this.ctx.storage.kv.list()]);
  }

  /** The Registry's Settings as the `settings_*` tools reach them: the test Registry the Session reports to. */
  #settingsRegistry(): SettingsRegistry {
    const registry = () => {
      const name = this.ctx.storage.kv.get<string>("registry");

      if (name === undefined) throw new Error("No Registry is set");

      return this.env.REGISTRIES.getByName(name);
    };

    return {
      getSettings: () => Effect.promise(() => registry().getSettings()),
      getSettingsOverrides: ({ environment }) =>
        Effect.promise(
          // SAFETY: the stub's RPC result is the plain data the test Registry returned.
          async () =>
            (await registry().getSettingsOverrides(environment)) as SettingsOverridesState | null,
        ),
      getEnvironment: ({ id }) => Effect.promise(() => registry().getEnvironment(id)),
      sessionSettings: ({ session }) => Effect.promise(() => registry().sessionSettings(session)),
      changeSettings: ({ environment, changes, author }) =>
        Effect.promise(
          // SAFETY: the stub's RPC result is the plain data the test Registry returned.
          async () =>
            (await registry().changeSettings(
              changes,
              author,
              Date.now(),
              environment,
            )) as SettingsChange,
        ),
    };
  }

  /**
   * What the Session resolves its settings from, as the Registry answers it for this Session (its name): Global's
   * overrides and its Environment's Overrides; none while no Registry is set.
   */
  async #readSettings(): Promise<SettingsSource> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined) return { global: {}, overrides: {} };

    if (kv.get<string>("settingsMode") === "failing") throw new Error("Registry is down");

    const { global, overrides, instructions } = await this.env.REGISTRIES.getByName(
      registry,
    ).sessionSettings(this.ctx.id.name ?? "");

    return { global, overrides, instructions };
  }

  /** Whether the Registry wants a title for this Session: titles are on, and it has neither a title nor an owner's. */
  async #titleWanted(): Promise<boolean> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined || kv.get<Script>("title-replies") === undefined) return false;

    if (kv.get<string>("titleMode") === "failing") throw new Error("Registry is down");

    const session = await this.env.REGISTRIES.getByName(registry).getSession(
      this.ctx.id.name ?? "",
    );

    return session !== null && session.titleSource === null;
  }

  async #setTitle(title: string): Promise<void> {
    const { kv } = this.ctx.storage;
    const registry = kv.get<string>("registry");

    if (registry === undefined) return;

    if (kv.get<string>("titleMode") === "failing") throw new Error("Registry is down");

    await this.env.REGISTRIES.getByName(registry).setGeneratedTitle(this.ctx.id.name ?? "", title);
  }

  #notify(event: PushEvent): Promise<void> {
    const { kv } = this.ctx.storage;

    if (kv.get<string>("notifyMode") === "failing")
      return Promise.reject(new Error("Registry is down"));

    kv.put("notified", [...(kv.get<PushEvent[]>("notified") ?? []), event]);

    return Promise.resolve();
  }

  async #report(status: SessionStatus): Promise<void> {
    const registry = this.ctx.storage.kv.get<string>("registry");

    if (registry === undefined) return;

    const { kv } = this.ctx.storage;
    const mode = kv.get<string>("reportMode");

    kv.put("reportAttempts", (kv.get<number>("reportAttempts") ?? 0) + 1);

    if (mode === "failing") throw new Error("Registry is down");

    if (mode === "hanging") await new Promise(() => undefined);

    await this.env.REGISTRIES.getByName(registry).setSessionStatus(
      this.ctx.id.name ?? "",
      status,
      Date.now(),
    );
    kv.put("reported", [...(kv.get<SessionStatus[]>("reported") ?? []), status]);
  }

  /** As `#report`, for the subagents: it fails and hangs with the status reports. */
  async #reportAgents(agents: ReadonlyArray<SessionAgent>): Promise<void> {
    const { kv } = this.ctx.storage;
    const mode = kv.get<string>("reportMode");

    if (mode === "failing") throw new Error("Registry is down");

    if (mode === "hanging") await new Promise(() => undefined);

    const registry = kv.get<string>("registry");

    if (registry !== undefined) {
      await this.env.REGISTRIES.getByName(registry).setSessionAgents(
        this.ctx.id.name ?? "",
        agents,
      );
    }

    kv.put("reportedAgents", [
      ...(kv.get<ReadonlyArray<SessionAgent>[]>("reportedAgents") ?? []),
      agents,
    ]);
  }

  /** The subagents this Session reported to the Registry, oldest first. */
  reportedAgents(): ReadonlyArray<ReadonlyArray<SessionAgent>> {
    return this.ctx.storage.kv.get<ReadonlyArray<SessionAgent>[]>("reportedAgents") ?? [];
  }

  /** The next scripted response; the script position is stored before the response is used. */
  #step(): FauxResponseStep {
    return (request, options, _state, model) => {
      const { kv } = this.ctx.storage;

      // A request for a Session title has its own script and log, so it never shifts the Run's.
      if (JSON.stringify(request.messages).includes("You name conversations")) {
        kv.put("title-requests", [
          ...(kv.get<TitleRequest[]>("title-requests") ?? []),
          { model: model.id, messages: JSON.stringify(request.messages) } satisfies TitleRequest,
        ]);

        const replies = kv.get<Script>("title-replies") ?? { responses: [], next: 0 };
        const reply = replies.responses[replies.next] ?? "unscripted";

        kv.put("title-replies", { ...replies, next: replies.next + 1 });

        if (!reply.startsWith("gate:")) return respond(reply);

        this.gated.resolve();

        return this.#gate.promise.then(() => respond(reply.slice("gate:".length)));
      }

      kv.put("request-messages", [
        ...(kv.get<string[]>("request-messages") ?? []),
        JSON.stringify(request.messages),
      ]);

      // The system prompt sections in effect for this request, replayed from its system messages.
      const sections: Record<string, string> = {};

      for (const message of request.messages) {
        if (message.role !== "system") continue;

        for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) delete sections[key];
          else sections[key] = value;
        }
      }

      kv.put("sections", sections);

      // The tools this request offered, as the transport replays them.
      kv.put("request-tools", [
        ...(kv.get<string[][]>("request-tools") ?? []),
        getCurrentTools(request.messages).map((tool) => tool.name),
      ]);

      // The owner's messages as this request carried them: what the model is told, part by part.
      kv.put("request-user-messages", [
        ...(kv.get<unknown[][]>("request-user-messages") ?? []),
        request.messages.flatMap((message) => (message.role === "user" ? [message.content] : [])),
      ]);

      kv.put("requests", [
        ...(kv.get<TestRequest[]>("requests") ?? []),
        { model: model.id, thinking: options?.reasoning } satisfies TestRequest,
      ]);

      // A subagent names itself in its instructions; one given a script of its own (`agentScript`) follows that one.
      const agent = Object.values(sections)
        .map((section) => /You are subagent `([^`]+)`/.exec(section)?.[1])
        .find((found) => found !== undefined);

      const key =
        agent !== undefined && kv.get<Script>(`script:${agent}`) !== undefined
          ? `script:${agent}`
          : "script";

      const script = this.ctx.storage.kv.get<Script>(key) ?? { responses: [], next: 0 };
      const text = script.responses[script.next] ?? "unscripted";

      this.ctx.storage.kv.put(key, { ...script, next: script.next + 1 });

      if (text.startsWith("gate:")) {
        this.gated.resolve();

        return this.#gate.promise.then(() => respond(text.slice("gate:".length)));
      }

      if (text !== "hang") return respond(text);
      this.hanging.resolve();

      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Request interrupted", "AbortError"));

        if (options?.signal?.aborted === true) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    };
  }
}

export default {
  fetch: () => new Response("cloudpid Session host test worker"),
};
