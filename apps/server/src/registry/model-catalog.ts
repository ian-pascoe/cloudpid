// The Model catalog as the Registry keeps it (`docs/architecture/overview.md` → Models, ADR-0051): the models the model proxy
// (Commissary) lists at `GET /v1/models`, read by the Registry alone, kept in its document table (`model-catalog`) and
// read again once older than `CATALOG_TTL_MS`. A read that fails keeps the copy it has (stale), and before the first
// read that succeeds the catalog is the built-in fallback (`FALLBACK_CATALOG`). Sessions are handed it with their
// settings source (`sessionSettings`), and clients read it with `getModelCatalog`.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- store operations and a fetch, not combinators.
import {
  type CatalogModel,
  FALLBACK_CATALOG,
  isModelId,
  ModelCatalog,
  UNKNOWN_MODEL_LIMITS,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { DocumentStore } from "./settings.ts";

/** The document the catalog is kept in. */
export const MODEL_CATALOG_DOCUMENT = "model-catalog";

/** How old the kept catalog may be before a read of the Registry reads the proxy's again. */
export const CATALOG_TTL_MS = 15 * 60 * 1000;

/** How long after a failed read of the proxy's catalog none is tried again: a proxy that is down costs one timeout. */
export const CATALOG_RETRY_MS = 60 * 1000;

/** How long one read of the proxy's catalog may take. */
export const CATALOG_FETCH_TIMEOUT_MS = 5_000;

/** Pages of the proxy's list read at most: it answers every model on one today (`has_more: false`). */
const MAX_PAGES = 10;

/** One model of the proxy's list: the Anthropic Models API's shape, every field but the id optional. */
const CommissaryModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  owned_by: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  max_input_tokens: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
  max_tokens: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
});

/** One page of the proxy's list. */
const CommissaryPage = Schema.Struct({
  data: Schema.Array(CommissaryModel),
  has_more: Schema.Boolean.pipe(Schema.NullOr, Schema.optionalKey),
  last_id: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
});

const decodePage = Schema.decodeUnknownResult(Schema.fromJsonString(CommissaryPage));

/**
 * The catalog's models of one page of the proxy's list. Every model the proxy lists is served through the Anthropic
 * Messages API, so each is `anthropic/<id>` (a non-Claude model too, under the alias the proxy gives it).
 */
export const commissaryModels = (page: typeof CommissaryPage.Type): ReadonlyArray<CatalogModel> =>
  Arr.flatMap(page.data, (model) => {
    const id = `anthropic/${model.id}`;

    return isModelId(id)
      ? [
          {
            id,
            name: model.display_name ?? model.id,
            ownedBy: model.owned_by ?? "anthropic",
            // What a model the proxy lists without its limits is taken to have.
            contextWindow: model.max_input_tokens ?? UNKNOWN_MODEL_LIMITS.contextWindow,
            maxTokens: model.max_tokens ?? UNKNOWN_MODEL_LIMITS.maxTokens,
          },
        ]
      : [];
  });

/** One page of the proxy's list from the JSON text it answered, or why it is not one. */
export const parseCommissaryPage = (
  body: string,
):
  | { readonly models: ReadonlyArray<CatalogModel>; readonly next: string | undefined }
  | { readonly problem: string } => {
  const decoded = decodePage(body);

  if (Result.isFailure(decoded)) {
    return {
      problem: `The model proxy's list of models is not what it should be: ${String(decoded.failure)}`,
    };
  }

  const page = decoded.success;

  return {
    models: commissaryModels(page),
    next: page.has_more === true ? (page.last_id ?? undefined) : undefined,
  };
};

/** The model proxy, as the catalog is read from it. */
export type CatalogProxy = { readonly url: string; readonly apiKey: string };

/** Read every model the proxy lists, a page at a time, or throw an `Error` that says why not. */
export const fetchCommissaryCatalog = async (
  proxy: CatalogProxy,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<ReadonlyArray<CatalogModel>> => {
  const base = proxy.url.replace(/\/+$/, "");
  const models: CatalogModel[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${base}/v1/models`);

    url.searchParams.set("limit", "1000");

    if (after !== undefined) url.searchParams.set("after_id", after);

    const response = await fetcher(url, {
      headers: { "x-api-key": proxy.apiKey, "anthropic-version": "2023-06-01" },
      signal,
    });

    if (!response.ok) {
      throw new Error(`The model proxy answered ${response.status} to its list of models`);
    }

    const parsed = parseCommissaryPage(await response.text());

    if ("problem" in parsed) throw new Error(parsed.problem);

    models.push(...parsed.models);

    if (parsed.next === undefined) break;

    after = parsed.next;
  }

  if (models.length === 0) throw new Error("The model proxy listed no models");

  return Arr.dedupeWith(models, (a, b) => a.id === b.id);
};

const parseCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ModelCatalog));

/** The catalog kept in `documents`, or the fallback before the proxy's was ever read. */
export const readModelCatalog = (documents: Pick<DocumentStore, "getDocument">): ModelCatalog => {
  const body = documents.getDocument(MODEL_CATALOG_DOCUMENT);

  return body === null
    ? FALLBACK_CATALOG
    : Option.getOrElse(parseCatalog(body), () => FALLBACK_CATALOG);
};

/** What a refresh of the catalog came to. */
export type CatalogRefresh =
  | { readonly status: "fresh" }
  | { readonly status: "fetched"; readonly models: number }
  | { readonly status: "failed"; readonly message: string };

/** The Registry's keeper of the catalog. */
export type ModelCatalogKeeper = {
  /** The catalog as kept: the fallback before the proxy's was ever read. */
  readonly current: () => ModelCatalog;
  /**
   * Read the proxy's catalog again when the kept one is older than `CATALOG_TTL_MS` (or there is none), unless a read
   * failed within `CATALOG_RETRY_MS`. One read at a time: a second call joins it. Never rejects; a read that fails keeps
   * the catalog as it was.
   */
  readonly refresh: () => Promise<CatalogRefresh>;
};

/**
 * The catalog over `documents`, read from `proxy` (none: the fallback is all there is, as in tests) through `fetcher`, at
 * the times `now` tells.
 */
export const modelCatalogKeeper = (options: {
  readonly documents: DocumentStore;
  readonly proxy: CatalogProxy | undefined;
  readonly fetcher?: typeof fetch;
  readonly now: () => number;
  readonly timeoutMs?: number;
}): ModelCatalogKeeper => {
  const { documents, proxy, now } = options;
  let failedAt: number | undefined;
  let inFlight: Promise<CatalogRefresh> | undefined;

  const current = () => readModelCatalog(documents);

  const due = (): boolean => {
    const at = now();
    const { fetchedAt } = current();

    if (failedAt !== undefined && at - failedAt < CATALOG_RETRY_MS) return false;

    return fetchedAt === null || at - fetchedAt >= CATALOG_TTL_MS;
  };

  const read = async (target: CatalogProxy): Promise<CatalogRefresh> => {
    try {
      const models = await fetchCommissaryCatalog(
        target,
        options.fetcher ?? fetch,
        AbortSignal.timeout(options.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS),
      );

      const at = now();

      documents.putDocument(
        MODEL_CATALOG_DOCUMENT,
        JSON.stringify({ models, fetchedAt: at } satisfies ModelCatalog),
        at,
      );
      failedAt = undefined;

      return { status: "fetched", models: models.length };
    } catch (error) {
      failedAt = now();

      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const refresh = (): Promise<CatalogRefresh> => {
    if (inFlight !== undefined) return inFlight;

    if (proxy === undefined || !due()) return Promise.resolve({ status: "fresh" });

    inFlight = read(proxy).finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  };

  return { current, refresh };
};
