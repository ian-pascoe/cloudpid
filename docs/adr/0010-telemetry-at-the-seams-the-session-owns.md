# Spans and the spend limit sit at the seams the Session owns

pi-durable 1.3.0 and pi-ai 1.3.0 emit no spans (the Harness has no `telemetry` option, and pi-ai only passes a `telemetryContext` through), and pi-durable's `beforeRequest` hook can only rewrite messages: one that throws is reported and skipped, so it cannot stop a request. The Session therefore wraps what it owns. Its `Models` (`aroundRequests` in `@cloudpid/telemetry`) make each request a `pi.ai.request` span and hold each request to the spend limit; a wrap on every tool makes each call a `pi.tool` span; the host makes the Runs and resumes spans. A request over the limit ends as an error message the Harness already ends a Run with (`model_error`), carrying the text that the owner's push shows. This also covers compaction summaries, which no hook would. When pi-durable ships `HarnessOptions.telemetry` the adapter (`effectTelemetry`) is passed there and the wrappers go.

Spans are Workers' own custom spans (`tracing` from `cloudflare:workers`) through an Effect `Tracer` built once per Durable Object, not alchemy's `Cloudflare.Telemetry()`, which builds a tracer per event and cannot serve a runtime that lives as long as the object. Workers nests a span under the async context's active span and cannot be told a parent, so a span keeps the context it started in and the fibers under it run in it.

## Considered Options

- **OTLP export to a third-party backend.** Needs a secret and a second place to look; Workers Observability keeps traces for 7 days and needs neither.
- **A `beforeRequest` hook for the limit,** as the plan first said. Cannot refuse a request in 1.3.0.
- **Refusing at the tool or submission boundary.** A Run in progress would still make requests; the model seam is the one place every request passes.

## Consequences

A limit is checked when a request starts, so requests already under way finish and a Session overshoots by what they cost. The title call counts toward the spend and is not refused. The Harness's own internal spans (the scheduler, storage) do not exist until pi-durable emits them. The span detail of a trace is in the dashboard; the query API lists trace summaries.
