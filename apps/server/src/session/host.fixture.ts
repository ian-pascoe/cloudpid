// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off globalDateInEffect:off preferEffectArray:off preferEffectRecord:off
// The workerd test Worker: a Durable Object that hosts a `SessionHost` and its `SessionSockets` over the faux provider,
// as the Session DO hosts them over the model proxy. Tests drive it with `runInDurableObject()` and client sockets,
// evict it, and run its alarm.
import { DurableObject } from "cloudflare:workers";
import { callDurable, defineEffectTool, Harness } from "@cloudpid/effect-durable";
import { type RefusingStorage, refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
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
import {
  SettingsMcpAccess,
  type SettingsMcpAccessService,
} from "@cloudpid/extensions/settings-mcp";
import { scrubbingModels, Secrets, secretsExtension } from "@cloudpid/extensions/secrets";
import { ContextDoc } from "@cloudpid/extensions/context";
import { Todo, TodoDoc } from "@cloudpid/extensions/todo";
import type {
  StageImportAppend,
  StageImportBegin,
  StageImportFinish,
  Annotation,
  AnnotationDraft,
  AttachedPage,
  McpAppCopy,
  McpAppDraft,
  McpAppEntry,
  McpWatchEntry,
  McpAppMounted,
  Catalog,
  ChangeFile,
  CommandOutcome,
  CompareResult,
  Comparison,
  ConfigureRequest,
  ConversationId,
  FileMatches,
  HistoryPage,
  LastRun,
  McpPromptRef,
  McpResourceMenu,
  ResourceRef,
  Navigated,
  PullList,
  RunDiff,
  SessionAgent,
  SessionTree,
  SettingsOverridesState,
  StopRequest,
  SubmitRequest,
  TranscriptRequest,
  UserInput,
  ViewedFile,
  WaitRequest,
  WorkspaceChanges,
} from "@cloudpid/protocol";
import { MCP_APP_INTERNAL_ERROR, mcpAppError, resourceUnavailable } from "@cloudpid/protocol";
import {
  addTask,
  emptyMcpExtension,
  type McpHostClientService,
  type McpWatched,
  type McpQuestionCopy,
  type McpQuestionsService,
  type McpSamplingService,
  rememberSampling,
  McpTasksDoc,
  type McpTasksTiming,
} from "@cloudpid/extensions/mcp";
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
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type SnapshotEvent,
  type TaskId,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
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
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import type * as Types from "effect/Types";
import type { TestMcpHost } from "../mcp/host.fixture.ts";
import { mcpHostName } from "../mcp/name.ts";
import { viewOrigin } from "../view-host.ts";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { type McpHostAnswers, type McpHostStub, mcpHostClient, sessionMcp } from "./mcp-host.ts";
import { testEnvironments, unusedRemoval } from "./environments.fixture.ts";
import type { ToolCallTask } from "../durable-waits.fixture.ts";
import type { SettingsChange } from "../registry/settings-changes.ts";
import { type SettingsRegistry, sessionSettingsAccess } from "./settings-access.ts";
import { sessionBrowserHandoffsLayer } from "./handoffs.ts";
import type { HeldStop } from "../workspace/idle.ts";
import { sessionOwnerTabDriversLayer } from "./owner-tab-drivers.ts";
import { pricedModels, REQUEST_COST } from "./priced.fixture.ts";
import { isWithdrawn } from "./errors.ts";
import { samplingTotals, sessionTotals } from "./spend.ts";
import { sessionSecretsLayer } from "./secrets.ts";
import { sessionApprovalsLayer } from "./approvals.ts";
import type { McpSignInAskAnswer } from "@cloudpid/mcp/types";
import { sessionMcpWatches } from "./mcp-watches-store.ts";
import { leaveConversation } from "./mcp-app-context.ts";
import { sessionMcpApps } from "./mcp-apps-store.ts";
import { mcpResourcePreviewsLayer, type SpillRead } from "./mcp-resource-previews.ts";
import { sessionMcpRecords } from "./mcp-records.ts";
import { sessionMcpQuestions } from "./mcp-questions.ts";
import { sessionMcpSampling } from "./mcp-sampling.ts";
import { sessionMcpSignIns } from "./mcp-sign-ins.ts";
import { sessionMcpTasks } from "./mcp-tasks.ts";
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
  type SessionHostOptions,
  EXPAND_TIMEOUT,
  sessionHostLayer,
  type SessionHostService,
  type Prompt,
  type SlashCommand,
} from "./host.ts";
import type { NavigateRequest } from "./branches.ts";
import { fillSession, type ForkPlan, type ForkSourceRequest } from "./fork.ts";
import { destroySession } from "./lifecycle.ts";
import { type RemovalRegistry, removals } from "../registry/removal.ts";
import { onIdle, wakeAt, withdrawCall } from "./wake.ts";
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
import { SessionMcp, type SessionMcpService, sessionMcpLayer } from "./mcp.ts";
import {
  SessionImport,
  type SessionImportService,
  importWakeAt,
  sessionImportLayer,
} from "./import.ts";
import { type ImportStaging, importStaging } from "./import-staging.ts";
import { translatePiSession, translated } from "./import-translate.ts";
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
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
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
  /** Each listing waits for `releaseChanges()`, so watches that come meanwhile fold into one more after it. */
  readonly held?: boolean;
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

/**
 * A call cut off before it reaches its wait at every attempt (#647), for the Sessions named `hang-…`: it asks the owner's
 * Approval as an approval tool does, but never marks its wait as progress, so its restarts count toward the limit.
 */
const Hang = Effect.gen(function* () {
  const approvals = yield* Approvals;

  return yield* defineEffectTool({
    name: "hang",
    description: "Ask for an Approval, and hang before waiting for it",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: (_args, api) =>
      Effect.andThen(
        Effect.forkDetach(
          approvals.ask({
            id: String(api.taskId),
            conversationId: api.conversationId,
            tool: "hang",
            target: "the Settings",
            change: "Spend limit",
            before: "no limit",
            after: "$25 per Session",
            reason: "To hang",
            expected: null,
          }),
        ),
        Effect.never,
      ),
  });
});

/**
 * A call that makes one nested call and waits for it in memory, as a `codemode` script does (#647), for the Sessions
 * named `settings-nest-…`: its result is the nested call's value, or its diagnostics.
 */
const Nest = defineEffectTool({
  name: "nest",
  description: "Call a tool from inside this call",
  parameters: Schema.Struct({ tool: Schema.String, arguments: Schema.String }),
  replay: "safe",
  execute: ({ tool, arguments: json }, api) =>
    callDurable("executeTool", (context) =>
      api.executeTool(tool, JSON.parse(json), context, { key: "c1" }),
    ).pipe(
      Effect.map((nested) => ({
        output: [
          {
            type: "text",
            text: JSON.stringify(nested.structuredOutput ?? nested.diagnostics),
          },
        ],
      })),
    ),
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

/** Whether the test browser host's reads of the Owner tabs are held for good (`holdOwnerTabReads`). */
const OWNER_TAB_READS_HELD = "owner-tab-reads-held";

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
  readOwnerTabPages: (ids) => {
    const reading = (read: ReadonlyArray<string>) => {
      kv.put("owner-tab-reads", [...(kv.get<string[][]>("owner-tab-reads") ?? []), [...read]]);
    };

    // Held (`holdOwnerTabReads`), a read is told as it starts, and only an interruption ends it.
    return kv.get<boolean>(OWNER_TAB_READS_HELD) === true
      ? Effect.sync(() => reading(ids)).pipe(Effect.andThen(Effect.never))
      : readingOwnerTabPages({
          open: () => kv.get<OwnerTabPageRead[]>("owner-tab-pages") ?? [],
          reading,
          // A page called "slow" takes a moment to read, for the tests of arrival order.
          delayMs: (read) => (read.includes("slow") ? 150 : 0),
        })(ids);
  },
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
 * `call:<tool>:<json arguments>` calls a tool (`parallel:<json>` several at once), and `gate:<response>` gives `response` once the test opens the gate.
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

  // `parallel:<json array of [tool, arguments]>` calls several tools in one response.
  if (text.startsWith("parallel:")) {
    // SAFETY: a test writes the calls as a JSON array of `[tool, arguments]` pairs.
    const calls = JSON.parse(text.slice("parallel:".length)) as ReadonlyArray<
      readonly [string, Record<string, string>]
    >;

    return fauxAssistantMessage(
      calls.map(([name, args]) => fauxToolCall(name, args)),
      { stopReason: "toolUse" },
    );
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
  /** See `destroyedWorkspaces`. */
  var testDestroyedWorkspaces: Map<string, string[]> | undefined;
}

/**
 * How many instances of each test Session were constructed, by object ID. Kept in the isolate's global scope, which
 * the tests share, so a test can read it without waking an object.
 */
export const constructions = (globalThis.testSessionConstructions ??= new Map<string, number>());

/** The Workspace objects an import's deletion destroyed, by the Session's object id (kept as `constructions` is). */
export const destroyedWorkspaces = (globalThis.testDestroyedWorkspaces ??= new Map<
  string,
  string[]
>());

/** Text submitted to the root conversation, as the tests write it. */
type TestPrompt = { readonly requestId: string; readonly text: string };

/** How a test reads a Result Spill for a preview (`TestSession.spill`). */
export type TestSpillRead = {
  /** Told each size the read asks the decode slot for. */
  readonly held?: Array<number>;
  /** How long the wait for the slot takes, on the read's test clock. */
  readonly slotAfterMs?: number;
  /** The Workspace's limit for this Session's calls, in ms (`expandTimeoutMs`); `EXPAND_TIMEOUT` when left out. */
  readonly expandMs?: number;
  /** Run during the wait for the slot, before it is given. */
  readonly duringWait?: () => Promise<void>;
};

/** The test Worker's `SECRETS_ENCRYPTION_KEY`. */
const SECRETS_KEY = Redacted.make("test-secrets-encryption-key-0123456789abcdef");

/** A host stub whose methods answer with Promises, as a Durable Object stub's do over RPC from a test. */
type McpHostPromises = {
  readonly [K in keyof McpHostClientService]: (
    ...args: Parameters<McpHostClientService[K]>
  ) => Promise<McpHostAnswers[K]>;
};

/** `host`, a stub that answers with Promises, as one whose calls fail as values. */
const promisedMcpHost = (host: McpHostPromises): McpHostStub<Cause.UnknownError> => ({
  requestStart: (input) => Effect.tryPromise(() => host.requestStart(input)),
  servers: (input) => Effect.tryPromise(() => host.servers(input)),
  apply: (input) => Effect.tryPromise(() => host.apply(input)),
  request: (input, hooks) => Effect.tryPromise(() => host.request(input, hooks)),
});

export class TestSession extends DurableObject {
  /**
   * The extensions this Session runs with, installed before any work resumes: `echo`, which uses Secrets, the secret
   * tools, the browser tools over a test browser host, and `todo`; for a Session whose name starts with
   * `environment-`, the `environment_*` tools over `testEnvironments`; for one whose name starts with `settings-`,
   * the `settings_*` tools and those that wait for Approval over the test Registry's Settings; for one whose name
   * starts with `instructions-`, the `owner_instructions` section over the Instructions the Session last read; and, for
   * one whose name starts with `tool-search-`, `tool_search` over the Registry's offered tools, which is installed
   * again when they change; and, for one whose name starts with `mcp-`, an empty `mcp` extension and `tool_search`,
   * which its request starts install again (`hostMcp`).
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
    const hanging = this.ctx.id.name?.startsWith("hang-") === true;
    const nesting = this.ctx.id.name?.startsWith("settings-nest-") === true;
    const mcp = this.#hasMcpTools();
    const settingsRegistry = this.#settingsRegistry();
    const session = this.ctx.id.name;

    return Effect.gen(function* () {
      const tool = yield* Echo;
      const hang = hanging ? [yield* Hang] : [];
      const nest = nesting ? [yield* Nest] : [];
      const echo = defineExtension({ name: "echo", tools: [tool, ...hang, ...nest] });
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
              // These tests change no MCP server.
              Effect.provideService(SettingsMcpAccess, {
                view: () => Effect.die("No MCP servers"),
                own: Effect.die("No MCP servers"),
                check: () => Effect.die("No MCP servers"),
                reload: () => Effect.die("No MCP servers"),
                pushes: () => Effect.die("No MCP servers"),
                pushed: () => Effect.die("No MCP servers"),
                host: () => ({
                  requestStart: () => Effect.die("No MCP host"),
                  servers: () => Effect.die("No MCP host"),
                  apply: () => Effect.die("No MCP host"),
                  request: () => Effect.die("No MCP host"),
                }),
              }),
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
        ...(mcp ? [emptyMcpExtension] : []),
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
    return this.ctx.id.name?.startsWith("tool-search-") === true || this.#hasMcpTools();
  }

  /** The Session's MCP questions, made once: the MCP tools ask through its service, the runtime provides its layer. */
  #questions: ReturnType<typeof sessionMcpQuestions> | undefined;

  /**
   * The wait of a prompt send's question, shortened for the Sessions whose tests wait it out (`mcp-short-wait-*`: 300 ms),
   * and for those that test the get's own clock against it (`mcp-short-clock-*`: 6 s, past the clock's 2 s and the tests' 3 s wait).
   */
  #promptWaitMs(): number | undefined {
    const name = this.ctx.id.name ?? "";

    if (name.startsWith("mcp-short-wait-")) return 300;

    return name.startsWith("mcp-short-clock-") ? 6000 : undefined;
  }

  #mcpQuestions(): ReturnType<typeof sessionMcpQuestions> {
    this.#questions ??= sessionMcpQuestions({
      storage: this.ctx.storage.kv,
      sockets: this.ctx,
      notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
      credentials: [],
      // The 10-minute bound, shortened for the Sessions whose tests wait it out (`mcp-short-wait-*`).
      waitMs: this.ctx.id.name?.startsWith("mcp-short-wait-") === true ? 300 : undefined,
      samplingWaitMs: this.ctx.id.name?.startsWith("mcp-short-wait-") === true ? 300 : undefined,
      promptWaitMs: this.#promptWaitMs(),
      // *Always allow* and *Never* on a Sampling card, written to the test Registry the test names (`samplingRegistry`) as a
      // Session writes them. The Session is the Registry's own only when the test registers it there, as a Session of an
      // Environment: until then (or never) it has nowhere to write, and its card offers no Always or Never.
      remember: rememberSampling({
        settings: sessionSettingsAccess({
          registry: this.#settingsRegistry("sampling-registry"),
          session: this.ctx.id.name,
        }),
        mcp: this.#samplingMcpAccess(),
      }),
      encryptionKey: SECRETS_KEY,
      session: this.ctx.id.toString(),
    });

    return this.#questions;
  }

  /** The Session's MCP tasks, made once: the MCP tools follow with its options, the runtime provides its layer. */
  #tasks: ReturnType<typeof sessionMcpTasks> | undefined;

  #mcpTasks(): ReturnType<typeof sessionMcpTasks> {
    this.#tasks ??= sessionMcpTasks({ storage: this.ctx.storage.kv });

    return this.#tasks;
  }

  /** The Session's MCP questions, for a subclass that builds MCP tools of its own. */
  protected mcpQuestionsService(): McpQuestionsService {
    return this.#mcpQuestions().service;
  }

  /** The Session's MCP sampler, made once: the MCP tools sample through its service, the runtime provides its layer. */
  #sampling: ReturnType<typeof sessionMcpSampling> | undefined;

  #mcpSampling(): ReturnType<typeof sessionMcpSampling> {
    this.#sampling ??= sessionMcpSampling({
      storage: this.ctx.storage.kv,
      questions: this.#mcpQuestions().service,
    });

    return this.#sampling;
  }

  /**
   * The Session's Sign-in requests, made once, over a Registry that answers what `scriptSignIn` says and records what it is
   * asked (`signInAsks`): the tools ask through its service, the runtime provides its layer.
   */
  #signIns: ReturnType<typeof sessionMcpSignIns> | undefined;

  #mcpSignIns(): ReturnType<typeof sessionMcpSignIns> {
    const { kv } = this.ctx.storage;

    this.#signIns ??= sessionMcpSignIns({
      storage: kv,
      sockets: this.ctx,
      session: this.ctx.id.name,
      notify: (event) => Effect.ignore(Effect.tryPromise(() => this.#notify(event))),
      registry: () => ({
        mcpSignInAsk: (input) =>
          Effect.sync(() => {
            kv.put("signin-asks", [...(kv.get<unknown[]>("signin-asks") ?? []), input]);

            // SAFETY: the answer `scriptSignIn` was given, which a test writes as a registry answer.
            return (kv.get("signin-answer") ?? { status: "signed_in" }) as McpSignInAskAnswer;
          }),
        mcpSignInWithdraw: (input) =>
          Effect.sync(() => {
            kv.put("signin-withdrawn", [...(kv.get<unknown[]>("signin-withdrawn") ?? []), input]);

            return { removed: true };
          }),
      }),
    });

    return this.#signIns;
  }

  /** The Session's App records, made once: the MCP tools record through its service, the runtime provides its layer. */
  #apps: ReturnType<typeof sessionMcpApps> | undefined;

  #mcpApps(): ReturnType<typeof sessionMcpApps> {
    this.#apps ??= sessionMcpApps({
      storage: this.ctx.storage.kv,
      sockets: this.ctx,
      html: (input) =>
        this.#mcpTools === undefined
          ? Effect.succeed({ status: "unsupported", message: "No MCP tools" })
          : this.#mcpTools.appHtml(input),
      request: (input) =>
        this.#mcpTools === undefined
          ? Effect.succeed({
              answer: mcpAppError("failed", "No MCP tools", MCP_APP_INTERNAL_ERROR),
              notes: [],
            })
          : this.#mcpTools.appRequest(input),
      archived: Effect.sync(() => this.ctx.storage.kv.get<boolean>("archived") === true),
      // As the Session's: a deployed `prod` stage's, with no label.
      viewOrigin: (view) => viewOrigin({ hash: view, label: undefined, local: false }),
    });

    return this.#apps;
  }

  /** The Session's previews of a card's links, read through its MCP tools. */
  #resourcePreviews() {
    return mcpResourcePreviewsLayer({
      read: (input) =>
        this.#mcpTools === undefined
          ? Effect.succeed(resourceUnavailable("unavailable", "No MCP tools"))
          : this.#mcpTools.resourcePreview(input),
    });
  }

  /** The Session's MCP sampler, for a subclass that builds MCP tools of its own. */
  protected mcpSamplingService(): McpSamplingService {
    return this.#mcpSampling().service;
  }

  /** The Session's Resource watches, made once, over the test Worker's `McpHost` objects. */
  #watches: ReturnType<typeof sessionMcpWatches> | undefined;

  #mcpWatches(): ReturnType<typeof sessionMcpWatches> {
    this.#watches ??= sessionMcpWatches({
      storage: this.ctx.storage.kv,
      sockets: this.ctx,
      session: this.ctx.id.name,
      host: (environment) =>
        mcpHostClient(() =>
          promisedMcpHost(this.env.MCP_HOSTS.getByName(mcpHostName(environment))),
        ),
    });

    return this.#watches;
  }

  #mcpTools: ReturnType<typeof sessionMcp> | undefined;

  /** Whether this Session has MCP tools (the tests that look at them name it so). */
  #hasMcpTools(): boolean {
    return this.ctx.id.name?.startsWith("mcp-") === true;
  }

  /**
   * The MCP tools of a Session with them (`#hasMcpTools`): as the Session DO's, over the test Worker's `McpHost` objects,
   * with the Workspace `ws:test` (`mcpWorkspaceUnknown` makes its lookup fail), whose marks before a host call are
   * counted (`mcpWorkspaceFails` makes them fail), and a
   * stand-in `codemode` that keeps the namespaces it is built with.
   */
  protected hostMcp(): SessionHostOptions["mcp"] {
    if (!this.#hasMcpTools()) return undefined;

    const { kv } = this.ctx.storage;
    const hosts = this.env.MCP_HOSTS;

    const mcp = sessionMcp({
      apps: this.#mcpApps().service,
      // The times of MCP tasks, shortened by `mcpTaskTiming` for the tests that wait them out: read when a task needs
      // them, as the test sets them after the Session is built.
      tasks: Object.defineProperty(this.#mcpTasks().options, "timing", {
        enumerable: true,
        get: () => kv.get<McpTasksTiming>("mcp-task-timing"),
      }),
      watches: this.#mcpWatches().service,
      questions: this.#mcpQuestions().service,
      sampling: this.#mcpSampling().service,
      signIns: this.#mcpSignIns().service,
      session: this.ctx.id.name,
      // The Session's 40 s get clock for a prompt send, shortened for the Sessions that test it (`mcp-short-clock-*`).
      promptGetWaitMs: this.ctx.id.name?.startsWith("mcp-short-clock-") === true ? 2000 : undefined,
      host: (environment) =>
        mcpHostClient(() => promisedMcpHost(hosts.getByName(mcpHostName(environment)))),
      kv,
      workspace: Effect.try(() => {
        if (kv.get<boolean>("mcp-workspace-unknown") === true) throw new Error("No placement");

        return "ws:test";
      }),
      ready: () =>
        Effect.tryPromise(async () => {
          if (kv.get<boolean>("mcp-ready-fails") === true) throw new Error("The Workspace is down");

          kv.put("mcp-ready", (kv.get<number>("mcp-ready") ?? 0) + 1);
        }),
      codemode: (namespaces) => {
        kv.put("codemode-namespaces", namespaces);

        return defineExtension({ name: "codemode", tools: [] });
      },
    });

    this.#mcpTools = mcp;

    // Where each reinstall's announcement and its install fall (`mcpOrder`): an extension whose tools are read as it is
    // installed, beside what the build installs.
    const note = (what: string) =>
      kv.put("mcp-order", [...(kv.get<string[]>("mcp-order") ?? []), what]);

    return {
      ...mcp,
      reinstall: (installed, values) => {
        const built = mcp.reinstall(installed, values);

        return {
          extensions:
            built.extensions.length === 0
              ? []
              : [
                  ...built.extensions,
                  {
                    name: "mcp-order-probe",
                    get tools() {
                      note("install");

                      return [];
                    },
                  },
                ],
          announce: Effect.andThen(
            Effect.sync(() => note("announce")),
            built.announce,
          ),
        };
      },
    };
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
  #mcp!: SessionMcpService;
  #imports!: SessionImportService;
  #staging!: ImportStaging;
  #runtime!: ManagedRuntime.ManagedRuntime<
    | SessionHost
    | SessionSockets
    | SessionChanges
    | SessionComparisons
    | Harness
    | Secrets
    | AnnotationStore
    | ViewedStore
    | SessionReviews
    | SessionMcp
    | SessionImport,
    unknown
  >;
  /** Resolves when this instance's model request starts and hangs. */
  readonly hanging = Promise.withResolvers<void>();
  /** Holds back this instance's `gate:` responses until `open()`. */
  readonly #gate = Promise.withResolvers<void>();
  /** Resolves when this instance's model request reaches the gate. */
  readonly gated = Promise.withResolvers<void>();
  /** Holds back the listings of a `held` Changes fixture until `releaseChanges()`. */
  readonly #changesHold = Promise.withResolvers<void>();

  /**
   * The gate over this instance's storage, for a Session whose name starts with `mcp-replaced-`: everything the instance
   * reads or writes goes through it, and `replace()` makes it refuse (`docs/development/workers.md` → Deploys and Durable
   * Object code updates).
   */
  readonly #replaceable: RefusingStorage<DurableObjectStorage> | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    constructions.set(ctx.id.toString(), (constructions.get(ctx.id.toString()) ?? 0) + 1);

    if (ctx.id.name?.startsWith("mcp-replaced-") === true) {
      this.#replaceable = refusingStorage(ctx.storage);
      // Every `ctx.storage` this object reads from here on is the gate, as the host and its layers are built over it.
      Object.defineProperty(ctx, "storage", { value: this.#replaceable.storage });
    }

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

    this.#staging = importStaging(ctx.storage);

    void ctx.blockConcurrencyWhile(async () => {
      this.#runtime = ManagedRuntime.make(
        sessionImportLayer({
          staging: this.#staging,
          // A test reads how often the Session asked to be deleted: the deletion itself is the Session DO's.
          discard: this.#discardImport(),
          // A test holds the Registry's answer back (`importEndedGate`) or makes it fail (`importEndedFails`).
          ended: Effect.gen(function* () {
            while (ctx.storage.kv.get<boolean>("import-ended-gate") === true) {
              yield* Effect.sleep("10 millis");
            }

            const failing = ctx.storage.kv.get<number>("import-ended-fails") ?? 0;

            if (failing > 0) {
              ctx.storage.kv.put("import-ended-fails", failing - 1);

              return yield* Effect.die(new Error("The Registry could not be told."));
            }

            ctx.storage.kv.put("import-ended", true);
          }),
          finishWaitMs: () => ctx.storage.kv.get<number>("import-finish-wait") ?? 30_000,
          // A test makes the translation fail, as a crash of the object does: the attempt is counted before it runs.
          translate: (lines, facts) => {
            if (ctx.storage.kv.get<boolean>("import-translate-fails") === true) {
              throw new Error("The translation failed.");
            }

            const made = translatePiSession(lines, facts);

            // A test makes the translator another version, as a deploy between two runs does.
            const version = ctx.storage.kv.get<number>("import-translator-version");
            const count = ctx.storage.kv.get<number>("import-translation-count");

            const translation = translated(made)
              ? { ...made, version: version ?? made.version, count: count ?? made.count }
              : made;

            const after = ctx.storage.kv.get<number>("import-pages-fail-after");

            if (after === undefined || !translated(translation)) return translation;

            // A test cuts the writing off after `after` pages, once, as a crash of the object between two commits does.
            return {
              ...translation,
              pages: function* () {
                let written = 0;

                for (const page of translation.pages()) {
                  if (written >= after) {
                    ctx.storage.kv.delete("import-pages-fail-after");

                    throw new Error("The object was cut off between two pages.");
                  }

                  written += 1;
                  yield page;
                }
              },
            };
          },
        }).pipe(
          Layer.provideMerge(sessionSocketsLayer(ctx)),
          Layer.provideMerge(sessionReviewsLayer(ctx.storage.kv)),
          // The MCP endpoint's calls; a short poll, and a short stop, so a test sees a wake-up or a stop that is slow.
          Layer.provideMerge(
            sessionMcpLayer({
              session: ctx.id.name,
              kv: ctx.storage.kv,
              archived: Effect.sync(() => ctx.storage.kv.get<boolean>("archived") === true),
              pollMs: 20,
              stopWaitMs: ctx.storage.kv.get<number>("mcp-stop-wait") ?? 30_000,
            }),
          ),
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
              mcp: this.hostMcp(),
              apps: this.#mcpApps().service,
              appContexts: this.#mcpApps().service.contexts,
              onBranchLeft: leaveConversation(
                this.#mcpWatches().service,
                this.#mcpApps().service.contexts,
              ),
              records: sessionMcpRecords({
                questions: this.#mcpQuestions().service,
                sampling: this.#mcpSampling().service,
              }),
              env: this.hostEnv(),
              lookupEnv: this.hostLookupEnv(),
              // Read at each use, so a test can shorten it for one Session (`expandTimeoutMs`) after it is built.
              get expandTimeout(): Duration.Input {
                return ctx.storage.kv.get<number>("expand-timeout-ms") ?? EXPAND_TIMEOUT;
              },
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
              wakeAt: Effect.flatMap(Effect.service(Secrets), (held) =>
                wakeAt(held, browser, importWakeAt(this.#staging)),
              ),
              // And what it does when it settles: the abandoned requests dropped, an idle browser closed.
              onIdle: Effect.flatMap(
                Effect.all([
                  Effect.service(Secrets),
                  Effect.service(BrowserHandoffs),
                  Effect.service(Approvals),
                ]),
                ([held, handoffs, approvals]) =>
                  onIdle(
                    held,
                    browser,
                    handoffs,
                    approvals,
                    this.#mcpSignIns().service,
                    this.#mcpQuestions().service,
                  ),
              ),
              // And what it withdraws of a tool call it ended for good.
              withdrawCall: (call) =>
                Effect.flatMap(
                  Effect.all([Effect.service(Secrets), Effect.service(Approvals)]),
                  ([held, approvals]) =>
                    withdrawCall(
                      held,
                      approvals,
                      this.#mcpSignIns().service,
                      this.#mcpQuestions().service,
                    )(call),
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
                    reportMcpTasks: (count) =>
                      Effect.tryPromise({
                        try: () => this.#reportMcpTasks(count),
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
          Layer.provideMerge(Layer.merge(this.#mcpQuestions().layer, this.#mcpSampling().layer)),
          Layer.provideMerge(Layer.merge(this.#mcpApps().layer, this.#mcpWatches().layer)),
          Layer.provideMerge(this.#resourcePreviews()),
          Layer.provideMerge(this.#mcpSignIns().layer),
          Layer.provideMerge(this.#mcpTasks().layer),
          Layer.provideMerge(
            sessionSecretsLayer({
              encryptionKey: SECRETS_KEY,
              session: ctx.id.toString(),
              storage: ctx.storage.kv,
              sockets: ctx,
              // The Registry's kept Secrets: none, unless `keptFails` makes the ask fail.
              kept: Effect.suspend(() =>
                ctx.storage.kv.get<boolean>("kept-fails") === true
                  ? Effect.fail("the Registry is unreachable")
                  : Effect.succeed([]),
              ),
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
      this.#mcp = Context.get(context, SessionMcp);
      this.#imports = Context.get(context, SessionImport);
    });
  }

  /** `SessionMethods.status`: what the MCP endpoint reads of the Session itself. */
  mcpStatus(request?: { readonly after?: string }) {
    return Effect.runPromise(this.#mcp.status(request));
  }

  /** `SessionMethods.waitForChange`. */
  mcpWait(request: WaitRequest) {
    return Effect.runPromise(this.#mcp.waitForChange(request));
  }

  /** `SessionMethods.transcriptPage`. */
  mcpTranscript(request: TranscriptRequest) {
    return Effect.runPromise(this.#mcp.transcriptPage(request));
  }

  /** `SessionMethods.submit`. */
  mcpSubmit(request: SubmitRequest) {
    return Effect.runPromise(this.#mcp.submit(request));
  }

  /** `SessionMethods.stop`. */
  mcpStop(request: StopRequest) {
    return Effect.runPromise(this.#mcp.stop(request));
  }

  /** `SessionMethods.configure`. */
  mcpConfigure(request: ConfigureRequest) {
    return Effect.runPromise(this.#mcp.configure(request));
  }

  /** `SessionMethods.stageImportBegin`. */
  stageBegin(request: StageImportBegin) {
    return Effect.runPromise(this.#imports.begin(request));
  }

  /** `SessionMethods.stageImportAppend`. */
  stageAppend(request: StageImportAppend) {
    return Effect.runPromise(this.#imports.append(request));
  }

  /** `SessionMethods.stageImportFinish`. */
  stageFinish(request: StageImportFinish) {
    return Effect.runPromise(this.#imports.finish(request));
  }

  /** `SessionMethods.stageImportCancel`. */
  stageCancel() {
    return Effect.runPromise(this.#imports.cancel);
  }

  /** The import's record as kept, and how often the Session asked to be deleted. */
  importState() {
    return {
      record: this.#staging.record(),
      received: this.#staging.received(),
      discards: this.ctx.storage.kv.get<number>("import-discards") ?? 0,
      endedFailsLeft: this.ctx.storage.kv.get<number>("import-ended-fails") ?? 0,
    };
  }

  /** How long finish waits for the translation, in milliseconds (read at each finish). */
  importFinishWait(ms: number): void {
    this.ctx.storage.kv.put("import-finish-wait", ms);
  }

  /** Cut the next translation's writing off after `pages` pages (once), as a crash between two commits does. */
  importPagesFailAfter(pages: number): void {
    this.ctx.storage.kv.put("import-pages-fail-after", pages);
  }

  /** Forget the translation a cut-off import noted, as an import written by a version before the note was has none. */
  importForgetNote(): void {
    const filling = this.ctx.storage.kv.get<Record<string, unknown>>("fork-copy");

    if (filling === undefined) return;

    const { translation: _translation, written: _written, ...rest } = filling;

    this.ctx.storage.kv.put("fork-copy", rest);
  }

  /** Make the next translations of another version, as a deploy that changed the translator does. */
  importTranslatorVersion(version: number): void {
    this.ctx.storage.kv.put("import-translator-version", version);
  }

  /** Make the translations say they make `count` entries, as a translator that has changed its mind does. */
  importTranslationCount(count: number): void {
    this.ctx.storage.kv.put("import-translation-count", count);
  }

  /** Make every translation fail (or not), as one that crashes the object does. */
  importTranslationFails(fails: boolean): void {
    this.ctx.storage.kv.put("import-translate-fails", fails);
  }

  /** The next `times` times the Registry is told the import ended, the call fails. */
  importEndedFails(times: number): void {
    this.ctx.storage.kv.put("import-ended-fails", times);
  }

  /** While `blocked`, the call that tells the Registry the import ended does not answer. */
  importEndedGate(blocked: boolean): void {
    this.ctx.storage.kv.put("import-ended-gate", blocked);
  }

  /** The import's expiry has passed, as an hour with no slice makes it. */
  expireImport(): void {
    const record = this.#staging.record();

    if (record !== undefined) this.#staging.save({ ...record, expiresAt: 1 });
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
   * it, else the `stopped` one. Each listing is recorded, by whether it may start the Container, waits for
   * `releaseChanges()` when `held`, and takes `delayMs`.
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

        if (fixture.held === true) await this.#changesHold.promise;

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

  /** Let the listings of a `held` Changes fixture through. */
  releaseChanges(): void {
    this.#changesHold.resolve();
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

  /**
   * What an expired import does here: it counts the ask, and when a test gave the Session its Registry
   * (`importRegistry`), deletes as the Session DO does: the Registry's record and the Workspace, then its own storage.
   */
  #discardImport(): Effect.Effect<void> {
    const { ctx } = this;

    return Effect.suspend(() => {
      const asked = ctx.storage.kv.get<number>("import-discards") ?? 0;

      const registered = ctx.storage.kv.get<{ session: string; registry: string }>(
        "import-registry",
      );

      if (registered === undefined) {
        ctx.storage.kv.put("import-discards", asked + 1);

        return Effect.void;
      }

      const registry = this.env.REGISTRIES.getByName(registered.registry);
      const key = ctx.id.toString();

      // SAFETY: `removeOwnSession` calls only these five methods of the Registry, here over its test object.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions
      const methods = {
        getSession: ({ id }: { id: string }) => Effect.promise(() => registry.getSession(id)),
        listSubagentWorkspaces: ({ session }: { session: string }) =>
          Effect.promise(() => registry.listSubagentWorkspaces(session)),
        deleteSession: ({ id }: { id: string }) => Effect.promise(() => registry.deleteSession(id)),
        listSessions: () => Effect.promise(() => registry.listSessions()),
        deleteWorkspace: ({ id }: { id: string }) =>
          Effect.promise(() => registry.deleteWorkspace(id)),
      } as unknown as RemovalRegistry;

      const removal = removals(methods, {
        workspaces: {
          destroy: (object) =>
            Promise.resolve().then(() => {
              destroyedWorkspaces.set(key, [...(destroyedWorkspaces.get(key) ?? []), object]);
            }),
        },
        sessions: { destroy: () => Effect.void },
      });

      return removal
        .removeOwnSession(
          registered.session,
          destroySession({
            state: ctx,
            closeBrowser: Effect.succeed(false),
          }).pipe(Effect.provideService(SessionHost, this.#host)),
        )
        .pipe(Effect.orDie);
    });
  }

  /** Make this Session the import of Registry Session `session` in the test Registry `registry`, for `discard`. */
  importRegistry(session: string, registry: string): void {
    this.ctx.storage.kv.put("import-registry", { session, registry });
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

  /** What the MCP servers' Sampling requests have cost this Session, and how many reached a model. */
  samplingUsage() {
    return samplingTotals(this.ctx.storage.kv);
  }

  /** The records of the Sampling requests, oldest first. */
  samplingRecords() {
    return Effect.runPromise(this.#mcpSampling().service.records);
  }

  /** Shortens how long a message's expansion, and a spill's Workspace calls, may take in this Session, from `ms` ms. */
  expandTimeoutMs(ms: number): void {
    this.ctx.storage.kv.put("expand-timeout-ms", ms);
  }

  /**
   * What the Workspace holds at a Result Spill's `path`, as a card's preview reads it (`SessionHost.spill`). The read
   * runs on a test clock, which only the slot's wait moves, so the Workspace's limit counts test-clock time only: a
   * loaded runner's slow Workspace call never times the read out. That path (a Workspace call over the limit, `missing`)
   * is therefore not covered here.
   */
  spill(
    path: string,
    { held = [], slotAfterMs = 0, expandMs, duringWait = async () => {} }: TestSpillRead = {},
  ): Promise<SpillRead> {
    if (expandMs !== undefined) this.expandTimeoutMs(expandMs);

    // The slot is given once `duringWait` is done and `slotAfterMs` have passed on the read's clock, and the sizes it was
    // asked for are told in `held`.
    return this.#runtime.runPromise(
      this.#host
        .spill(undefined, path, (bytes) =>
          Effect.promise(duringWait).pipe(
            Effect.andThen(TestClock.adjust(slotAfterMs)),
            Effect.as("held" as const),
            Effect.tap(() => Effect.sync(() => held.push(bytes))),
          ),
        )
        // @effect-diagnostics-next-line strictEffectProvide:off -- the read's own entry point: its clock is the test's.
        .pipe(Effect.provide(TestClock.layer())),
    );
  }

  /** Whether no work is live; reads only, so it never runs work itself. */
  idle(): Promise<boolean> {
    return Effect.runPromise(this.#host.idle);
  }

  submit({ requestId, text }: TestPrompt): Promise<number> {
    return this.#runtime.runPromise(this.#host.submit({ requestId, input: text }));
  }

  /** Submit `text` as the owner typed it, and say why it was refused: its message, and the code and server it carries. */
  submitFailure({ requestId, text }: TestPrompt): Promise<{
    readonly message: string;
    readonly code: string | undefined;
    readonly server: string | undefined;
  }> {
    return this.#runtime.runPromise(
      this.#host.submit({ requestId, input: text }).pipe(
        Effect.flip,
        Effect.map((error) => ({ message: error.message, code: error.code, server: error.server })),
      ),
    );
  }

  /**
   * Submit `text` with the MCP prompt `ref`, as the socket's `submit` does: the submission, or why it was refused (its
   * message, and its code and server when it carries them).
   */
  submitMcpPrompt({
    requestId,
    text,
    ref,
    input,
    pages,
  }: TestPrompt & {
    readonly ref: McpPromptRef;
    /** The owner's whole input, in place of `text`: its text and the images they attached. */
    readonly input?: UserInput;
    /** The pages the message attaches, as read. */
    readonly pages?: ReadonlyArray<AttachedPage>;
  }): Promise<
    | { readonly submission: number }
    /** Stop withdrew it before it was placed. */
    | { readonly withdrawn: true }
    | {
        readonly failure: {
          readonly message: string;
          readonly code?: string | undefined;
          readonly server?: string | undefined;
        };
      }
  > {
    const prompt: Types.Mutable<Prompt> = {
      requestId,
      input: input ?? text,
      mcpPrompt: { ref, redact: Effect.succeed(<A>(value: A): A => value) },
    };

    if (pages !== undefined) prompt.attachPages = Effect.succeed(pages);

    return this.#runtime.runPromise(
      this.#host.submit(prompt).pipe(
        Effect.map((submission) => ({ submission })),
        Effect.catchIf(isWithdrawn, () => Effect.succeed({ withdrawn: true as const })),
        Effect.catch((error) =>
          Effect.succeed({
            failure: { message: error.message, code: error.code, server: error.server },
          }),
        ),
      ),
    );
  }

  /**
   * Submit `text` with the MCP resources `refs` attached, as the socket's `submit` does: the submission, or why it was
   * refused (its message, and its code and server when it carries them).
   */
  submitResources({
    requestId,
    text,
    refs,
  }: TestPrompt & { readonly refs: ReadonlyArray<ResourceRef> }): Promise<
    | { readonly submission: number }
    | {
        readonly failure: {
          readonly message: string;
          readonly code?: string | undefined;
          readonly server?: string | undefined;
        };
      }
  > {
    return this.#runtime.runPromise(
      this.#host
        .submit({
          requestId,
          input: text,
          resources: { refs, redact: Effect.succeed(<A>(value: A): A => value) },
        })
        .pipe(
          Effect.map((submission) => ({ submission })),
          Effect.catch((error) =>
            Effect.succeed({
              failure: { message: error.message, code: error.code, server: error.server },
            }),
          ),
        ),
    );
  }

  /** The MCP resources the root conversation's `@` menu lists. */
  resourceMenu(): Promise<McpResourceMenu> {
    return this.#runtime.runPromise(this.#host.resourceMenu());
  }

  /**
   * Submit `text` with its preparation held for good (a page read that never ends), and say how it ended: `withdrawn`
   * when Stop withdrew it, `placed` otherwise. Any other failure rejects.
   */
  submitHeld({ requestId, text }: TestPrompt): Promise<"placed" | "withdrawn"> {
    return this.#runtime.runPromise(
      this.#host.submit({ requestId, input: text, attachPages: Effect.never }).pipe(
        Effect.as("placed" as const),
        Effect.catchIf(isWithdrawn, () => Effect.succeed("withdrawn" as const)),
      ),
    );
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
          importEntries: (entries, apps, questions) =>
            Effect.promise(() => target.importEntries(entries, apps, questions)),
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

  importEntries(
    entries: ReadonlyArray<EntryRecord>,
    apps?: ReadonlyArray<McpAppCopy>,
    questions?: ReadonlyArray<McpQuestionCopy>,
  ): Promise<void> {
    return this.#runtime.runPromise(this.#host.importEntries(entries, apps, questions));
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

  /**
   * The parts of the root conversation's last owner message, each as `text:<text>` or `image:<base64>`, so a test reads
   * their order.
   */
  lastUserContent(): Promise<ReadonlyArray<string>> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const page = yield* callDurable("entries", (context) =>
          root.entries({ order: "descending" }, 100, undefined, context),
        );

        const owner = Arr.findFirst(
          page.items,
          (entry) => entry.kind === "cloudpid.user" || entry.kind === "pi.user",
        );

        const message = Option.flatMap(owner, (entry) => Option.fromNullishOr(entry.model?.[0]));

        if (Option.isNone(message) || message.value.role !== "user") return [];

        const { content } = message.value;

        return Predicate.isString(content)
          ? [`text:${content}`]
          : Arr.map(content, (block) =>
              block.type === "text" ? `text:${block.text}` : `image:${block.data}`,
            );
      }),
    );
  }

  /** The root conversation's entries (or `conversationId`'s), oldest first: each one's kind, data, and the text of its message. */
  rootEntries(
    conversationId?: ConversationId,
  ): Promise<
    ReadonlyArray<{ readonly kind: string; readonly data: unknown; readonly text: string }>
  > {
    return this.importedEntries(conversationId).then((entries) =>
      Arr.map(entries, ({ kind, data, text }) => ({ kind, data, text })),
    );
  }

  /** `rootEntries` with each entry's ID and head too, which a Session import's tests read to see how entries are numbered and where the context starts. */
  importedEntries(conversationId?: ConversationId): Promise<
    ReadonlyArray<{
      readonly id: number;
      readonly kind: string;
      readonly data: unknown;
      readonly text: string;
      readonly head: number | undefined;
    }>
  > {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        const conversation =
          conversationId === undefined
            ? yield* harness.root({})
            : yield* callDurable("conversation", (context) =>
                harness.harness.conversation(conversationId, context),
              );

        if (conversation === undefined) return [];

        const page = yield* callDurable("entries", (context) =>
          conversation.entries({ order: "ascending" }, 500, undefined, context),
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

          return { id: entry.id, kind: entry.kind, data: entry.data, text, head: entry.head };
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

  /** The root conversation's Todo List and its Notes and Handoff, as the documents hold them. */
  importedDocs() {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        return yield* callDurable("snapshot", async (context) => ({
          todo: await harness.harness.snapshot(TodoDoc, ROOT_CONVERSATION_ID, context),
          context: await harness.harness.snapshot(ContextDoc, ROOT_CONVERSATION_ID, context),
        }));
      }),
    );
  }

  /**
   * Leave an inline MCP task's record whose call is no longer live, as a call that was cut off leaves it (`taskId` is
   * the server's id for it): what the sweep ends.
   */
  leaveOrphanMcpTask(taskId: string): Promise<void> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        yield* callDurable("commit", (context) =>
          harness.harness.commit(async (tx) => {
            addTask(await tx.doc(McpTasksDoc), {
              taskId,
              server: "docs",
              tool: "report",
              modelTool: "mcp__docs__report",
              conn: "conn-docs",
              transport: "http",
              conversation: ROOT_CONVERSATION_ID,
              agent: "root",
              callId: "call-gone",
              // SAFETY: the ID of no task that is live.
              callTask: 987_654 as TaskId,
              windowMs: 600_000,
              createdAt: Date.now(),
              ttlMs: null,
              status: "working",
            });
          }, context),
        );
      }),
    );
  }

  /** The Session's MCP task records, by handle: where each stands and who ended it. */
  mcpTaskRecords(): Promise<Readonly<Record<string, { status: string; by?: string }>>> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;

        const doc = yield* callDurable("snapshot", (context) =>
          harness.harness.snapshot(McpTasksDoc, context),
        );

        return Record.map(doc?.tasks ?? {}, (task) =>
          task.end === undefined
            ? { status: task.status }
            : { status: task.status, by: task.end.by },
        );
      }),
    );
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

  /** The live tool calls, each with the restarts pi-durable counts toward its restart limit (0 for none), and whether it runs now. */
  toolCalls(): Promise<ReadonlyArray<ToolCallTask>> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const { tasks } = yield* harness.inspect;

        return Arr.flatMap(tasks, ({ record, state }) =>
          record.kind === "pi.tool"
            ? [
                {
                  id: record.id,
                  restarts: record.restarts ?? 0,
                  running: state.kind === "running",
                },
              ]
            : [],
        );
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

  /**
   * The code update reaches this instance (a Session named `mcp-replaced-*`): from now on its storage refuses every
   * operation, while the calls it has carry on.
   */
  replace(): void {
    this.#replaceable?.trip();
  }

  /** Put this Session in Environment `environment`, whose MCP set has `servers` servers, as the Registry says. */
  mcpEnvironment(environment: string, servers: number): void {
    this.ctx.storage.kv.put("mcp", { environment, servers });
  }

  /**
   * Shorter times for the MCP tasks of this Session (the window, the polls, the grace of a `-32602`, the backoff and the
   * wait for an ignored cancel), read when its MCP tools are built: set it before the Session starts, or evict it.
   */
  mcpTaskTiming(timing: McpTasksTiming): void {
    this.ctx.storage.kv.put("mcp-task-timing", timing);
  }

  /** Offer `offered` in the Settings of a Session with MCP tools, and read them again as a settings change does. */
  mcpOffered(offered: ReadonlyArray<string>): Promise<void> {
    this.ctx.storage.kv.put("mcp-global", { tools: { offered } });

    return Effect.runPromise(this.#host.sync);
  }

  /** Hold a Session with MCP tools to a spend limit of `perSession` US dollars, and read the settings again. */
  mcpSpendLimit(perSession: number): Promise<void> {
    const { kv } = this.ctx.storage;

    kv.put("mcp-global", {
      ...kv.get<Record<string, Schema.Json>>("mcp-global"),
      spendLimit: { perSession },
    });

    return Effect.runPromise(this.#host.sync);
  }

  /** What the MCP reinstalls did since `mcpOrderClear`, in order: `announce` (the notices are written) and `install`. */
  mcpOrder(): ReadonlyArray<string> {
    return this.ctx.storage.kv.get<string[]>("mcp-order") ?? [];
  }

  mcpOrderClear(): void {
    this.ctx.storage.kv.delete("mcp-order");
  }

  /** What the Registry answers this Session's next Sign-in asks (`McpSignInAskAnswer`). */
  scriptSignIn(answer: McpSignInAskAnswer): void {
    this.ctx.storage.kv.put("signin-answer", answer);
  }

  /** The Sign-in asks the Registry was made and the waiters withdrawn since. */
  signInAsks() {
    const { kv } = this.ctx.storage;

    return {
      asked: kv.get<unknown[]>("signin-asks") ?? [],
      withdrawn: kv.get<unknown[]>("signin-withdrawn") ?? [],
    };
  }

  /** A failed sign-in attempt carried to this Session (`SessionMethods.mcpSignInsFailed`): how many open requests changed. */
  failSignIns(requests: ReadonlyArray<string>, problem: string): Promise<number> {
    return Effect.runPromise(this.#mcpSignIns().service.failed(requests, problem));
  }

  /** A completed sign-in carried to this Session (`SessionMethods.mcpSignInsResolved`): how many open requests it ended. */
  resolveSignIns(requests: ReadonlyArray<string>): Promise<number> {
    return Effect.runPromise(this.#mcpSignIns().service.resolve(requests));
  }

  /** Make looking up the Session's Workspace fail, or succeed again. */
  mcpWorkspaceUnknown(unknown: boolean): void {
    this.ctx.storage.kv.put("mcp-workspace-unknown", unknown);
  }

  /** Make marking the Workspace used fail, or succeed again. */
  mcpWorkspaceFails(fails: boolean): void {
    this.ctx.storage.kv.put("mcp-ready-fails", fails);
  }

  /** The tool declarations each request offered the model, as JSON, oldest first. */
  requestDeclarations(): readonly string[] {
    return this.ctx.storage.kv.get<string[]>("request-declarations") ?? [];
  }

  /** How many system messages each request's transcript carried, oldest first: one more is a changed prompt. */
  requestSystemMessages(): readonly number[] {
    return (this.ctx.storage.kv.get<string[]>("request-messages") ?? []).map(
      (messages) =>
        // SAFETY: the messages as the fixture's model stored them, JSON of pi-ai messages.
        (JSON.parse(messages) as ReadonlyArray<{ readonly role: string }>).filter(
          (message) => message.role === "system",
        ).length,
    );
  }

  /** The text each request's transcript left in effect for system prompt section `key`, oldest first. */
  requestSection(key: string): ReadonlyArray<string | undefined> {
    return (this.ctx.storage.kv.get<string[]>("request-messages") ?? []).map((messages) => {
      let shown: string | undefined;

      // SAFETY: the messages as the fixture's model stored them, JSON of pi-ai messages.
      for (const message of JSON.parse(messages) as ReadonlyArray<{
        readonly role: string;
        readonly sections?: Readonly<Record<string, string | null>>;
      }>) {
        const text = message.role === "system" ? message.sections?.[key] : undefined;

        if (text !== undefined) shown = text === null ? undefined : text;
      }

      return shown;
    });
  }

  /** How many times the Session marked its Workspace used before an MCP host call. */
  mcpReady(): number {
    return this.ctx.storage.kv.get<number>("mcp-ready") ?? 0;
  }

  /** The namespaces `codemode` was last installed with. */
  codemodeNamespaces(): ReadonlyArray<CodemodeNamespace> | undefined {
    return this.ctx.storage.kv.get<ReadonlyArray<CodemodeNamespace>>("codemode-namespaces");
  }

  /** What the root conversation's tool calls of the current round published in `details`, in call order. */
  liveToolDetails(): Promise<ReadonlyArray<unknown>> {
    return this.#runtime.runPromise(
      Effect.gen(function* () {
        const harness = yield* Harness;
        const root = yield* harness.root({});

        const live = yield* callDurable("snapshot", (context) =>
          harness.harness.snapshot(LiveDoc, root.id, context),
        );

        return Arr.map(live?.tools ?? [], (slot) => slot.details);
      }),
    );
  }

  /** The Resource watches the Session lists, as `mcp_watches` sends them. */
  watchList(): Promise<ReadonlyArray<McpWatchEntry>> {
    return Effect.runPromise(this.#mcpWatches().service.list);
  }

  /** Record a Resource watch as the MCP tools do when the host started one. */
  async watchStarted(watch: McpWatched): Promise<void> {
    // The runtime builds the layers the service is provided by.
    await this.#runtime.runPromise(Effect.void);
    await Effect.runPromise(this.#mcpWatches().service.started(watch));
  }

  /** The App calls of the root conversation (or `conversationId`), as `mcp_apps` lists them. */
  appCalls(
    conversationId: ConversationId = ROOT_CONVERSATION_ID,
  ): Promise<ReadonlyArray<McpAppEntry>> {
    return Effect.runPromise(this.#mcpApps().service.list(conversationId));
  }

  /** Mount App call `callId`, as `mcp_app_mount` does. */
  appMount(callId: string): Promise<McpAppMounted> {
    return Effect.runPromise(this.#mcpApps().service.mount(callId));
  }

  /** Keep an App record as the `mcp` extension's tools do, for a test of the bounds. */
  async appPut(draft: McpAppDraft): Promise<void> {
    // The runtime builds the service's layer, which binds the Secrets its redaction needs.
    await this.#runtime.runPromise(Effect.void);
    await Effect.runPromise(this.#mcpApps().service.put(draft));
  }

  /** Stop everything, as Stop all and Archive do: every branch and every subagent, background work included. */
  stopEverything(): Promise<void> {
    return Effect.runPromise(this.#host.stopEverything);
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
      // As the Session DO's alarm: a Session that deleted itself runs nothing more.
      this.#imports.sweep.pipe(
        Effect.flatMap((deleted) =>
          deleted
            ? Effect.void
            : Effect.flatMap(Effect.service(Secrets), (held) => held.sweep).pipe(
                Effect.andThen(this.#host.alarm),
              ),
        ),
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

  /**
   * Hold the test browser host's reads of the Owner tabs from now on: each is told (`ownerTabReads`) as it starts, and
   * never ends unless it is interrupted, as Stop interrupts a message's preparation.
   */
  holdOwnerTabReads(): void {
    this.ctx.storage.kv.put(OWNER_TAB_READS_HELD, true);
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

  /** The Registry's kept Secrets cannot be read (or can again), as an ask for them fails. */
  keptFails(fails: boolean): void {
    this.ctx.storage.kv.put("kept-fails", fails);
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

  /**
   * The MCP side of the owner's write on a Sampling card: the Session's own Environment as the test Registry lists it, and
   * no host to push to (the tests read the Settings the write left in the Registry).
   */
  #samplingMcpAccess(): SettingsMcpAccessService {
    const session = this.ctx.id.name ?? "";
    const registry = this.#settingsRegistry("sampling-registry");
    const unused = () => Effect.die("A Sampling card's write reads no more of the MCP set");

    return {
      view: unused,
      // None while the test names no Registry: the Session is then not one it lists.
      own: Effect.suspend(() =>
        this.ctx.storage.kv.get<string>("sampling-registry") === undefined
          ? Effect.succeed(null)
          : registry
              .sessionSettings({ session })
              .pipe(Effect.map(({ environment }) => environment)),
      ),
      check: unused,
      reload: unused,
      pushes: () => Effect.succeed([]),
      pushed: () => Effect.void,
      host: () => ({
        requestStart: unused,
        servers: unused,
        apply: unused,
        request: unused,
      }),
      workspace: Effect.succeed(null),
    };
  }

  /** Name the test Registry that `rememberSampling` writes to: the Settings and Agent changes a Sampling card's choice leaves. */
  samplingRegistry(name: string): void {
    this.ctx.storage.kv.put("sampling-registry", name);
  }

  /** The Registry's Settings as the `settings_*` tools reach them: the test Registry the Session reports to. */
  #settingsRegistry(key = "registry"): SettingsRegistry {
    const registry = () => {
      const name = this.ctx.storage.kv.get<string>(key);

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
      // The test Registry holds no MCP servers.
      mcpServerNames: () => Effect.succeed(null),
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

    if (registry === undefined) {
      const mcp = kv.get<{ readonly environment: string; readonly servers: number }>("mcp");

      return mcp === undefined
        ? { global: {}, overrides: {} }
        : {
            global: kv.get<Schema.Json>("mcp-global") ?? {},
            overrides: {},
            environment: mcp.environment,
            mcp: { servers: mcp.servers },
          };
    }

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
  /** As `#report`, for the number of MCP tasks the Session follows: recorded for a test to read. */
  async #reportMcpTasks(count: number): Promise<void> {
    const { kv } = this.ctx.storage;
    const mode = kv.get<string>("reportMode");

    if (mode === "failing") throw new Error("Registry is down");

    if (mode === "hanging") await new Promise(() => undefined);

    const registry = kv.get<string>("registry");

    if (registry !== undefined) {
      await this.env.REGISTRIES.getByName(registry).setSessionMcpTasks(
        this.ctx.id.name ?? "",
        count,
      );
    }

    kv.put("reportedMcpTasks", [...(kv.get<number[]>("reportedMcpTasks") ?? []), count]);
  }

  /** The numbers of MCP tasks this Session reported to the Registry, oldest first. */
  reportedMcpTasks(): ReadonlyArray<number> {
    return this.ctx.storage.kv.get<number[]>("reportedMcpTasks") ?? [];
  }

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

      kv.put("request-declarations", [
        ...(kv.get<string[]>("request-declarations") ?? []),
        JSON.stringify(getCurrentTools(request.messages)),
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
