// skills.sh's search, over a fake network: the request it makes, how its answer is read, and how a failure is reported
// (the `skill_search` tool through a real Harness).
// @effect-diagnostics asyncFunction:off preferEffectArray:off strictEffectProvide:off schemaSync:off preferSchemaOverJson:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MAX_LIMIT, queryProblem, readSkillSearch, skillSearchUrl } from "./skill-search.ts";
import { SkillSearchTools } from "./skill-search-tool.ts";
import { answer, callTool } from "./web/harness.fixture.ts";
import { WebToolError } from "./web/errors.ts";
import { fakeTransport, ok } from "./web/web.fixture.ts";
import type { WebRequest } from "./web/transport.ts";

const FOUND = {
  query: "grill",
  searchType: "fuzzy",
  skills: [
    {
      id: "mattpocock/skills/grill-me",
      source: "mattpocock/skills",
      skillId: "grill-me",
      name: "grill-me",
      installs: 1446664,
    },
    {
      id: "mattpocock/skills/grilling",
      source: "mattpocock/skills",
      skillId: "grilling",
      name: "grilling",
      installs: 1,
    },
    { id: "broken", source: 3 },
  ],
  count: 3,
};

const json = (body: Schema.Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("skillSearchUrl and queryProblem", () => {
  it("asks /api/search with the query and a limit that is at most 20", () => {
    expect(skillSearchUrl("grill me", 5)).toBe("https://skills.sh/api/search?q=grill+me&limit=5");
    expect(skillSearchUrl("x&y=1")).toBe("https://skills.sh/api/search?q=x%26y%3D1&limit=10");
    expect(skillSearchUrl("grill", 500)).toContain(`limit=${MAX_LIMIT}`);
  });

  it("refuses a query skills.sh would, before asking", () => {
    expect(queryProblem("a")).toContain("at least 2");
    expect(queryProblem("  a ")).toContain("at least 2");
    expect(queryProblem("ab")).toBeUndefined();
    expect(queryProblem("x".repeat(201))).toContain("at most 200");
  });
});

describe("readSkillSearch", () => {
  it("reads the Skills, leaving out an entry that is not one", async () => {
    const read = await readSkillSearch(json(FOUND));

    expect(read).toEqual({
      ok: true,
      results: [FOUND.skills[0], FOUND.skills[1]],
      listed: FOUND.skills.length,
    });
  });

  it("reads an empty list", async () => {
    expect(await readSkillSearch(json({ skills: [] }))).toEqual({
      ok: true,
      results: [],
      listed: 0,
    });
  });

  it("reports skills.sh's own error, an unexpected status and an answer of another shape", async () => {
    expect(
      await readSkillSearch(json({ error: "Query must be at least 2 characters" }, 400)),
    ).toEqual({
      ok: false,
      message: "skills.sh answered 400: Query must be at least 2 characters",
    });

    expect(await readSkillSearch(new Response("oops", { status: 503 }))).toEqual({
      ok: false,
      message: "skills.sh answered 503",
    });

    const odd = await readSkillSearch(json({ results: [] }));

    expect(odd.ok).toBe(false);

    if (!odd.ok) expect(odd.message).toContain("not a list of Skills");

    const notJson = await readSkillSearch(ok("<html>"));

    expect(notJson.ok).toBe(false);
  });
});

/** A Harness with `skill_search` over a fake network, and a scripted model. */
const open = async (answerRequest: (request: WebRequest) => Response | WebToolError) => {
  const transport = fakeTransport(answerRequest);
  const extension = await Effect.runPromise(SkillSearchTools.pipe(Effect.provide(transport.layer)));
  const faux = fauxProvider();
  const models = createModels();
  const registry = createRegistry();

  models.setProvider(faux.provider);
  registry.install(extension);

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });

  const call = async (args: { query: string; limit?: number }) => {
    faux.setResponses([() => callTool("skill_search", args), () => answer("done")]);
    await (
      await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT)
    ).wait(BACKGROUND_CONTEXT);

    const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    const entry = Arr.findFirst(page.items, (item) => ToolResultEntry.is(item));
    const message = Option.getOrUndefined(entry)?.model?.[0];

    return {
      text:
        message?.role === "toolResult"
          ? Arr.join(
              Arr.map(message.content, (block) => (block.type === "text" ? block.text : "")),
              "",
            )
          : "",
      isError: message?.role === "toolResult" && message.isError,
    };
  };

  return { call, sent: transport.requests };
};

describe("skill_search", () => {
  it("returns each Skill's ID, source and install count, and records nothing", async () => {
    const search = await open(() => json(FOUND));
    const result = await search.call({ query: "grill", limit: 3 });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "mattpocock/skills/grill-me: source mattpocock/skills, 1446664 installs",
    );
    expect(result.text).toContain(
      "mattpocock/skills/grilling: source mattpocock/skills, 1 install\n",
    );
    expect(result.text).toContain("environment_skill_install");
    expect(search.sent).toHaveLength(1);
    expect(search.sent[0]?.url).toBe("https://skills.sh/api/search?q=grill&limit=3");
  });

  it("says when nothing matched", async () => {
    const search = await open(() => json({ skills: [] }));
    const result = await search.call({ query: "zzzzqq" });

    expect(result.isError).toBe(false);
    expect(result.text).toBe("skills.sh found no Skill for \u201czzzzqq\u201d.");
  });

  it("reports a failure plainly, as the tool's error: unreachable, an error status, a changed answer", async () => {
    const unreachable = await open(() => WebToolError.make({ message: "network error" }));
    const down = await unreachable.call({ query: "grill" });

    expect(down.isError).toBe(true);
    expect(down.text).toBe(
      "Could not search skills.sh: skills.sh could not be reached (network error)",
    );

    const refused = await open(() => json({ error: "Query must be at least 2 characters" }, 400));

    expect((await refused.call({ query: "grill" })).text).toBe(
      "Could not search skills.sh: skills.sh answered 400: Query must be at least 2 characters",
    );

    const changed = await open(() => json({ results: [] }));
    const odd = await changed.call({ query: "grill" });

    expect(odd.isError).toBe(true);
    expect(odd.text).toContain("not a list of Skills");
  });

  it("refuses a query that is too short without asking skills.sh", async () => {
    const search = await open(() => json(FOUND));
    const result = await search.call({ query: "g" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("at least 2 characters");
    expect(search.sent).toHaveLength(0);
  });
});
