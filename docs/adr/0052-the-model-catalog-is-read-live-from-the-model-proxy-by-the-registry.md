---
status: accepted
---

# The Model catalog is read live from the model proxy, by the Registry

cloudpid offered four models, hardcoded as `SUPPORTED_MODELS` in `packages/config`, while the model proxy (Commissary) serves over a hundred and adds new ones (`claude-fable-5-2`) without telling anyone. Every new model meant a release. The model list is now the **Model catalog**: what the proxy lists at `GET /v1/models`, read live.

- **The Registry is the only reader.** The Registry DO reads the proxy's list (5 s timeout, `limit=1000`, following `after_id` pages) and keeps it as a document (`model-catalog`) in its `documents` table, with when it read it (`fetchedAt`). It reads it again when the copy is older than 15 minutes, at the next call that needs it: a Session's `sessionSettings` (answered at once with the copy, the read running detached), and `getModelCatalog` and every write that can name a model (Settings, Overrides, Agent changes of the Settings, Triggers), which wait for it. A read that fails keeps the copy, stale, and is not tried again for 60 s. Before any read has ever succeeded, the catalog is a built-in fallback of the four models (`FALLBACK_CATALOG`, `fetchedAt: null`). Without the proxy's secrets (tests), it stays the fallback.
- **Sessions keep their own copy.** The catalog comes with the Settings' source (`sessionSettings`), and the Session keeps it with them (`settings-source`), so it runs on the catalog it last read while the Registry is down.
- **Every model is a pi-ai `anthropic` model, `anthropic/<id>`.** The proxy serves all of them through the Anthropic Messages API, other vendors' models under an alias it gives them (`claude-fable-5-dd-5-tpg` is GPT-5). A model's metadata (`session/models.ts` → `catalogModels`) is pi-ai's entry when pi-ai's catalog has the id, with the proxy's display name, output limit and window (still capped at 400k for the four `models.json` caps); for an id that is exactly a Claude family and version (`^claude-(fable|opus|sonnet|haiku)-\d+(-\d+)?$`) that pi-ai lacks, the newest model of that family pi-ai has (`claude-fable-5-2` takes `claude-fable-5-1`'s price, thinking levels and cap); otherwise a generic model: reasoning on, text input, and **zero cost**.
- **A model's id is checked for its format only** (`ModelId`: `provider/id`). Whether the proxy serves it is checked against the catalog where a model is written (`settings_model_set`, `settings_role_set`, the Settings page, a pick, a Trigger, `session_start`): one it does not list is refused, naming `models_list`. A model already saved at a field is not checked again when another field is written. Reads stay lenient: a saved model the catalog no longer lists is left out, as a dropped setting always was (the default applies, and the Settings page shows the problem); a Trigger's model it no longer lists is ignored when the Trigger fires.
- **The fallback drops nothing.** While the catalog is the fallback, which says nothing of what the proxy serves, every well-formed saved model is kept, and the Session's copy also lists the models its Settings run (with the limits of an unknown model, 200k and 32k) so it can run them. Writes are still checked against the fallback, so before the first read only its four models can be written. A Session's pick is the exception: one its catalog does not list is ignored even under the fallback, since the Session could not run it and losing it costs only the pick.
- **No tool's description lists the models.** The `settings_*` and Trigger tools say "any id `models_list` lists" and their schemas take a string; the new `models_list` tool (deferred, read-only, with a `query` to narrow the list) lists the catalog's models with their names, servers and windows. A changed catalog changes no tool definition, so the provider's prompt cache holds. The MCP endpoint does not get `models_list`: its `environments_list` already answers the catalog's ids as `models.available`.
- **The web app's pickers** (the Session's model picker, `/model`, the Settings page's model selects, a Trigger's) list the catalog by display name, grouped by who serves each model (`owned_by`), and still show a value the catalog does not list, in a group of its own.

## Considered options

- **Keep the list hardcoded and release for each model:** the problem this fixes.
- **Each Session reads the proxy itself:** many readers of one list, each with its own failures, and a Session's writes would be checked against a different catalog than the Registry's.
- **A table of its own for the catalog:** a document needs no migration, and the catalog is read and written whole.
- **Refuse a saved model under the fallback too:** a Registry that has never reached the proxy would silently reset every Environment's model to the default.
- **List the models in each tool's description:** over a hundred ids, and the description would change, breaking the prompt cache, whenever the proxy added one.

## Consequences

- A model the proxy serves can be picked as soon as the Registry next reads the list (within 15 minutes), with no release.
- **The spend limit does not count a generic model.** Its cost is zero because cloudpid knows no price for it, so a Session that runs one is never stopped by its spend limit, and its Usage shows no cost. A Claude model pi-ai knows, or one templated from its family, is priced as before.
- A model's metadata guessed from its family or generic may be wrong (thinking levels, window). The proxy decides at the request: a model it lists but refuses fails the request with the proxy's error.
- The live list check is `apps/server/src/registry/model-catalog-live.test.ts`, which runs only with `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` set ([`docs/development/testing.md`](../development/testing.md)).
