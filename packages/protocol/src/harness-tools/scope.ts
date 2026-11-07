// The Scope a harness tool names (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools; ADR-0027): an
// Environment by its id, or Global by `*`. The same constants and words are the in-session tools' and the endpoint's.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import type { Surface } from "./surface.ts";

/** The id that addresses what is kept Global: the Container settings, the Secrets and the Skills. */
export const GLOBAL_ID = "*";

/** The name Global goes by wherever a Scope is named. */
export const GLOBAL_NAME = "Global";

/** The Scope `*`: the Global Settings, which an Environment inherits where it has no Override (ADR-0027). */
export const GLOBAL_SETTINGS_SCOPE = "*";

/** An Environment, or Global (id `*`), by id and name. */
export const ScopeRef = Schema.Struct({
  id: Schema.String.annotate({ description: 'The Environment\'s id, or "*" for Global' }),
  name: Schema.String.annotate({ description: 'The Environment\'s name, or "Global"' }),
});

/** Where a tool's `id` description says to find the Environment: a Session's own is named like any other. */
const FIND_OWN = "environment_list marks this Session's own";

/** What an `id` description says: where to find the id, and that none is assumed; `more` follows the id's own words. */
export const idDescription = (surface: Surface = "session", more = "") =>
  surface === "session"
    ? `The id of the Environment, as environment_list shows it (${FIND_OWN})${more}. Name it on purpose: there is no default`
    : `The id of the Environment, as environment_list shows it${more}. Name it on purpose: there is no default`;

/** An Environment's `id`, named on purpose, with no default. */
export const environmentId = (surface: Surface = "session") =>
  Schema.String.check(Schema.isMinLength(1)).annotate({ description: idDescription(surface, "") });

/** The `id` of a tool that also takes `*`, `kept` saying what that addresses. */
export const idOrGlobal = (kept: string, surface: Surface = "session") =>
  Schema.String.check(Schema.isMinLength(1)).annotate({
    description: idDescription(surface, `, or "${GLOBAL_ID}" for ${kept}`),
  });

/** The `scope` of a tool that reads or changes the Settings: where, named on purpose, with no default (ADR-0027). */
export const SettingsScope = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: `Where the change applies: "${GLOBAL_SETTINGS_SCOPE}" for Global, which each Environment inherits unless it overrides the field, or one Environment's id as environment_list shows it, which overrides Global for that Environment's Sessions only. Name it on purpose: there is no default.`,
});
