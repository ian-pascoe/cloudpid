// One tool result's images held to a total, so several bounded images still fit the result's one SQLite row: the
// images are kept in order until the budget is spent, and the rest become notes saying why they were left out.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { boundImages, MAX_RESULT_IMAGE_CHARACTERS, ResultImages } from "./images.ts";

const image = (characters: number) => ({
  type: "image" as const,
  data: "A".repeat(characters),
  mimeType: "image/png",
});

const LEFT_OUT =
  "[An image (image/png, about 450 KB) was left out: one tool result holds at most 1,500,000 base64 characters of images. Show fewer images at once.]";

describe("boundImages", () => {
  it("keeps a result whose images fit as it is", () => {
    const items = [{ type: "text" as const, text: "two" }, image(700_000), image(700_000)];

    expect(boundImages(items)).toBe(items);
  });

  it("keeps the images in order until the budget is spent, and notes the rest", () => {
    const items = [
      image(600_000),
      { type: "text" as const, text: "between" },
      image(600_000),
      image(600_000),
      image(10),
    ];

    expect(MAX_RESULT_IMAGE_CHARACTERS).toBe(1_500_000);
    expect(boundImages(items)).toEqual([
      items[0],
      items[1],
      items[2],
      { type: "text", text: LEFT_OUT },
      {
        type: "text",
        text: "[An image (image/png, about 0 KB) was left out: one tool result holds at most 1,500,000 base64 characters of images. Show fewer images at once.]",
      },
    ]);
  });
});

describe("ResultImages", () => {
  it("holds every stored tool result's images to the budget", async () => {
    const shots = defineTool({
      name: "shots",
      description: "Three screenshots",
      parameters: Type.Object({}),
      execute: async () => ({ output: [image(600_000), image(600_000), image(600_000)] }),
    });

    const faux = fauxProvider();
    const models = createModels();
    const registry = createRegistry();

    models.setProvider(faux.provider);
    registry.install(defineExtension({ name: "shots", tools: [shots] }));
    registry.install(ResultImages);
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("shots", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done"),
    ]);

    const context = BACKGROUND_CONTEXT;
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);

    const root = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });

    await (await root.submit({ type: "input", content: "go" }, context)).wait(context);

    const page = await root.entries({}, 50, undefined, context);
    const message = page.items.find((item) => ToolResultEntry.is(item))?.model?.[0];
    const content = message?.role === "toolResult" ? message.content : [];

    expect(
      content.map((block) => (block.type === "image" ? block.data.length : block.text)),
    ).toEqual([600_000, 600_000, LEFT_OUT]);
  });
});
