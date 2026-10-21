// The Harness and pi-ai's faux provider are Promise code.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { tracingModels } from "./models.ts";
import { tracingTools } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

const fauxModels = () => {
  const faux = fauxProvider();
  const models = createModels();

  models.setProvider(faux.provider);

  return { models, faux };
};

describe("tracingModels", () => {
  it("makes each request a pi.ai.request span with the response's usage, and returns the response as it is", async () => {
    const { models, faux } = fauxModels();
    const telemetry = new InMemoryTelemetryContext();

    faux.setResponses([fauxAssistantMessage("hello there", { responseId: "resp-1" })]);

    const traced = tracingModels(models, telemetry);
    const model = traced.getModel("faux", "faux-1")!;

    const message = await traced.completeSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { reasoning: "high" },
    );

    expect(message.content).toEqual([{ type: "text", text: "hello there" }]);

    // The span settles once the stream's callback returns, a moment after the caller has its result.
    await vi.waitFor(() => expect(telemetry.getSpans()[0]?.settled).toBe(true), { timeout: 5_000 });

    const [span, ...others] = telemetry.getSpans();

    expect(others).toEqual([]);
    expect(span).toMatchObject({
      name: "pi.ai.request",
      settled: true,
      attributes: {
        provider: "faux",
        model: "faux-1",
        reasoning: "high",
        stop: "stop",
        "usage.input": message.usage.input,
        "usage.output": message.usage.output,
        "cost.total": message.usage.cost.total,
        "response.id": "resp-1",
      },
    });
    expect(message.usage.output).toBeGreaterThan(0);
    expect(span!.events.map((event) => event.name)).toEqual(["pi.ai.first_chunk"]);
    expect(span!.status).toEqual({ status: "ok" });
  });

  it("marks a request the provider failed as an error, with how it failed and none of its text", async () => {
    const { models, faux } = fauxModels();
    const telemetry = new InMemoryTelemetryContext();

    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "messages.3.content: overloaded, try later",
      }),
    ]);

    const traced = tracingModels(models, telemetry);

    const message = await traced.completeSimple(traced.getModel("faux", "faux-1")!, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    });

    expect(message.stopReason).toBe("error");
    expect(telemetry.getSpans()[0]?.status).toEqual({
      status: "error",
      error: { name: "provider_error", message: "retryable" },
    });
    expect(JSON.stringify(telemetry.getSpans())).not.toContain("messages.3");
  });

  it("leaves the rest of the models object as it is", () => {
    const { models } = fauxModels();
    const traced = tracingModels(models, new InMemoryTelemetryContext());

    expect(traced.getModel("faux", "faux-1")).toBe(models.getModel("faux", "faux-1"));
  });
});

describe("tracingTools", () => {
  it("makes each tool call a span, under the tool's name, without its arguments or result", async () => {
    const { models, faux } = fauxModels();
    const telemetry = new InMemoryTelemetryContext();

    const roll = defineTool({
      name: "roll_die",
      description: "Roll a die",
      parameters: Type.Object({ secret: Type.String() }),
      execute: () => Promise.resolve({ output: [{ type: "text", text: "the die shows 4" }] }),
    });

    const registry = createRegistry();

    registry.install(defineExtension({ name: "dice", tools: [roll] }));
    registry.install(tracingTools(telemetry, [roll]));

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("roll_die", { secret: "hunter2" }, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });

    // The run is over once the root's submission settles.
    await (await root.submit({ type: "input", content: "roll" }, context)).wait(context);

    const spans = telemetry.getSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "pi.tool.roll_die",
      settled: true,
      attributes: { "tool.name": "roll_die", "tool.call_id": "call-1", "tool.is_error": false },
    });
    expect(JSON.stringify(spans)).not.toContain("hunter2");
    expect(JSON.stringify(spans)).not.toContain("the die shows");
  });
});
