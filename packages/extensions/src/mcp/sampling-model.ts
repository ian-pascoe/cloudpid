// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values.
// Which model answers a Sampling request, and how it is asked (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, Which model, The completion; #387 D4, D14.2): the server's hints and priorities map onto the Session's Roles
// (never above `medium` unless the owner picks one), and `toolChoice: "required"` is spelled per API.
import { ROLE_NAMES, type RoleName } from "@cloudpid/config";
import type { Api } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

/** What the server said of the model it wants (the spec's `modelPreferences`). */
export type ModelPreferences = {
  readonly hints?: ReadonlyArray<{ readonly name?: string | undefined }> | undefined;
  readonly costPriority?: number | undefined;
  readonly speedPriority?: number | undefined;
  readonly intelligencePriority?: number | undefined;
};

/** A Role and its model's id without the provider prefix, as the hints are matched against. */
export type RoleModel = { readonly role: RoleName; readonly id: string };

/** The highest Role a request is given without the owner's pick. */
export const AUTOMATIC_CEILING: RoleName = "medium";

/** The `intelligencePriority` from which a request with no matching hint is given `medium`. */
const INTELLIGENT = 0.7;

const rank = (role: RoleName): number => ROLE_NAMES.indexOf(role);

const byRank = Order.mapInput(Order.Number, rank);

/** What a choice came to: the Role asked for, and whether the ceiling lowered it. */
export type Chosen = { readonly role: RoleName; readonly clamped: boolean };

/** Whether the priorities ask for the most intelligent of several matches: high, and above both cost and speed. */
const wantsIntelligence = (prefs: ModelPreferences | undefined): boolean => {
  const intelligence = prefs?.intelligencePriority ?? 0;

  return (
    intelligence >= INTELLIGENT &&
    intelligence > (prefs?.costPriority ?? 0) &&
    intelligence > (prefs?.speedPriority ?? 0)
  );
};

/**
 * The Role a request is given: the first hint, in the server's order, that is a case-insensitive substring of some Role's
 * model id decides, the priorities picking among several Roles it matches (the most intelligent when they ask for it,
 * else the lowest); with no hint matching, `medium` for a request that asks for intelligence, else `small`. Never above
 * the ceiling, `clamped` saying when it was lowered by it.
 */
export const chooseRole = (
  prefs: ModelPreferences | undefined,
  roles: ReadonlyArray<RoleModel>,
  ceiling: RoleName = AUTOMATIC_CEILING,
): Chosen => {
  let wanted: RoleName | undefined;

  for (const hint of prefs?.hints ?? []) {
    const name = hint.name?.trim().toLowerCase();

    if (name === undefined || name === "") continue;

    const matching = Arr.sort(
      Arr.map(
        Arr.filter(roles, (each) => each.id.toLowerCase().includes(name)),
        (each) => each.role,
      ),
      byRank,
    );

    if (matching.length > 0) {
      wanted = wantsIntelligence(prefs) ? matching.at(-1) : matching[0];
      break;
    }
  }

  wanted ??= wantsIntelligence(prefs) ? "medium" : "small";

  return rank(wanted) > rank(ceiling)
    ? { role: ceiling, clamped: true }
    : { role: wanted, clamped: false };
};

/**
 * `role`, or the next lower Role that `has` a model; undefined when none is left: the request cannot be served (a Role
 * whose model the Session's `Models` lacks falls to the one below it, never to the Session's own model).
 */
export const lowestAvailable = (
  role: RoleName,
  has: (role: RoleName) => boolean,
): RoleName | undefined => {
  for (const each of Arr.reverse(ROLE_NAMES.slice(0, rank(role) + 1))) {
    if (has(each)) return each;
  }

  return undefined;
};

/** `toolChoice: "required"`, or what it falls to, for each API (a golden test per row). */
const REQUIRED_ANY: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
]);

const REQUIRED_REQUIRED: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

/** What a request's `toolChoice` is passed to `api` as, and the card note when it could not be kept. */
export type ToolChoice = {
  /** The API's own value; absent to leave the API's default (`auto`). */
  readonly value?: "any" | "required" | "none";
  readonly note?: string;
};

/**
 * `mode` (the spec's `toolChoice.mode`) as `api` spells it. `required` is `"any"` or `"required"` as the API has it, and
 * `auto` with a note where the API has neither; `none` is `"none"` on every API that takes a choice; `auto` leaves the
 * default.
 */
export const toolChoiceFor = (
  api: Api,
  mode: "auto" | "required" | "none" | undefined,
): ToolChoice => {
  if (mode === undefined || mode === "auto") return {};

  if (mode === "none") return { value: "none" };

  if (REQUIRED_ANY.has(api)) return { value: "any" };

  if (REQUIRED_REQUIRED.has(api)) return { value: "required" };

  return { note: "the model was not required to use a tool" };
};
