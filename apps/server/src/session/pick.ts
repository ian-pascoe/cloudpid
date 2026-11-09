// @effect-diagnostics missingPipeableSignature:off -- plain functions over the pick, called directly.
// The model and thinking level a Session picked itself (`configure`), kept in its storage: the fields it leaves out
// follow the default in the settings.
import { catalogHas, formatModelId, type ModelCatalog } from "@cloudpid/config";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentChange, AgentState, ModelRef } from "@earendil-works/pi-durable";
import type * as Types from "effect/Types";
import type { SettingsKv } from "./settings.ts";

/** The model and thinking level a Session picked itself, in its storage. */
export type AgentPick = { readonly model?: ModelRef; readonly thinkingLevel?: ModelThinkingLevel };

/** Where the pick is kept. */
export const PICK_KEY = "agent-pick";

/** `pick` with `change` applied: a field left out stays, `null` clears it. */
export const withChange = (pick: AgentPick, change: AgentChange): AgentPick => {
  const next: Types.Mutable<AgentPick> = {};
  const model = change.model === undefined ? pick.model : (change.model ?? undefined);

  const thinkingLevel =
    change.thinkingLevel === undefined ? pick.thinkingLevel : (change.thinkingLevel ?? undefined);

  if (model !== undefined) next.model = model;

  if (thinkingLevel !== undefined) next.thinkingLevel = thinkingLevel;

  return next;
};

/**
 * What the Session in `kv` picked: a field is absent while it follows the default. `catalog` is the Model catalog the
 * Session last read (ADR-0051).
 */
export const pickedIn = (kv: SettingsKv, catalog: ModelCatalog): AgentPick => {
  const kept = kv.get<AgentPick>(PICK_KEY) ?? {};

  // A model the catalog does not list is ignored: the Session follows the default rather than fail every request. Unlike
  // a saved setting, a pick is not kept under the fallback: the Session could not run it, and losing it costs only the
  // pick (the settings run under the fallback are listed in it, `withNamedModels`).
  return kept.model === undefined || catalogHas(catalog, formatModelId(kept.model))
    ? kept
    : withChange(kept, { model: null });
};

/**
 * What a Fork keeps picked: the fields its source picks, each as the branch ran with it at the point (`agent`), so a
 * pick changed since is the one in force then. The fields the source leaves to the default follow it in the Fork too.
 */
export const pickAsOf = (pick: AgentPick, agent: AgentState): AgentPick => {
  const model = pick.model === undefined ? undefined : (agent.model ?? pick.model);

  const thinkingLevel =
    pick.thinkingLevel === undefined ? undefined : (agent.thinkingLevel ?? pick.thinkingLevel);

  return withChange({}, { model: model ?? null, thinkingLevel: thinkingLevel ?? null });
};
