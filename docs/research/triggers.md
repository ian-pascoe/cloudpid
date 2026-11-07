# Triggers research: cron and webhook

Research date: 2026-11-07. Sources are primary only (developers.cloudflare.com, docs.github.com, docs.slack.dev, RFCs, and the library repos named in each section). Where a doc does not say something, the section says "Silent" and names the doc checked. Quotes are short; the URL under each claim is the source.

## 1. GitHub webhook deliveries

- **Timeout is 10 s.** Respond with 2xx "within 10 seconds"; otherwise GitHub "terminates the connection and considers the delivery a failure." https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries ; the error is reported as `timed out`: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks
- **No automatic redelivery.** "GitHub does not automatically redeliver failed deliveries." The page's text is not split by webhook type. https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
- **Manual redelivery.** Only deliveries from the past 3 days can be redelivered. Repository: `POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`; organization: `POST /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`. Repo redelivery needs admin access. GitHub App webhooks can be redelivered by the app owner or app managers, through the UI or REST (the App REST page was not fetched). https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks ; https://docs.github.com/en/rest/repos/webhooks ; https://docs.github.com/en/rest/orgs/webhooks
- **Delivery GUID.** `X-GitHub-Delivery` is "a globally unique identifier (GUID) to identify the event." https://docs.github.com/en/webhooks/webhook-events-and-payloads (Delivery headers). **Silent** on whether a redelivery reuses the original GUID. The delivery list records each attempt with its own `guid` and a `redelivery` boolean: https://docs.github.com/en/rest/repos/webhooks
- **Signature.** `X-Hub-Signature-256` is `sha256=` plus the HMAC-SHA256 hex digest of the request body, keyed with the webhook secret. Compare in constant time. https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries ; https://docs.github.com/en/webhooks/webhook-events-and-payloads (Delivery headers). The legacy `X-Hub-Signature` is SHA-1 and is kept for compatibility. The docs sign "the request body" and "payload contents" and do not say "raw bytes" in so many words, so verify over the exact bytes received.
- **Max payload: 25 MB.** A larger event is not delivered for that webhook. https://docs.github.com/en/webhooks/webhook-events-and-payloads (Payload cap)
- **Ping.** "This event occurs when you create a new webhook." Payload: `hook`, `hook_id`, `zen`. https://docs.github.com/en/webhooks/webhook-events-and-payloads (ping)
- **API creation, repository.** `POST /repos/{owner}/{repo}/hooks` needs the "Webhooks" repository permission at write level, for user and installation tokens. https://docs.github.com/en/rest/overview/permissions-required-for-github-apps (section "Repository permissions for Webhooks"). Classic tokens need `write:repo_hook` or `repo`: https://docs.github.com/en/rest/repos/webhooks
- **API creation, organization.** `POST /orgs/{org}/hooks` needs the "Webhooks" organization permission at write level: https://docs.github.com/en/rest/overview/permissions-required-for-github-apps (section "Organization permissions for Webhooks"). The caller must be an organization owner: https://docs.github.com/en/rest/orgs/webhooks
- **Limit.** Up to 20 repository or organization webhooks per event type: https://docs.github.com/en/webhooks/types-of-webhooks
- Note: the permissions table's token columns are "UAT = user access token, IAT = installation access token" (same permissions page).

_Bears on:_ a 10 s ack forces enqueue-then-process. GitHub will not retry, so we need our own reconciliation through the deliveries API within the 3-day window.

## 2. GitHub App webhook

- **One webhook per App.** "Each GitHub App has a single webhook that is automatically created by GitHub. By default, the webhook is not subscribed to any events." It "cannot be deleted," but it can be deactivated. https://docs.github.com/en/webhooks/types-of-webhooks (GitHub App webhooks)
- **One URL and one secret.** The App registration takes one webhook URL and one "Webhook secret". https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps
- **No repo webhook needed.** An App webhook "can be configured to receive webhooks when specific events occur in a repository or organization that the app has been granted access to." https://docs.github.com/en/webhooks/types-of-webhooks (GitHub App webhooks)
- **Permission per event.** Each event section on the events page states its requirement, with "at least read-level access" unless noted. https://docs.github.com/en/webhooks/webhook-events-and-payloads
  - `issues`, `issue_comment`: Issues (repository), read.
  - `pull_request`, `pull_request_review`, `pull_request_review_comment`: Pull requests (repository), read.
  - `push`, `create`, `release`: Contents (repository), read.
  - `check_suite`, `check_run`: Checks (repository), read. The `requested` and `rerequested` action types need Checks write.
  - `workflow_run`, `workflow_job`: Actions (repository), read.
  - `status`: Commit statuses (repository), read.
  - `deployment_status`: Deployments (repository), read.
  - `label`, `star`, `repository`: Metadata (repository), read.
  - `member`: Members (organization), read.
  - `installation`: availability lists `app`; I did not find a permission sentence for it.
  - `ping`: available for repository, organization, app, business, and marketplace.
  - Availability: `issues`, `push`, `pull_request`, `check_suite` list repository, organization, and app. `workflow_run` lists business, repository, organization, and app.
- The same events page lists these for each event under "Availability." The App-level permission-to-webhook mapping is also described at https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app ("the minimum permissions required").

_Bears on:_ one App gives us one URL and one secret for every installed repo, so routing has to happen in our handler. Request only the permissions for events we subscribe to; `requested`/`rerequested` check events need Checks write.

## 3. Durable Object alarms

- **One alarm per object.** "Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`." Calling it again overrides the existing alarm. https://developers.cloudflare.com/durable-objects/api/alarms/
- **One `alarm()` at a time.** "Only one instance of `alarm()` will ever run at a given time per Durable Object instance." https://developers.cloudflare.com/durable-objects/api/alarms/
- **At-least-once.** "Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws." https://developers.cloudflare.com/durable-objects/api/alarms/
- **Retry on throw.** Exponential backoff, starting at 2 s, up to 6 retries. Retries apply only to the most recent `setAlarm()` call. The docs advise catching exceptions and rescheduling before returning if you want indefinite retry. https://developers.cloudflare.com/durable-objects/api/alarms/ . `alarmInfo.retryCount` and `isRetry` are exposed to the handler (same page).
- **`deleteAlarm()` in the handler** "may prevent retries on a best-effort basis, but is not guaranteed." https://developers.cloudflare.com/durable-objects/api/alarms/
- **Precision and latency.** **Silent.** The alarms page gives scheduled times in ms since epoch and says nothing about how late an alarm can fire.
- **Wakes an evicted object.** Yes, in effect. "The first incoming request or event (like an alarm) will execute the `constructor()`." The docs also say if the object is terminated by an error, `alarm()` "may be re-instantiated on another machine." https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ; https://developers.cloudflare.com/durable-objects/api/alarms/
- **Constructor caveat.** If the constructor calls `setAlarm`, it can override the next alarm. Check `getAlarm()` first. https://developers.cloudflare.com/durable-objects/api/alarms/
- **Cost.** Alarm invocations count as requests. Paid plan: 1 million requests/month included, then $0.15/million. Duration: 400,000 GB-s/month included, then $12.50/million GB-s. Idle objects eligible for hibernation are not billed for duration. https://developers.cloudflare.com/durable-objects/platform/pricing/ (values as of the fetch; check the page before quoting them).
- **Object count.** "Unlimited (within an account or of a given class)." https://developers.cloudflare.com/durable-objects/platform/limits/ . The alarms page says the same: "an unlimited amount of Durable Objects, each of which can have an alarm set." https://developers.cloudflare.com/durable-objects/api/alarms/

_Bears on:_ a per-object alarm loop must catch its own errors and reschedule, or it stops after 6 retries. Latency is undocumented, so do not rely on an alarm for strict timing.

## 4. Workers Cron Triggers

- **Configuration.** Set in the Wrangler config (`triggers.crons`), in the dashboard, or through the API. For Wrangler-managed Workers the docs say "Cron Triggers should be exclusively managed through the Wrangler configuration file." https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **Runtime change via API.** Yes: `PUT /accounts/{account_id}/workers/scripts/{script_name}/schedules` "Update the schedules (Cron Triggers) for a Worker script." https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/ . Changes take up to 15 minutes to propagate: https://developers.cloudflare.com/workers/configuration/cron-triggers/ . The alarms page says cron triggers "have to be configured through the Cloudflare dashboard or API": https://developers.cloudflare.com/durable-objects/api/alarms/
- **Minimum interval.** **Silent** as a stated minimum. The finest example is `* * * * *` ("At every minute"): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **Max per Worker.** The alarms page says "A Worker can have up to three Cron Triggers configured at once": https://developers.cloudflare.com/durable-objects/api/alarms/ . The cron page does not state a per-Worker limit and points to the limits page for the account maximum: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **Max per account.** 5 (Free) and 250 (Paid): https://developers.cloudflare.com/workers/platform/limits/
- **Timezone.** "Cron Triggers execute on UTC time." https://developers.cloudflare.com/workers/configuration/cron-triggers/ . No local-time option is documented.
- **Handler.** `scheduled()` receives `controller.cron` and `controller.scheduledTime` (ms since epoch), and `controller.noRetry()` exists. https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- **Logs.** Cron Events keeps the 100 most recent invocations; Workers Logs keeps longer. https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **Day numbering.** 1 = Sunday to 7 = Saturday, unlike most cron systems. https://developers.cloudflare.com/workers/configuration/cron-triggers/

_Bears on:_ a fixed set of platform crons (up to 3 per Worker, UTC) can drive a poller; per-user schedules belong in alarms or a DO-held schedule table, not cron.

## 5. Workers Logs, observability, Logpush, and Access logs

- **Invocation logs are on by default.** "By default a Worker will emit invocation logs containing details about the request, response and related metadata." Disable with `observability.logs.invocation_logs = false`. https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- **Fetch invocation message.** The message for a fetch invocation is `<Method> <URL>`. https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (handler table)
- **Query string and path.** The URL appears in the message. **Silent** on whether the query string is stored in the invocation log's request object, and the doc lists no field names for it. Treat the full URL as logged.
- **Redaction.** **Silent.** Neither the Workers Logs page nor the observability page documents a field-level redaction setting. The workable option is a Tail Worker, which the observability page describes as applying "custom filtering, sampling, and transformation logic": https://developers.cloudflare.com/workers/observability/logs/ . Its event includes `event.request.url` and headers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- **Size.** A log entry is capped at 256 KB and is truncated with `$cloudflare.truncated` set: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- **Logpush (`workers_trace_events`).** Fields are `Event` (object: "Details about the source event"), `Logs`, `Exceptions`, `EventType`, and others. The field page does not break `Event` down, so it does not confirm whether the URL is in it: https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/
- **Access bypass is not logged.** "Bypass does not enforce any Access security controls and requests are not logged." https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- **Access requests dataset.** The Logpush fields are `Action`, `Allowed`, `AppDomain`, `AppUUID`, `Connection`, `Country`, `CreatedAt`, `Email`, `IPAddress`, `RayID`, `UserUID`, and others. There is no URL or path field, and `AppDomain` is "The domain of the Application that Access is protecting." https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/access_requests/
- **Access log retention.** Free 24 hours, Standard 30 days, Enterprise 180 days, per tier: https://developers.cloudflare.com/cloudflare-one/insights/logs/

_Bears on:_ assume the path and query of a `/hooks/<secret>` URL land in Workers Logs and the tail stream. Put secrets in headers, not the path, or add a Tail Worker that strips the URL before forwarding. Redaction is undocumented, so test before relying on it.

## 6. Cloudflare Access bypass and path-scoped applications

- **Bypass.** "The Bypass action disables Access enforcement for specific traffic." It "does not support identity-based rule types." The docs use a `/admin` example with a bypass policy for "Everyone." https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ . Cloudflare "does not recommend using Bypass to grant direct permanent access to your internal applications." (same page). Bypass policies with device posture rules do not work in some cases; the page recommends Service Auth instead (same page).
- **Policy order.** "Bypass and Service Auth policies are evaluated first, from top to bottom ... Then, Block and Allow policies." Once an Allow or Block matches, evaluation stops. https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- **Sub-paths, wildcard.** A path with no wildcard, or `example.com/*`, covers the apex and every path under it. `example.com/alpha/*` covers `example.com/alpha/one` and `example.com/alpha/two`, but "does not cover" `example.com/alpha` or `example.com`. Wildcards may appear mid-path, e.g. `example.com/foo*/bar`. https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- **Specific paths override parents.** "the more specific rule takes precedence, and no rule is inherited from" the parent path. https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- **Ports.** Access strips port numbers from application paths and redirects to the default port. https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- **Practical reading.** A bypass on `hooks.example.com/hooks/*` would not cover `hooks.example.com/hooks` itself. The docs do not say whether a bypass on `/hooks/*` covers `/hooks/a/b` beyond the examples above; test it. The Service Token rule "will need to present the correct service token headers": https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ . A GitHub or Slack sender cannot add those headers, so Service Auth does not fit a public webhook (inference from that sentence, not stated in the docs).

_Bears on:_ a bypass on the webhook path is the only way the sender gets through Access, and it removes Access logging for those requests. Scope it to the exact route plus `/hooks/*` and keep the secret check in the Worker.

## 7. Cron expression parsing with IANA time zones in a Worker

- **Croner** (https://github.com/Hexagon/croner): "No dependencies." Takes a `timezone` option in IANA form (e.g. `Europe/Stockholm`). Lists Node.js 18+, Deno 2+, Bun 1+, and browsers. **Silent** on Cloudflare Workers / workerd; it must be tested there.
  - **DST, fixed-time jobs** (a single value in seconds, minutes, and hours, e.g. `0 30 2 * * *`): a time that occurs twice runs once, at the first occurrence. A time that does not exist runs at "the first valid time after the gap, on the same day."
  - **DST, interval jobs** (wildcard, step, range, or list, e.g. `*/5 * * * *`): a repeated time runs on both occurrences; a nonexistent time is skipped.
  - Croner says it deliberately deviates from OCPS 1.4 §4.3.1 to follow Vixie cron, which croner-rust also follows (same README).
- **cron-parser** (https://github.com/harrisiirak/cron-parser; the URL `harperreed/cron-parser` in the brief returns 404): MIT, v5.10.4 on `master`, one runtime dependency, `luxon ^3.7.2` (https://raw.githubusercontent.com/harrisiirak/cron-parser/master/package.json). The README says it provides "timezone support, DST handling" through Luxon. **Silent** on specific gap and overlap rules; it says only "handling DST transitions correctly."
- Cloudflare's own Cron Triggers run on UTC (see section 4), so a library is only needed for user-defined local-time schedules.

_Bears on:_ croner is the smaller, dependency-free choice, and its DST rules are explicit. Confirm it loads and fires under workerd (a `*.workerd.test.ts`) before choosing it. cron-parser pulls Luxon into the bundle and documents DST less precisely.

## 8. Slack Events API (for a generic HMAC receiver)

- **Signing scheme (not the GitHub one).** Headers `X-Slack-Signature` and `X-Slack-Request-Timestamp`; base string `v0:{timestamp}:{raw body}`; `HMAC-SHA256` with the signing secret, hex digest, prefixed `v0=`. Reject requests whose timestamp is more than 5 minutes from local time. Use a constant-time compare. Slack says "header names are meant to be case-insensitive." https://docs.slack.dev/authentication/verifying-requests-from-slack/
- **Raw body.** Use the body before JSON parsing. https://docs.slack.dev/authentication/verifying-requests-from-slack/
- **URL verification.** Body: `{"token": …, "challenge": "…", "type": "url_verification"}`. Respond HTTP 200 with the challenge as `text/plain`, as form-encoded `challenge=…`, or as JSON `{"challenge": "…"}`. https://docs.slack.dev/apis/events-api/using-http-request-urls/ . The `token` is the deprecated verification token; the signing secret is the one to use (https://docs.slack.dev/authentication/verifying-requests-from-slack/).
- **3 s timeout.** "Your app should respond to the event request with an HTTP 2xx within three seconds." https://docs.slack.dev/apis/events-api/
- **Retries.** Up to 3 retries: near-immediate, then after 1 minute, then after 5 minutes. Headers `x-slack-retry-num` and `x-slack-retry-reason` (`http_timeout`, `too_many_redirects`, `http_error`). If more than 95% of attempts fail within 60 minutes, subscriptions are disabled. https://docs.slack.dev/apis/events-api/
- **Conclusion.** A generic "HMAC over body" receiver would not verify Slack, which signs `v0:timestamp:body` and expects a timestamp check. It would also need a `url_verification` branch and a fast ack. Slack support needs a Slack-specific verifier and handler. The shared part is only the "verify, then enqueue" pattern.

_Bears on:_ a generic HMAC receiver can share the verify-then-enqueue path, but needs a Slack adapter for the signature base string, the timestamp check, and `url_verification`.

## 9. Size and concurrency ceilings (added during grilling)

- **Workers RPC.** "The maximum serialized RPC limit is 32 MiB"; a `ReadableStream` of bytes can carry more. https://developers.cloudflare.com/workers/runtime-apis/rpc/
- **Incoming request body.** Set by the zone's plan: 100 MB on Free and Pro, 200 MB on Business. https://developers.cloudflare.com/workers/platform/limits/
- **Containers, per account.** Concurrent memory 6 TiB, concurrent vCPU 1,500, concurrent disk 30 TB. https://developers.cloudflare.com/containers/platform-details/limits/

_Bears on:_ a 25 MiB request cap (GitHub's own payload cap) fits through one RPC call to the Trigger object. No platform ceiling makes a cap on concurrent trigger-started Sessions necessary at single-owner scale.
