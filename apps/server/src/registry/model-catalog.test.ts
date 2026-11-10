// The Registry's keeper of the Model catalog (`docs/architecture/overview.md` → Models, ADR-0052): the proxy's list read
// into the catalog, again only once it is older than its TTL, the copy kept (stale) when a read fails, the fallback
// before any read succeeds, and one read for calls made at once.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { FALLBACK_CATALOG } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { COMMISSARY_MODELS_PAGE } from "./commissary-models.fixture.ts";
import {
  CATALOG_RETRY_MS,
  CATALOG_TTL_MS,
  modelCatalogKeeper,
  type ModelCatalogKeeper,
} from "./model-catalog.ts";

const PROXY = { url: "https://proxy.example.test/", apiKey: "test-key" };

/** A keeper over a document table in memory, reading the proxy through `answer`, at the time `clock.now` says. */
const keeperWith = (answer: (url: URL, init: RequestInit | undefined) => Promise<Response>) => {
  const documents = new Map<string, string>();
  const clock = { now: 1_000 };
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];

  const keeper: ModelCatalogKeeper = modelCatalogKeeper({
    documents: {
      getDocument: (name) => documents.get(name) ?? null,
      putDocument: (name, body) => {
        documents.set(name, body);
      },
    },
    proxy: PROXY,
    fetcher: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      requests.push({ url, init });

      return answer(url, init);
    },
    now: () => clock.now,
  });

  return { keeper, clock, requests };
};

const page = () => Promise.resolve(Response.json(COMMISSARY_MODELS_PAGE));

describe("the Model catalog the Registry keeps", () => {
  it("is the fallback until the proxy's list is read, then the proxy's", async () => {
    const { keeper, requests } = keeperWith(page);

    expect(keeper.current()).toEqual(FALLBACK_CATALOG);
    expect(await keeper.refresh()).toEqual({ status: "fetched", models: 10 });
    expect(keeper.current().fetchedAt).toBe(1_000);
    expect(keeper.current().models.map((model) => model.id)).toContain(
      "anthropic/claude-fable-5-2",
    );
    expect(
      keeper.current().models.find((model) => model.id === "anthropic/claude-fable-5-dd-5-tpg"),
    ).toEqual({
      id: "anthropic/claude-fable-5-dd-5-tpg",
      name: "GPT-5",
      ownedBy: "opencode",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });

    const [request] = requests;

    // The base URL's trailing slash is trimmed; the key goes as Anthropic's API takes it.
    expect(request?.url.pathname).toBe("/v1/models");
    expect(new Headers(request?.init?.headers).get("x-api-key")).toBe("test-key");
  });

  it("is read again only once it is older than its TTL", async () => {
    const { keeper, clock, requests } = keeperWith(page);

    await keeper.refresh();
    clock.now += CATALOG_TTL_MS - 1;

    expect(await keeper.refresh()).toEqual({ status: "fresh" });

    clock.now += 1;

    expect(await keeper.refresh()).toMatchObject({ status: "fetched" });
    expect(requests).toHaveLength(2);
  });

  it("keeps the copy it has when a read fails, and leaves the proxy alone a while after", async () => {
    let down = false;

    const { keeper, clock, requests } = keeperWith(() =>
      down ? Promise.resolve(new Response("bad gateway", { status: 502 })) : page(),
    );

    await keeper.refresh();

    const kept = keeper.current();

    down = true;
    clock.now += CATALOG_TTL_MS;

    const failed = await keeper.refresh();

    expect(failed.status).toBe("failed");
    // The proxy's status is in the message, for the log.
    expect(failed.status === "failed" && failed.message).toContain("502");
    expect(keeper.current()).toEqual(kept);

    clock.now += CATALOG_RETRY_MS - 1;

    expect(await keeper.refresh()).toEqual({ status: "fresh" });
    expect(requests).toHaveLength(2);
  });

  it("stays the fallback while the proxy has never answered, and makes one read of calls at once", async () => {
    const { keeper, requests } = keeperWith(() => Promise.reject(new Error("unreachable")));

    const [first, second] = await Promise.all([keeper.refresh(), keeper.refresh()]);

    expect(first).toMatchObject({ status: "failed" });
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
    expect(keeper.current()).toEqual(FALLBACK_CATALOG);
  });

  it("follows the list's pages, and refuses a list with no models", async () => {
    const { keeper, requests } = keeperWith((url) =>
      Promise.resolve(
        Response.json(
          url.searchParams.get("after_id") === null
            ? { data: [COMMISSARY_MODELS_PAGE.data[0]], has_more: true, last_id: "a" }
            : { data: [COMMISSARY_MODELS_PAGE.data[1]], has_more: false, last_id: "b" },
        ),
      ),
    );

    expect(await keeper.refresh()).toEqual({ status: "fetched", models: 2 });
    expect(requests[1]?.url.searchParams.get("after_id")).toBe("a");

    const empty = keeperWith(() => Promise.resolve(Response.json({ data: [], has_more: false })));

    expect(await empty.keeper.refresh()).toMatchObject({ status: "failed" });
    expect(empty.keeper.current()).toEqual(FALLBACK_CATALOG);
  });
});
