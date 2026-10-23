// @effect-diagnostics missingPipeableSignature:off -- plain functions over the pick, called directly.
// The model and thinking level a Session picked itself (`configure`), kept in its storage: the fields it leaves out
// follow the default in the settings.
import { formatModelId, isModelId } from "@cloudpid/config";
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

/** What the Session in `kv` picked: a field is absent while it follows the default. */
export const pickedIn = (kv: SettingsKv): AgentPick => {
  const kept = kv.get<AgentPick>(PICK_KEY) ?? {};

  // A model the settings no longer accept is ignored: the Session follows the default rather than fail every request.
  return kept.model === undefined || isModelId(formatModelId(kept.model))
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
