// The Harness and pi-ai's faux provider are Promise code.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";
import { pricedModels } from "./priced.fixture.ts";
import {
  addTotals,
  limitingModels,
  NO_TOTALS,
  recordSamplingUsage,
  recordUnledgeredUsage,
  samplingTotals,
  sessionTotals,
  spendMessage,
  unledgeredTotals,
  totalsOf,
  usageMessage,
} from "./spend.ts";
import { obj } from "@earendil-works/pi-schema";

const context = BACKGROUND_CONTEXT;

/** What every answered request costs, in US dollars. */
const REQUEST_COST = 0.5;

/** Faux models whose requests each cost `REQUEST_COST`. */
const fauxModels = () => {
  const faux = fauxProvider({ models: [{ id: "priced-1" }] });
  const base = createModels();

  base.setProvider(faux.provider);

  return { models: pricedModels(base, REQUEST_COST), faux };
};

const ask = (models: Models) =>
  models.completeSimple(models.getModel("faux", "priced-1")!, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  });

describe("the refusal message", () => {
  it("shows an amount under a cent with its first digit, so a small limit does not read as zero", () => {
    expect(spendMessage(0.0029, 0.002)).toContain("spent 0.003 US dollars of its 0.002 US dollars");
  });

  it("is never taken for a transient failure or a context overflow, whatever the amounts", () => {
    for (const [spent, limit] of [
      [5, 5],
      [500.5, 500],
      [1_503.2, 1_500],
      [0.52, 0.5],
    ] as const) {
      const message = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: spendMessage(spent, limit),
      });

      expect(isRetryableAssistantError(message)).toBe(false);
      expect(isContextOverflow(message, 200_000)).toBe(false);
    }
  });
});

describe("totalsOf", () => {
  it("adds every model's and every tool's usage", () => {
    const usage = (input: number, cost: number) => ({
      input,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: input + 9,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    });

    expect(
      totalsOf({
        models: { "anthropic/a": usage(10, 0.5), "anthropic/b": usage(20, 0.25) },
        tools: { codemode: usage(1, 0.125) },
      }),
    ).toEqual({ input: 31, output: 6, cacheRead: 9, cacheWrite: 12, totalTokens: 58, cost: 0.875 });
  });

  it("counts a field a provider did not report as nothing", () => {
    expect(addTotals(NO_TOTALS, { input: 5, cost: {} })).toEqual({ ...NO_TOTALS, input: 5 });
  });
});

describe("the usage of the Session's own model calls", () => {
  it("is kept in storage and adds up", () => {
    const store = new Map<string, unknown>();

    const kv = {
      // SAFETY: the test reads each key as the type it put there.
      get: <T>(key: string) => store.get(key) as T | undefined,
      put: <T>(key: string, value: T) => void store.set(key, value),
    };

    expect(unledgeredTotals(kv)).toEqual(NO_TOTALS);

    recordUnledgeredUsage(kv, { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } });
    recordUnledgeredUsage(kv, { input: 5, output: 1, totalTokens: 6, cost: { total: 0.02 } });

    expect(unledgeredTotals(kv)).toEqual({
      input: 15,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: 0.03,
    });
  });
});

describe("the usage of MCP servers' Sampling requests", () => {
  const memory = () => {
    const store = new Map<string, unknown>();

    return {
      // SAFETY: the test reads each key as the type it put there.
      get: <T>(key: string) => store.get(key) as T | undefined,
      put: <T>(key: string, value: T) => void store.set(key, value),
    };
  };

  it("is kept by conversation and server, adds up, and counts the requests", () => {
    const kv = memory();

    recordSamplingUsage(
      kv,
      { conversationId: 1, server: "a" },
      { input: 10, totalTokens: 10, cost: { total: 0.01 } },
    );
    recordSamplingUsage(
      kv,
      { conversationId: 1, server: "a" },
      { input: 5, totalTokens: 5, cost: { total: 0.02 } },
    );
    recordSamplingUsage(
      kv,
      { conversationId: 2, server: "b" },
      { output: 1, totalTokens: 1, cost: { total: 0.5 } },
    );

    expect(samplingTotals(kv)).toEqual({
      input: 15,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 16,
      cost: 0.53,
      requests: 3,
    });
    expect(kv.get<unknown[]>("mcp-sampling-usage")).toHaveLength(2);
  });

  it("is part of what the Session has spent, so the limit holds it", async () => {
    const kv = memory();

    recordSamplingUsage(
      kv,
      { conversationId: 1, server: "a" },
      { totalTokens: 3, cost: { total: 0.25 } },
    );
    recordUnledgeredUsage(kv, { cost: { total: 0.5 } });

    const ledger = { usage: () => Promise.resolve({ models: {}, tools: {} }) };

    expect((await sessionTotals(ledger, kv)).cost).toBeCloseTo(0.75);
    expect(await sessionTotals(ledger, kv)).not.toHaveProperty("requests");
  });

  it("is shown as its own part of the usage only once a request reached a model", () => {
    const kv = memory();

    expect(usageMessage(NO_TOTALS, null, null, null, samplingTotals(kv))).not.toHaveProperty(
      "sampling",
    );

    recordSamplingUsage(
      kv,
      { conversationId: 1, server: "a" },
      { totalTokens: 3, cost: { total: 0.25 } },
    );

    expect(usageMessage(NO_TOTALS, null, null, null, samplingTotals(kv)).sampling).toMatchObject({
      requests: 1,
      cost: 0.25,
    });
  });
});

describe("usageMessage", () => {
  it("carries the Containers' usage when known, apart from the models' cost", () => {
    const container = {
      instance: "cpu-2",
      runSeconds: 60,
      cpuSeconds: 5,
      egressBytes: 0,
      memory: 0.001,
      disk: 0,
      cpu: 0.0001,
      egress: 0,
      reportedThrough: null,
      asOf: 1,
      running: false,
      busy: false,
      rates: { memory: 0, disk: 0, cpu: 0 },
      until: null,
    } as const;

    expect(usageMessage({ ...NO_TOTALS, cost: 1 }, null, container)).toEqual({
      ...NO_TOTALS,
      cost: 1,
      limit: null,
      container,
    });
    expect(usageMessage(NO_TOTALS, null, null)).not.toHaveProperty("container");
  });
});

describe("limitingModels", () => {
  it("passes requests through while there is no limit, without reading what was spent", async () => {
    const { models, faux } = fauxModels();
    let reads = 0;

    const limited = limitingModels(models, {
      limit: () => null,
      spent: () => {
        reads += 1;

        return Promise.resolve(100);
      },
    });

    faux.setResponses([fauxAssistantMessage("hi")]);

    expect((await ask(limited)).stopReason).toBe("stop");
    expect(reads).toBe(0);
  });

  it("lets a request through under the limit", async () => {
    const { models, faux } = fauxModels();
    const limited = limitingModels(models, { limit: () => 5, spent: () => Promise.resolve(4.99) });

    faux.setResponses([fauxAssistantMessage("hi")]);

    expect((await ask(limited)).stopReason).toBe("stop");
    expect(faux.state.callCount).toBe(1);
  });

  it("refuses a request at the limit, as an error that costs nothing and never reaches the provider", async () => {
    const { models, faux } = fauxModels();
    const limited = limitingModels(models, { limit: () => 5, spent: () => Promise.resolve(5) });

    faux.setResponses([fauxAssistantMessage("never sent")]);

    const message = await ask(limited);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(spendMessage(5, 5));
    expect(message.usage.cost.total).toBe(0);
    expect(faux.state.callCount).toBe(0);
  });

  it("refuses the streaming calls the same way", async () => {
    const { models, faux } = fauxModels();
    const limited = limitingModels(models, { limit: () => 1, spent: () => Promise.resolve(2) });
    const events: string[] = [];

    faux.setResponses([fauxAssistantMessage("never sent")]);

    const stream = limited.streamSimple(limited.getModel("faux", "priced-1")!, {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });

    for await (const event of stream) events.push(event.type);

    expect(events).toEqual(["error"]);
    expect(faux.state.callCount).toBe(0);
  });

  it("lets a request through when what was spent cannot be read", async () => {
    const { models, faux } = fauxModels();

    for (const spent of [
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("the ledger is unreadable")),
    ]) {
      faux.setResponses([fauxAssistantMessage("hi")]);

      expect((await ask(limitingModels(models, { limit: () => 1, spent }))).stopReason).toBe(
        "stop",
      );
    }
  });

  it("tells the gate why it let a request through when what was spent could not be read", async () => {
    const { models, faux } = fauxModels();
    const failures: string[] = [];
    const broken = new Error("the ledger is unreadable");

    faux.setResponses([fauxAssistantMessage("hi")]);

    const limited = limitingModels(models, {
      limit: () => 1,
      spent: () => Promise.reject(broken),
      failed: (reason) => void failures.push(reason),
    });

    expect((await ask(limited)).stopReason).toBe("stop");
    expect(failures).toEqual([String(broken)]);
  });

  it("reads the limit at each request, so a change applies to the next", async () => {
    const { models, faux } = fauxModels();
    let limit: number | null = 1;
    const limited = limitingModels(models, { limit: () => limit, spent: () => Promise.resolve(3) });

    faux.setResponses([fauxAssistantMessage("hi")]);

    expect((await ask(limited)).stopReason).toBe("error");

    limit = 10;

    expect((await ask(limited)).stopReason).toBe("stop");

    limit = null;

    faux.setResponses([fauxAssistantMessage("hi")]);

    expect((await ask(limited)).stopReason).toBe("stop");
  });
});

describe("a Session over its limit", () => {
  const open = async (limit: number) => {
    const { models, faux } = fauxModels();
    const registry = createRegistry();
    const storage = new MemoryStorage();
    let harness: Harness | undefined;

    const look = defineTool({
      name: "look",
      description: "Look around",
      parameters: obj({}),
      execute: () => Promise.resolve({ output: [{ type: "text", text: "nothing" }] }),
    });

    registry.install(defineExtension({ name: "look", tools: [look] }));

    const limited = limitingModels(models, {
      limit: () => limit,
      spent: async () => totalsOf(await harness!.usage(context)).cost,
    });

    harness = await Harness.open(storage, { models: limited, registry }, context);

    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "priced-1" } },
    });

    return { faux, harness, root };
  };

  it("ends the Run unanswered with the budget message once a request has pushed the Session over", async () => {
    const { faux, harness, root } = await open(REQUEST_COST);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("look", {}, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("this answer is never sent"),
    ]);

    const settled = await (
      await root.submit({ type: "input", content: "look" }, context)
    ).wait(context);

    expect(settled.status).toBe("unanswered");

    if (settled.status !== "unanswered") return;

    expect(settled.reason).toBe("model_error");
    expect(settled.detail).toEqual(expect.stringContaining("out of budget"));

    // One request went out and was paid for; the second was refused, and cost nothing more.
    expect(faux.state.callCount).toBe(1);

    const spent = totalsOf(await harness.usage(context));

    expect(spent.cost).toBeGreaterThan(0);
    expect(spent.totalTokens).toBeGreaterThan(0);
  });

  it("answers as usual under the limit", async () => {
    const { faux, root } = await open(1_000_000);

    faux.setResponses([fauxAssistantMessage("fine")]);

    const settled = await (
      await root.submit({ type: "input", content: "hi" }, context)
    ).wait(context);

    expect(settled.status).toBe("done");
  });
});
