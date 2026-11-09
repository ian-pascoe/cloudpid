// `models_list` (`docs/architecture/overview.md` → Models, ADR-0051): the Model catalog for the agent, the models the model
// proxy serves, which `settings_model_set`, `settings_role_set` and the Trigger tools take. The catalog changes without a
// release and holds over a hundred models, so no tool's description lists them (a description must stay as it is, for
// the prompt cache): the agent reads them here, narrowed by `query`. It is not offered by default; the agent loads it
// with `tool_search` when it changes a model.
// @effect-diagnostics missingPipeableSignature:off globalDate:off -- plain functions; a catalog's time is shown as ISO.
import type { CatalogModel, ModelCatalog } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MODELS_LIST_NAME = "models_list";

export const MODELS_LIST_DESCRIPTION =
  "List the models the model proxy serves, which settings_model_set, settings_role_set and the trigger tools take, by id (provider/id): each with its display name, who serves it (owned_by) and its context window. Give query to keep the models whose id, name or owned_by holds it (case-insensitive), such as fable or opencode. Models that are not Claude are served under an alias id the proxy gives them (GPT-5 is anthropic/claude-fable-5-dd-5-tpg): use the id as listed. A model that is listed may still be refused by the proxy when its request is made.";

export const ModelsListInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description: "Keep the models whose id, name or owned_by holds this text (case-insensitive)",
    }),
  ),
});

const ListedModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owned_by: Schema.String,
  context_window: Schema.Finite,
  max_tokens: Schema.Finite,
});

export const ModelsListOutput = Schema.Struct({
  models: Schema.Array(ListedModel),
  /** How many the catalog holds, before `query`. */
  total: Schema.Finite,
  /** When the Registry read the catalog from the proxy (ISO), or null for the built-in fallback. */
  fetched_at: Schema.NullOr(Schema.String),
});

export type ModelsListOutput = typeof ModelsListOutput.Type;

/** Whether `model` holds `query`, in its id, name or who serves it. */
const holds = (model: CatalogModel, query: string): boolean => {
  const wanted = query.toLowerCase();

  return Arr.some([model.id, model.name, model.ownedBy], (text) =>
    text.toLowerCase().includes(wanted),
  );
};

/** What `models_list` answers: its text, and its value for programs. */
export type ModelsListAnswer = { readonly text: string; readonly structured: ModelsListOutput };

/** `catalog` as `models_list` answers it, narrowed by `query`. */
export const modelsListAnswer = (
  catalog: ModelCatalog,
  query: string | undefined,
): ModelsListAnswer => {
  const trimmed = query?.trim() ?? "";

  const kept =
    trimmed === "" ? catalog.models : Arr.filter(catalog.models, (model) => holds(model, trimmed));

  const lines = Arr.map(
    kept,
    (model) =>
      `${model.id}: ${model.name} (${model.ownedBy}, ${model.contextWindow.toLocaleString("en-US")} tokens)`,
  );

  const head =
    catalog.fetchedAt === null
      ? "The model proxy's catalog has not been read yet: these are the built-in models."
      : `${String(catalog.models.length)} models the model proxy serves${trimmed === "" ? "" : `, ${String(kept.length)} holding "${trimmed}"`}:`;

  return {
    text:
      kept.length === 0
        ? `${head}\nNo model holds "${trimmed}".`
        : Arr.join([head, ...lines], "\n"),
    structured: {
      models: Arr.map(kept, (model) => ({
        id: model.id,
        name: model.name,
        owned_by: model.ownedBy,
        context_window: model.contextWindow,
        max_tokens: model.maxTokens,
      })),
      total: catalog.models.length,
      fetched_at: catalog.fetchedAt === null ? null : new Date(catalog.fetchedAt).toISOString(),
    },
  };
};

/** `modelsListAnswer` over a catalog read now. */
export const modelsList =
  <E>(catalog: Effect.Effect<ModelCatalog, E>) =>
  (args: typeof ModelsListInput.Type) =>
    Effect.map(catalog, (read) => modelsListAnswer(read, args.query));
