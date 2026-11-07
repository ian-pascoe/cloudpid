# Long cleanup inside a Workers HTTP request: limits and failure modes

Researched 2026-11-07 against primary sources only: developers.cloudflare.com docs, Cloudflare changelog, and the `cloudflare/workerd` source (`main`, fetched 2026-11-07; line numbers refer to that fetch). Dates are each page's own "Last updated" line or the changelog post date. I found no 2025 changelog entry for the subrequest limit; the latest change is the 2026-02-11 entry in Q4.

Scenario: an owner's `/rpc` POST (Effect RpcServer over HTTP, `compatibility_date` 2026, Workers Paid, Standard usage model) runs dozens to hundreds of DO calls, service-binding RPC calls, and Workers RPC calls whose callee calls DOs.

## 1. Wall-clock duration of an HTTP invocation

- Limit: none while the client stays connected. Source: https://developers.cloudflare.com/workers/platform/limits/ (Last updated Oct 29, 2026), "Duration" section: "There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing, making subrequests, and streaming a response body. When the client disconnects or the response is complete, tasks associated with that request may be canceled."
- Disconnect: the Workers Errors page lists "`Cancelled` | The Client disconnected before the Worker completed its response." (https://developers.cloudflare.com/workers/observability/errors/, Last updated Oct 15, 2026).
- Grace period: not a disconnect rule, but runtime updates drain old processes: "processes running the previous version of the Workers runtime give existing Workers requests and connections up to 20 minutes to finish." (limits page, Oct 29, 2026). "Crashes, resource pressure, and shutdowns can interrupt work earlier."
- Streaming vs. non-streaming: the Context page says "If the client is still receiving the response, including a streamed response body, the Worker invocation remains active without `ctx.waitUntil()`." (https://developers.cloudflare.com/workers/runtime-apis/context/, Last updated Oct 12, 2026). Once the response is complete, the invocation is "done".
- Cancellation timing: the docs are not uniform. The limits page says work "may be canceled". The RPC lifecycle page is stricter: "As with HTTP, if the client disconnects, the server's execution context is canceled immediately, regardless of whether stubs still exist." (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/, Last updated Oct 8, 2026). Treat disconnect as immediate cancellation, with `waitUntil` as the only grace period.

## 2. CPU time per HTTP invocation (Paid)

- Default 30 s; maximum 5 min via `limits.cpu_ms`. Source: limits page (Oct 29, 2026), table row "CPU time per HTTP request | 10 ms | 5 min (default: 30 seconds)". Config example: `"cpu_ms": 300000, // default is 30000 (30 seconds)`; TOML `cpu_ms = 300_000`.
- Only active CPU counts: "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time." (limits page, Oct 29, 2026). Awaiting DO and RPC responses is free; serialization, parsing, and your own loops are not.
- Exceeding it: error 1102, "Worker exceeded resource limits" (limits page, Oct 29, 2026).

## 3. `ctx.waitUntil`

- The 30 s figure is confirmed. Source: https://developers.cloudflare.com/workers/runtime-apis/context/ (Oct 12, 2026), exact text: "For HTTP-triggered Workers, `ctx.waitUntil()` can extend execution for up to 30 seconds after the response is sent or the client disconnects. This is not a limit on the total wall time of an HTTP request. This time limit is shared across all `waitUntil()` calls within the same request. If any Promises have not settled after 30 seconds, they are canceled."
- Also: "When `waitUntil` tasks are canceled, the following warning will be logged ... `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.`" (same page).
- The budget is shared per request, so a cleanup that fans out after the response has 30 s total, not 30 s each.
- Docs' own alternative for longer work: "send messages to a Queue and process them in a separate consumer Worker" (same page).
- Un-awaited promises are not protected: "An async call that is neither awaited nor passed to `ctx.waitUntil()` can be canceled when the invocation ends" (same page).

## 4. Subrequest limit (Paid)

- Current value: 10,000 per invocation by default, configurable to 10 million. Source: limits page (Oct 29, 2026), "Subrequests per invocation | 50 | 10,000 (up to 10M)". Config: `limits.subrequests` in wrangler (same page: "You can change the subrequest limit per Worker using the `limits` configuration").
- Latest change: Changelog 2026-02-11, https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/ ("Workers are no longer limited to 1000 subrequests"): "Workers no longer have a limit of 1000 subrequests per invocation..." and "By default, Workers on paid plans are now limited to 10,000 subrequests per invocation, but this limit can be increased up to 10 million by setting the new `subrequests` limit in your Wrangler configuration file." The 1,000 figure is gone for Paid; Free stays at 50 external and 1,000 to Cloudflare services.
- Internal services: "Subrequests to internal services | 1,000 | Matches configured limit (default 10,000)" (limits page, Oct 29, 2026).
- Classification:
  - (a) DO stub calls (fetch and RPC): counted, per docs. The automatic-retries page says "Retries do not count toward the subrequest limit, including when you change the retry limits for a stub. Only the first attempt does." (https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/, Nov 5, 2026). That implies each first attempt counts. workerd: `startActorSubrequest` in `src/workerd/api/actor.c++` (lines 52-63, 102) calls `context.getSubrequest(...)` with `CountSubrequest::YES`, and `IoContext::getSubrequest` calls `limitEnforcer->newSubrequest(options.inHouse)` (`src/workerd/io/io-context.c++` 1382-1387). DO calls are flagged `inHouse = true`; the `io-context.h` comments (1195-1197) say in-house requests "are not subject to the same limits on the number of subrequests per request", so what the flag does in production is not documented.
  - (b) Service-binding calls: fetch counts (limits page: "Subrequests to internal services"). For Workers RPC over a binding, the docs are silent. In the workerd files I read, JS RPC resolves through `getRpcChannel` (`src/workerd/api/worker-rpc.c++` 1651-1673) and I found no `newSubrequest` call on that path. Treat RPC counting as unknown and measure it.
  - (c) Does a DO have its own budget? The limit is "per invocation", and each incoming call gets its own `IoContext`. workerd's `LimitEnforcer` "enforces on a per-request level" (`src/workerd/io/limit-enforcer.h`, line 34). So a DO's outbound calls are budgeted against that DO's incoming call, not the caller's. The docs do not state this in so many words.
- Simultaneous connections are a separate limit: "Each Worker invocation can have up to six connections simultaneously waiting for response headers." The listed calls are `fetch()`, KV, Cache, R2, Queues `send()`, and TCP `connect()`. DO stub calls and JS RPC are not in the list. "Workers triggered via Service bindings share the same connection limit." (limits page, Oct 29, 2026). This is the real fan-out bottleneck if the cleanup uses `fetch()`-based DO calls.

## 5. Durable Object request limits

- Wall time: "No hard limit while the caller stays connected to the Durable Object. Durable Objects remain active while a request, RPC call, response stream, WebSocket, or pending I/O is in flight." (DO limits, https://developers.cloudflare.com/durable-objects/platform/limits/, Oct 29, 2026).
- CPU: "CPU per request | 30 seconds (default) / configurable to 5 minutes of active CPU time" (same page). "Each incoming HTTP request or WebSocket _message_ resets the remaining available CPU time to 30 seconds" (same page, footnote 4). Configure with `limits.cpu_ms` on the DO's Worker.
- Caller cancelled: the RPC lifecycle rule applies to DOs, since the RPC docs say "The 'server' is a Durable Object or WorkerEntrypoint" (https://developers.cloudflare.com/workers/runtime-apis/rpc/, Oct 12, 2026). So when the caller's context ends, the DO's in-flight call is canceled, not finished (lifecycle page, Oct 8, 2026). The DO's own `waitUntil` does not help: "Do not use `waitUntil()` to keep a Durable Object alive during normal request or RPC handling." (Context page, Oct 12, 2026). I did not find a doc sentence for "the DO keeps running after the caller disconnects", so assume it does not.
- What the caller sees: "If an exception is thrown by a Durable Object stub all in-flight calls and future calls will fail with exceptions. To continue invoking methods on a remote Durable Object a Worker must recreate the stub." (https://developers.cloudflare.com/durable-objects/api/stub/, Nov 5, 2026).
- Retries: "By default, the runtime makes up to five attempts in total... No retry starts more than 10 seconds after the initial call starts." Retries only cover errors with `.retryable` true; they never retry overloaded errors. A method "never runs twice because of a retry, unless you mark it with `retryable()`" (automatic-retries page, Nov 5, 2026).
- Overload: "An individual Object has a soft limit of 1,000 requests per second." Excess returns "overloaded" errors (DO limits page, Oct 29, 2026).

## 6. Workers RPC limits and lifetimes

- Serialized size: "The maximum serialized RPC limit is 32 MiB." (https://developers.cloudflare.com/workers/runtime-apis/rpc/, Oct 12, 2026).
- Execution context of an RPC callee: "The context begins when an RPC method on a `WorkerEntrypoint` is invoked. If no stubs are passed in the parameters or results of this RPC, the context ends (the event is 'done') when the RPC returns. However, if any stubs are passed, then the execution context is implicitly extended until all such stubs are disposed (and all calls made through them have returned)." (lifecycle page, Oct 8, 2026).
- HTTP handler: "When the final HTTP response is sent, the handler is 'done', and all stubs are immediately disposed." (same page). The execution context "may also end early if the client disconnects before receiving a response, or it can be extended past its normal end point by calling `ctx.waitUntil()`."
- Caller as client: "A client that is itself another Worker is considered to have disconnected when its own execution context ends." (lifecycle page, Oct 8, 2026).
- Stubs received as parameters are disposed on return: "When stubs are received in the parameters of an RPC, those stubs are automatically disposed when the call returns."; `dup()` keeps one (same page).
- Proxied stubs do not outlive the request: "Currently, this proxying only lasts until the end of the Workers' execution contexts. A proxy connection cannot be persisted for later use." (RPC page, Oct 12, 2026).
- Smart Placement is ignored for RPC: "when Worker B calls Worker A via RPC, Worker A will run locally, on the same machine." (RPC page, Oct 12, 2026).
- workerd: `RpcStubDisposalGroup` disposes an incoming call's parameter stubs "when that call completed" (`src/workerd/api/worker-rpc.c++`, lines 1635-1642).

## 7. RpcTarget passed through a service-binding call: does A's method outlive B's invocation?

Scenario: A handles the HTTP request and passes an `RpcTarget` (or stub) to B over a service-binding RPC. B calls back into A's target. B's caller disconnects, or B's invocation ends, while that call is in flight.

Docs answer (partial):

- A's HTTP execution context ends when its response is sent, and its stubs are disposed then. Only `ctx.waitUntil()` extends it (lifecycle page, Oct 8, 2026).
- "A client that is itself another Worker is considered to have disconnected when its own execution context ends." So when B's invocation ends, A sees B as disconnected (same page).
- An `RpcTarget` disposer "runs after the last stub is disposed. Note that the client-side call to the stub's disposer does not wait for the server-side disposer to be called" (same page). The docs do not say what happens to a method call already running.
- The docs never state whether an in-flight call into A's `RpcTarget` survives B's disconnect. The literal rule ("the server's execution context is canceled immediately") points to cancellation, but it is written for an RPC-invoked context, not for an HTTP-owned target.

Source reading (workerd, `main`, 2026-11-07):

- On abort, pending work is cancelled with "The execution context responding to this call was canceled." (`src/workerd/io/io-context.c++`, around lines 438-443).
- After the response or disconnect, `drain()` waits on `waitUntil` tasks, and "`drain()` is intended to be called after the client has received a response or disconnected" (`src/workerd/io/io-context.h`, lines 185-192). A `waitUntil` promise that wraps the target call keeps A's context alive for up to the 30 s budget.
- I did not trace the capnp path from B's dropped call to A's running JS method, so whether B's disconnect reaches A's JS promise is not verified.

Best reading: `ctx.waitUntil(promise)` in A keeps A's invocation (and the method's promise) alive for at most 30 s after the response or B's disconnect. It does not promise that B's disconnect leaves the call running. Do not depend on the call completing. Make the target's work idempotent and durable (write results to a DO, Workflow, or Queue), and let the HTTP caller re-query state.

## Implications

- Viability: inline is viable for "dozens to hundreds" of calls. The budgets are: wall time unlimited while the browser stays connected; CPU 30 s default (5 min max) of active CPU; subrequests 10,000 by default (10M max). Fan-out is bounded by the 6 simultaneous "waiting for headers" fetches, and that rule's reach into DO and RPC calls is unclear.
- Binding limit: the caller's connection. If the browser disconnects, the cleanup is cancelled. `waitUntil` only gives 30 s of shared grace, and runtime updates can cut it off earlier. CPU is the second constraint: count the serialization and parsing work of hundreds of RPC calls, not only the waits.
- Failure modes:
  1. Client disconnect: remaining DO and RPC calls are cancelled; partially applied cleanup.
  2. Stub exception: all in-flight calls on that stub fail; recreate the stub.
  3. DO overload or 1,000 req/s per object: "overloaded" errors; do not retry those.
  4. CPU limit: error 1102 on the HTTP invocation; DO CPU exceeded by its own limit.
  5. Runtime update: up to 20 min grace, then processes terminate.
- Recommendation: keep the request for kicking off and reporting progress; run the cleanup as a Workflow (per-step unlimited wall time, subrequests up to 10M), a DO alarm (15 min wall), or a Queue consumer (15 min wall). Make each step idempotent, because retries and cancellations can repeat them.
