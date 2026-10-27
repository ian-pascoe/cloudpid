// @effect-diagnostics asyncFunction:off -- the tests await promises, as the other test files do.
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Context,
  type Models,
} from "@earendil-works/pi-ai";
import { type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import {
  EXCHANGE_LIMIT,
  firstExchange,
  generateTitle,
  MAX_GENERATED_TITLE_LENGTH,
  sanitizeTitle,
  TITLE_ATTEMPTS,
  titleRequest,
  titleTask,
} from "./titles.ts";
import { ReportError, type SessionRegistry } from "./status.ts";

const SMALL = { provider: "anthropic", modelId: "claude-haiku-5-5" };

/** A model catalog whose only model replies with the next of `replies`, remembering the requests it got. */
const fauxModels = (replies: ReadonlyArray<string | Error>) => {
  const requests: Context[] = [];
  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-5-5" }] });
  let next = 0;

  faux.setResponses(
    Array.from({ length: 12 }, () => (request) => {
      requests.push(request);

      const reply = replies[next++] ?? "unscripted";

      return reply instanceof Error
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: reply.message })
        : fauxAssistantMessage(reply);
    }),
  );

  const models = createModels();

  models.setProvider(faux.provider);

  return { models, requests };
};

const entry = (id: number, message: NonNullable<EntryRecord["model"]>[number]): EntryRecord => ({
  // SAFETY: the ids are opaque to the code under test; plain numbers stand in for the Harness's branded ones.
  id: id as never,
  conversationId: ROOT_CONVERSATION_ID,
  kind: "message",
  model: [message],
});

const user = (id: number, content: string) => entry(id, { role: "user", content, timestamp: id });

const assistant = (id: number, text: string, stopReason: "stop" | "toolUse" = "stop") =>
  entry(id, {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: id,
  });

describe("sanitizeTitle", () => {
  it("strips quotes, a Title: label, markdown and ending punctuation", () => {
    expect(sanitizeTitle('"Fix the login redirect bug."')).toBe("Fix the login redirect bug");
    expect(sanitizeTitle("Title: Fix the build")).toBe("Fix the build");
    expect(sanitizeTitle("**Title:** `Refactor the Registry`!")).toBe("Refactor the Registry");
    expect(sanitizeTitle("# Add dark mode…")).toBe("Add dark mode");
    expect(sanitizeTitle("“Plan the migration”")).toBe("Plan the migration");
  });

  it("drops zero-width and bidi override characters and turns other controls into spaces", () => {
    expect(sanitizeTitle("Fix\u200B the\u202E build\u0007now\u0085ok")).toBe(
      "Fix the build now ok",
    );
    expect(sanitizeTitle("\u200B\u202E\u0007")).toBeUndefined();
  });

  it("keeps punctuation inside the title", () => {
    expect(sanitizeTitle("Fix foo() in don't-panic mode")).toBe("Fix foo() in don't-panic mode");
  });

  it("takes the first line and collapses whitespace", () => {
    expect(sanitizeTitle("\n\n  Fix   the\tbuild  \nThis title names the work.\n")).toBe(
      "Fix the build",
    );
  });

  it("cuts a long reply at a word, within the cap", () => {
    const title = sanitizeTitle("word ".repeat(100));

    expect(title).toBeDefined();
    expect(title?.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
    expect(title?.endsWith("word")).toBe(true);
  });

  it("cuts one long word at the cap", () => {
    expect(sanitizeTitle("x".repeat(500))?.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
  });

  it("gives nothing for a reply with no words", () => {
    for (const reply of ["", "  \n ", '""', "...", "Title:", "* - *"]) {
      expect(sanitizeTitle(reply), JSON.stringify(reply)).toBeUndefined();
    }
  });
});

describe("firstExchange", () => {
  it("takes the first message and the first answer, skipping progress before a tool call", () => {
    expect(
      firstExchange([
        user(1, "Fix the login bug"),
        assistant(2, "Let me look.", "toolUse"),
        assistant(3, "Fixed it."),
        user(4, "Thanks, now the tests"),
        assistant(5, "Done."),
      ]),
    ).toEqual({ question: "Fix the login bug", answer: "Fixed it." });
  });

  it("has a message but no answer before the Run ends", () => {
    expect(firstExchange([user(1, "Hello"), assistant(2, "Looking", "toolUse")])).toEqual({
      question: "Hello",
      answer: undefined,
    });
  });

  it("takes what the owner typed of a message the Session expanded", () => {
    const expanded: EntryRecord = {
      ...user(1, '<skill name="review" location="/s/SKILL.md">\nBody\n</skill>\n\nthe diff'),
      kind: "cloudpid.user",
      data: {
        display: "/skill:review the diff",
        skills: [{ name: "review", location: "/s/SKILL.md" }],
      },
    };

    expect(firstExchange([expanded, assistant(2, "Reviewed.")])).toEqual({
      question: "/skill:review the diff",
      answer: "Reviewed.",
    });
  });

  it("has nothing before the first message", () => {
    expect(firstExchange([])).toBeUndefined();
  });
});

describe("titleRequest", () => {
  it("shows the model the first message and answer, each cut to the limit", () => {
    const request = titleRequest(
      { question: "q".repeat(EXCHANGE_LIMIT * 3), answer: "a".repeat(EXCHANGE_LIMIT * 3) },
      1,
    );

    const [message] = request.messages;

    const content =
      message?.role === "user" && Predicate.isString(message.content) ? message.content : "";

    expect(content).toContain("<first_message>");
    expect(content).toContain("<first_answer>");
    expect(content.length).toBeLessThan(EXCHANGE_LIMIT * 2 + 1_000);
    expect(request.systemPrompt).toContain("3 to 6 words");
  });

  it("leaves out the answer when there is none", () => {
    const [message] = titleRequest({ question: "Hi", answer: undefined }, 1).messages;

    expect(message?.role === "user" ? message.content : "").not.toContain("<first_answer>");
  });
});

describe("generateTitle", () => {
  it("asks the model and sanitizes its reply", async () => {
    const { models, requests } = fauxModels(['"Fix the login bug."']);

    const title = await Effect.runPromise(
      generateTitle(models, SMALL, { question: "login is broken", answer: "fixed" }),
    );

    expect(title).toBe("Fix the login bug");
    expect(requests).toHaveLength(1);
  });

  it("fails on a model error, an unknown model and an empty reply", async () => {
    const { models } = fauxModels([new Error("overloaded"), "..."]);
    const exchange = { question: "q", answer: undefined };

    await expect(Effect.runPromise(generateTitle(models, SMALL, exchange))).rejects.toThrow(
      /overloaded/,
    );
    await expect(Effect.runPromise(generateTitle(models, SMALL, exchange))).rejects.toThrow(
      /no title/,
    );
    await expect(
      Effect.runPromise(
        generateTitle(models, { provider: "anthropic", modelId: "nope" }, exchange),
      ),
    ).rejects.toThrow(/not available/);
  });
});

/** A task over in-memory storage and a fake Registry that records what it was offered. */
const task = (options: {
  readonly models: Models;
  readonly exchange?: { question: string; answer: string | undefined } | undefined;
  readonly wanted?: () => boolean;
  readonly registryFails?: boolean;
}) => {
  const store = new Map<string, unknown>();
  const offered: string[] = [];
  let asked = 0;

  const registry: SessionRegistry["Service"] = {
    report: () => Effect.void,
    reportAgents: () => Effect.void,
    notify: () => Effect.void,
    titleWanted: Effect.suspend(() => {
      asked += 1;

      return options.registryFails === true
        ? Effect.fail(ReportError.make({ message: "Registry is down" }))
        : Effect.succeed(options.wanted?.() ?? true);
    }),
    setTitle: (title) =>
      Effect.sync(() => {
        offered.push(title);
      }),
  };

  const built = titleTask({
    kv: {
      // SAFETY: the task reads back what it put under each key.
      get: <T>(key: string) => store.get(key) as T | undefined,
      put: <T>(key: string, value: T) => {
        store.set(key, value);
      },
    },
    models: options.models,
    model: () => SMALL,
    registry,
    exchange: Effect.succeed(
      "exchange" in options ? options.exchange : { question: "login is broken", answer: "fixed" },
    ),
  });

  return { ...built, offered, asked: () => asked };
};

describe("the title task", () => {
  it("names the Session once, however often it runs", async () => {
    const { models, requests } = fauxModels(["Fix the login bug", "Another title"]);
    const named = task({ models });

    await Effect.runPromise(named.run);
    await Effect.runPromise(named.run);

    expect(named.offered).toEqual(["Fix the login bug"]);
    expect(requests).toHaveLength(1);
    expect(named.done()).toBe(true);
  });

  it("runs calls that overlap as one", async () => {
    const { models, requests } = fauxModels(["Fix the login bug", "Another title"]);
    const named = task({ models });

    await Effect.runPromise(Effect.all([named.run, named.run, named.run], { concurrency: 3 }));

    expect(named.offered).toEqual(["Fix the login bug"]);
    expect(requests).toHaveLength(1);
  });

  it("waits for an answer to name the Session by", async () => {
    const { models, requests } = fauxModels(["Never used"]);
    const named = task({ models, exchange: undefined });

    await Effect.runPromise(named.run);

    expect(requests).toHaveLength(0);
    expect(named.asked()).toBe(0);
    expect(named.done()).toBe(false);
  });

  it("does not ask the model when the owner has named the Session, and never looks again", async () => {
    const { models, requests } = fauxModels(["Never used"]);
    const named = task({ models, wanted: () => false });

    await Effect.runPromise(named.run);
    await Effect.runPromise(named.run);

    expect(requests).toHaveLength(0);
    expect(named.offered).toEqual([]);
    expect(named.asked()).toBe(1);
    expect(named.done()).toBe(true);
  });

  it("tries again at the next answer after the model failed", async () => {
    const { models, requests } = fauxModels([new Error("overloaded"), "Fix the login bug"]);
    const named = task({ models });

    await Effect.runPromise(named.run);
    expect(named.offered).toEqual([]);
    expect(named.done()).toBe(false);

    await Effect.runPromise(named.run);
    expect(named.offered).toEqual(["Fix the login bug"]);
    expect(requests).toHaveLength(2);
  });

  it("tries again when the Registry could not be reached", async () => {
    const { models } = fauxModels(["Fix the login bug"]);
    const named = task({ models, registryFails: true });

    await Effect.runPromise(named.run);

    expect(named.offered).toEqual([]);
    expect(named.done()).toBe(false);
  });

  it("gives up after too many failures", async () => {
    const { models, requests } = fauxModels(
      Array.from({ length: 12 }, () => new Error("overloaded")),
    );

    const named = task({ models });

    for (let round = 0; round < TITLE_ATTEMPTS + 3; round++) await Effect.runPromise(named.run);

    expect(requests).toHaveLength(TITLE_ATTEMPTS);
    expect(named.done()).toBe(true);
  });
});
