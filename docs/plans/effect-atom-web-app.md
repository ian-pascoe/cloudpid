# Plan: the web app's state in Effect Atom

Refactor `apps/web/src` so that every piece of state lives in an atom over one Effect runtime, as if the app had been written with Effect Atom from the start. The decision and its reasons are in `docs/adr/0011-web-app-state-in-effect-atom.md`; read it first. The app's behaviour does not change: `docs/spec.md` → _Client and protocol_ and the existing tests are the behaviour spec, and the UI looks and acts the same at every step.

The work ships as seven **stacked PRs**, done in one run. Each PR is a branch off the one before; each leaves the app working and `pnpm check` green.

## Ground rules

- **Parity.** Every behaviour an existing test pins down still holds afterwards. When a test moves, it moves whole: each `it` keeps a counterpart with the same name and the same assertions. Delete old code only once its counterpart passes.
- **Gate.** A step is done when `pnpm check` passes (typecheck, lint, test, format) and `pnpm --filter @cloudpid/web run build` succeeds. Run `pnpm --filter @cloudpid/web test` while you work.
- **Commits** are Conventional Commits (`refactor(web): …`, `build(web): …`, `test(web): …`, `docs: …`). Hooks run lint-staged and typecheck; leave them on.
- **Imports** follow the repo: relative imports end in `.ts`/`.tsx`, Effect modules are imported by path (`import * as Atom from "effect/reactivity/Atom"`, as `registry.ts` already does for `effect/rpc/RpcClient`).
- **Vocabulary.** Name things with `GLOSSARY.md`'s terms (Session, Workspace, Slug, Attachment, Todo List, Usage, Browser Handoff, Secret). Atoms are `<thing>Atom`, families `<thing>Atom(key)`, services singular nouns (`RegistryClient`, `SessionClient`, `Uploads`, `PushManager`).

## Architecture reference

Consult this while doing the steps; it is the single source for the patterns every step uses.

### Packages and the unstable flag

- Atom is in `effect@4.0.5` under **`effect/reactivity`** (`Atom`, `AtomRegistry`, `AtomRpc`, `AsyncResult`, `Reactivity`); read the installed source, `node_modules/.pnpm/effect@4.0.5/node_modules/effect/src/reactivity/`. `.repos/effect` is ahead of 4.0.5 and documents APIs the installed version lacks (typed `Reactivity.Keys`, `InitialValueOptions`); its `packages/effect/test/reactivity/` tests are still worth reading for patterns.
- React bindings: **`@effect/atom-react@4.0.5`** (`RegistryProvider`, `useAtomValue`, `useAtomSet`, `useAtom`, `useAtomMount`, `useAtomRefresh`, `ScopedAtom.make`); source in `.repos/effect/packages/atom/react/src/`.
- Browser services: **`@effect/platform-browser@4.0.5`** (`BrowserSocket.layerWebSocketConstructor`, `Clipboard`); source in `.repos/effect/packages/platform/browser/src/`.
- The socket is **`effect/socket/Socket`** (`makeWebSocket`, `fromWebSocket`, `WebSocketConstructor`).
- `effect/reactivity`, `effect/socket`, `@effect/atom-react` and `@effect/platform-browser` are unstable: they are listed in `allowedUnstableApis` in `packages/config/tsconfig/base.json` beside `effect/http` and `effect/rpc`.

### The runtime

- `src/runtime.ts` exports `appRuntime = Atom.runtime((get) => Layer.mergeAll(get(RegistryClient.runtime.layer), …the app's live layers))`.
- `AtomRpc.Service` builds its own runtime (`RegistryClient.runtime`). Compose its layer into `appRuntime` through `get(RegistryClient.runtime.layer)`, so domain `fn`s can `yield* RegistryClient`. Both runtimes come from the default factory (`Atom.runtime`), which shares one `Layer.MemoMap` and one `Reactivity` per registry. That gives one RPC client, and a mutation's reactivity keys reach every query.
- `main.tsx` mounts one `RegistryProvider` around `<App />` under `StrictMode`. The provider disposes its registry 500 ms after unmount, which is what makes StrictMode's double mount safe.
- **Tests** build `AtomRegistry.make({ initialValues: [[appRuntime.layer, testLayer], [RegistryClient.runtime.layer, fakeRegistryLayer]] })` and drive atoms through `registry.get`, `registry.set` and `registry.mount`. They use no React, no jsdom, and no React Testing Library. An Effect a test runs itself (the `SessionClient`, a push operation) takes `TestClock`; atoms run on the registry's runtime, not the test fiber, so a test that moves time under atoms uses `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` (faking `setImmediate` stalls Effect's scheduler).

### Registry data

- `src/registry.ts` becomes `class RegistryClient extends AtomRpc.Service<RegistryClient>()("@cloudpid/web/RegistryClient", { group: RegistryRpcs, protocol: … })`. The protocol is `RpcClient.layerProtocolHttp({ url: RPC_PATH })` with `RpcSerialization.layerJson` and `FetchHttpClient.layer`, the same wiring as today.
- Queries are `RegistryClient.query(tag, payload, { reactivityKeys })`. Mutations are `RegistryClient.mutation(tag)`, called with `{ payload, reactivityKeys }`.
- **Reactivity keys**: `sessions`, `workspaces`, `repos:<slug>`, `workspace-settings:<slug>`, `settings`, `push`. A mutation names every key whose query it changes. Deleting a Workspace, for example, names `workspaces`, `sessions` and its `repos:<slug>`.
- `Answer<A>`, `RegistryApi` and `connectRegistry` are deleted. Components render `AsyncResult`. A component that must await one call's own outcome (a shared `concurrent` fn keeps one result for every caller) goes through `useCall` in `src/calls.ts`: use `AsyncResult.builder` or match it, and treat the `waiting` flag as "refreshing". The failure text shown to the owner stays the error's `message`.

### Session data

- `src/session/client.ts` holds `SessionClient`, built per Session as `sessionClientAtom(sessionId) = Atom.family((id) => appRuntime.atom(SessionClient.make(id)))`. It is scoped, so its finalizer closes the socket when nothing reads it.
- `SessionClient` keeps today's `SessionState` shape and folds events with `reduceEvents` from `@cloudpid/protocol`. Only the I/O is new. Its state is a `SubscriptionRef<SessionState>`, projected with `Atom.subscriptionRef`.
- **Slices** are derived atoms keyed by Session ID (and conversation ID where needed): status, view, queue, sending, failure, picked, Secret requests, Browser Handoff requests, the task graph, Usage, Todo List, thread. Each one reads only its field, so a subagent card does not re-render for every token the root streams. They replace `useSession(select)`, `useConnection`, `SessionProvider` and `SessionIdProvider`.
- Commands (`submit`, `configure`, `abort`, `answerSecrets`) are `appRuntime.fn`s keyed by Session ID. Requests (`catalog`, `files`, `command`) are Effects on `SessionClient`.

### Local state

- **Entity-keyed**: state that belongs to a Session, conversation or Workspace is an `Atom.family` keyed by that entity's ID. This covers the task panel being open, the rename draft and the page `problem` (per Session); Attachments, the file-search query and the catalog (per conversation); the edit and delete dialogs and the clone form (per Workspace).
- **Per-instance**: UI state with no natural key is a `ScopedAtom.make(…)` provided around the component. This covers the composer's `caret`, `focused` and `busy`, a card's `open`, and a form's `busy`.
- **Lifetime**: atoms dispose when nothing reads them, so they reset the way `useState` does. Add `Atom.keepAlive` only where this plan names it: the startup push sync, and `deletedHereAtom` (the Sessions this page asked to delete, which must outlive the page that asked).
- **Stays in React**: DOM refs, `useId`, `useImperativeHandle`, effects that only synchronise the DOM with a ref (`dialog.tsx`'s `showModal`, `menu.tsx`'s placement listeners), and what assistant-ui owns: the composer's text, and the thread runtime `useExternalStoreRuntime` builds from our atoms (root thread and child threads).
- **Pure helpers stay plain functions.** This covers `menu.ts`, `completion.ts`, `commands.ts`, `thread-messages.ts`, `tool-summary.ts`, `nested-calls.ts`, `format.ts`, `workspaces.ts` and others like them. Reword their `@effect-diagnostics` reason from "a React app with no Effect runtime" to "plain functions over native arrays" (or whatever they actually suppress).

## Steps

Each step is one branch and one PR, based on the previous step's branch (step 1 on `main`). After each step's gate passes, commit, push, and open its PR (below).

### 1. Foundation: `refactor/atom-1-foundation`

- `pnpm --filter @cloudpid/web add @effect/atom-react@4.0.5 @effect/platform-browser@4.0.5` and `pnpm --filter @cloudpid/web add -D @effect/vitest@4.0.5`, all pinned to the installed `effect`'s version.
- Add `effect/reactivity`, `effect/socket`, `@effect/atom-react` and `@effect/platform-browser` to `allowedUnstableApis`.
- Add `src/runtime.ts` (`appRuntime` with the layers that exist so far) and mount `RegistryProvider` in `main.tsx`.
- Commit `docs/adr/0011-web-app-state-in-effect-atom.md` and this plan.
- In `AGENTS.md` → _Infra_ → **Web app**, add one sentence: "Its state lives in Effect Atom over one runtime (`apps/web/src/runtime.ts`; ADR-0011)."

**Done when** the gate passes and the app renders unchanged with the provider mounted.

### 2. Registry, Sessions and Workspaces: `refactor/atom-2-registry`

- Rewrite `registry.ts` as `RegistryClient` (see _Registry data_) and add it to `appRuntime`.
- Replace `use-sessions.ts` with `src/sessions.ts`: `sessionsAtom` (`listSessions`, key `sessions`) and mutation `fn`s for create, rename, archive, unarchive and delete.
- The list refreshes as it does today, every 5 s while the page is visible:
  - a `visibleTickAtom` signal fires every 5 s while `document.visibilityState === "visible"`;
  - `sessionsAtom` is piped through `Atom.makeRefreshOnSignal(visibleTickAtom)` and `Atom.refreshOnWindowFocus`.
- Replace `use-workspaces.ts`'s `useWorkspaces` with `src/workspaces-state.ts`: `workspacesAtom` (key `workspaces`) and the create, rename and delete `fn`s.
- Move the consumers to these atoms: `app.tsx`, `sidebar.tsx`, `session-menu.tsx`, `workspaces-page.tsx`. Stop passing `sessions` and `workspaces` down as props where a component can read the atom itself.
- Add `src/sessions.test.ts` and `src/workspaces-state.test.ts`. Run them against a fake `RegistryClient` layer, and cover:
  - the first load and a load that fails;
  - every mutation refreshing the list through its keys;
  - the visible-only poll, driven with `TestClock` and a stubbed `visibilityState`.

**Done when** the gate passes, no file imports `use-sessions.ts` or `useWorkspaces` (`use-sessions.ts` is deleted), and every mutation's `reactivityKeys` are asserted in a test.

### 3. Settings, Workspace settings, repos and push: `refactor/atom-3-settings`

- `settingsAtom` (key `settings`) and the `updateSettings` `fn` replace `use-settings.ts`.
- `reposAtom(slug)` (key `repos:<slug>`) and the `cloneRepo` `fn` replace `useRepos`.
- `workspaceSettingsAtom(slug)` (key `workspace-settings:<slug>`) and the `updateWorkspaceSettings` `fn` replace `useWorkspaceSettings`, together with its `attempt` and `retry`. `useAtomRefresh` does the retrying.
- `PushManager` is a service whose live layer is built from `pageBrowser()`. `push.ts`'s `loadPushStatus`, `enablePush`, `disablePush` and `syncPush` become Effects over `PushManager` and `RegistryClient`, with the service-worker wait as an `Effect.timeout`.
- `pushStatusAtom` (key `push`) and the `enablePush`/`disablePush` `fn`s replace `use-push.ts`.
- `main.tsx`'s `registerServiceWorker().then(syncPush…)` becomes a `keepAlive` atom that `main.tsx` mounts once, or `App` mounts with `useAtomMount`.
- Port `push.test.ts`'s 18 tests to `@effect/vitest` with a fake `PushManager` layer. Add tests for the settings and Workspace settings atoms.
- Delete `use-settings.ts`, `use-push.ts` and `use-workspaces.ts`.

**Done when** the gate passes, `registry.ts` exports no promise API, and `grep -r "connectRegistry\|Answer<" apps/web/src` finds nothing.

### 4. Router and app-level flow: `refactor/atom-4-router`

- `router.ts`:
  - `pathAtom` reads `location.pathname` and listens to `popstate`, via `Atom.readable` with `get.addFinalizer`.
  - `navigateAtom` is a writable atom or `fn` that calls `pushState` and updates `pathAtom`.
  - Derived atoms: `sessionIdAtom`, `pageAtom` (`"settings" | "workspaces" | "session" | "empty"`) and `currentSessionAtom`.
  - Keep the pure path helpers and `router.test.ts`.
- `app.tsx`:
  - `notice`, `problem` and `deletedHere` become atoms.
  - "A Session is gone: leave its page if it is shown, and say why" (`left`, `deletedShown`) moves into the delete and archive `fn`s. The shown Session's `deleted` status feeds it in step 5; until then, keep the `onDeleted` prop.
  - The `sessionId` effect that clears `notice` and `problem` becomes part of navigating.
- `App` becomes layout only: it reads `pageAtom` and renders the page.
- Test the routing atoms, and the delete flow's notices: "Session deleted." here, and "That session was deleted." for a delete made on another device.

**Done when** the gate passes and `app.tsx` has no `useState`, `useEffect`, `useRef`, `useMemo` or `useCallback`.

### 5. `SessionClient`: `refactor/atom-5-session-client`

The largest step. `session/connection.ts` (1,136 lines) is rewritten as an Effect program in `session/client.ts`; see _Session data_. Port first, then switch over, then delete.

1. **Port the tests.** Port `session/connection.test.ts` (57 tests across the root, Secret requests, Browser Handoffs, reconnecting, the queue, the heartbeat, subagent threads, the task graph, Usage, Todo Lists, and the catalog and Slash commands) to `session/client.test.ts` with `@effect/vitest`:
   - a fake `Socket.WebSocketConstructor` layer stands in for `FakeSocket`;
   - `TestClock` stands in for fake timers;
   - an injected probe service stands in for the probe argument.
2. **Implement** `SessionClient` until every ported test passes. Behaviour to keep, with the same constants and their exported names:
   - **Reconnect:** 500 ms doubling to a 10 s cap, with no jitter (`min(500·2^attempts, 10 000)`, written out rather than a `Schedule` because the attempt count resets when a snapshot lands). Every reconnect watches again and starts from a fresh snapshot.
   - **Heartbeat:** a ping every 25 s (`HEARTBEAT_INTERVAL_MS`); a socket silent 10 s after a ping is replaced (`PONG_TIMEOUT_MS`).
   - **HTTP probe** after 2 failed attempts. It decides between `signed-out` and `missing`; a close with `SESSION_DELETED_CLOSE_CODE` means `deleted`.
   - **Submits** waiting for a socket are held, and sent again under the same `requestId` on reconnect. Each one settles its `onOutcome` exactly once.
   - **Requests** (`catalog`, `files`, `command`) are correlated by command ID in a map of `Deferred`s. One that is in flight when the socket drops fails with today's message. A request that `acts` reports that it may have run.
   - **Thread watches** are refcounted per conversation with `RcMap`. The last release sends `unwatch`.
   - **Task graph and Usage** are watched for as long as the Session is shown. Their atoms do the watching.
3. **Switch over.** `chat/session-chat.tsx` reads the slices and calls the command `fn`s. `useExternalStoreRuntime` is fed from them. The `deleted` status drives step 4's leave-the-page flow, and the `onDeleted` prop goes.
4. **Delete** `session/connection.ts`, `session/connection.test.ts`, and the connection half of `chat/session-context.tsx`.

**Done when** the gate passes, `client.test.ts` has a counterpart for each of the 57 tests in `connection.test.ts` (same names), and `grep -r "SessionConnection\|useSyncExternalStore" apps/web/src/session apps/web/src/chat/session-chat.tsx` finds nothing.

### 6. Chat consumers: `refactor/atom-6-chat`

Move every consumer of the old connection and every chat store to atoms:

- `subagent-card.tsx`, `task-panel.tsx`, `usage-badge.tsx`, `child-thread.tsx` (`watchThread` becomes mounting `threadAtom(sessionId, conversationId)`), `handoff-prompt.tsx`, `secret-form.tsx`, `thread.tsx`, `queue-adapter.ts`.
- `use-catalog.ts` becomes `catalogAtom(sessionId, conversationId)`. It keeps the 30 s freshness (`CATALOG_TTL_MS`) through `Atom.setIdleTTL` or a timed refresh, keeps the 5 s retry, and is asked for when the menu first opens.
- `use-file-search.ts` (`FileSearchStore`) becomes a query atom per conversation and a results atom:
  - keep the 120 ms debounce (`FILE_SEARCH_DEBOUNCE_MS`), the 30 s answer lifetime (`FILE_ANSWER_TTL_MS`), and the narrowing of the last answer while a request is in flight;
  - `fileResults` stays a pure function;
  - port `use-file-search.test.ts`'s 7 tests.
- `uploads.ts` becomes the `Uploads` service:
  - XHR inside `Effect.callback`, interrupted with `xhr.abort()`, with progress reported as it uploads. Effect's `HttpClient` has no upload progress, so XHR stays.
  - `removeAttachment` goes over `HttpClient`.
- `use-attachments.ts` becomes `attachmentsAtom(sessionId, conversationId)` with `fn`s to add, remove, hold, restore and release:
  - image fitting runs as an Effect over `image-budget.ts` (its encoder becomes an Effect) and `image-encode.ts`;
  - unmounting interrupts the uploads in progress, as today.
- `use-file-drop.ts` becomes an atom of the drag state; the zone element's listeners are a DOM effect on its ref.
- `composer.tsx`'s `useWide` becomes `wideAtom` over `matchMedia("(min-width: 640px)")`. `/copy` goes through `Clipboard`. The 30 s revocation of the download link (`DOWNLOAD_LINK_MS`) becomes an Effect.
- Delete `chat/session-context.tsx`.

**Done when** the gate passes, every `use-*.ts` under `chat/` is replaced or deleted, and no chat component reads a connection through context.

### 7. Local-state sweep and suppressions: `refactor/atom-7-local-state`

- Convert the remaining `useState`, `useEffect`, `useMemo`, `useCallback` and `useRef`-as-state in `settings-page.tsx`, `workspaces-page.tsx`, `sidebar.tsx`, `session-menu.tsx`, `thread.tsx`, `composer.tsx`, `secret-form.tsx`, `attachment-tiles.tsx`, `subagent-card.tsx`, `task-panel.tsx` and `model-picker.tsx`, following _Local state_.
- Remove `parts.tsx`'s unused `useIsStreaming`.
- Delete every "no Effect runtime" `@effect-diagnostics` suppression the code no longer needs. Reword the ones that remain on pure helpers; see _Local state_.
- Record what is left in React: `grep -rn "useState\|useEffect\|useMemo\|useCallback\|useReducer\|useSyncExternalStore" apps/web/src --include=*.tsx --include=*.ts`. Every hit must be one of the _Stays in React_ cases. Put the list in the PR body.

**Done when** the gate passes, every hit of that grep is a _Stays in React_ case, and `grep -rn "no Effect runtime" apps/web/src` finds nothing.

## Opening the stacked PRs

- Branch each step off the previous one: `git switch -c refactor/atom-<n>-<name>`.
- Open each PR with `gh pr create --base <previous branch>` (step 1: `--base main`). Title it `refactor(web): <step> (atom <n>/7)`, and write the body with the `pr` skill.
- When an earlier branch changes, restack from the top branch with `git rebase --update-refs <changed branch>` and push every branch it moved with `git push --force-with-lease`.
- Report when done: each PR's URL, each step's gate result, and step 7's list of what is left in React.
