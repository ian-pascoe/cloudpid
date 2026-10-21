// What the subagents extension reads from the settings (`docs/spec.md` → Settings): the model roles, the depth cap, and
// the toolsets the `read` and `modify` presets grant. Read at each call, so a change the Session reads applies to the
// next spawn; existing children keep the launch contract they were created with.
import type { ModelRef } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A model role: its model, and the hint that tells an agent when to pick it. */
export type SubagentRole = { readonly model: ModelRef; readonly hint: string };

/** Tool name patterns (`*` matches any run of characters) the presets grant, as pi-minimal-subagents configures them. */
export type Toolsets = {
  /** Granted to every child, whatever its selection. */
  readonly baseToolset: ReadonlyArray<string>;
  /** Added by the `read` and `modify` presets. */
  readonly readToolset: ReadonlyArray<string>;
  /** Added by the `modify` preset. */
  readonly modifyToolset: ReadonlyArray<string>;
};

export type SubagentOptions = {
  /** The roles a spawn may name, by name. */
  readonly roles: Readonly<Record<string, SubagentRole>>;
  /** Subagent levels allowed below the root: `1` permits root children, `2` grandchildren too. */
  readonly maxSubagentDepth: number;
  readonly toolsets: Toolsets;
};

/** pi-minimal-subagents' defaults: root → child → grandchild, and its read and modify presets. */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

/** Every child may keep its own Todo List, whatever preset it was given. */

export const DEFAULT_TOOLSETS: Toolsets = {
  baseToolset: ["todo"],
  readToolset: ["read", "grep", "find", "ls"],
  modifyToolset: ["bash", "edit", "write"],
};

/** The options the subagents extension reads; the Session provides them over its settings. */
export class SubagentSettings extends Context.Service<
  SubagentSettings,
  { readonly current: () => SubagentOptions }
>()("@cloudpid/extensions/subagents/options/SubagentSettings") {}

const Patterns = Schema.Array(Schema.String);

/** The extension's own options in the settings' `extensions.subagents`, each optional. */
const ExtensionOptions = Schema.Struct({
  maxSubagentDepth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  baseToolset: Schema.optionalKey(Patterns),
  readToolset: Schema.optionalKey(Patterns),
  modifyToolset: Schema.optionalKey(Patterns),
});

const decodeExtensionOptions = Schema.decodeUnknownOption(ExtensionOptions);

/**
 * The options from the settings' `roles` and `extensions.subagents`. Extension options that do not decode are left at
 * their defaults, so a mistyped override never stops a Session.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const subagentOptions = (
  roles: Readonly<Record<string, SubagentRole>>,
  extension: Schema.Json | undefined,
): SubagentOptions => {
  const decoded: typeof ExtensionOptions.Type = Option.getOrElse(
    decodeExtensionOptions(extension ?? {}),
    () => ({}),
  );

  return {
    roles,
    maxSubagentDepth: decoded.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    toolsets: {
      baseToolset: decoded.baseToolset ?? DEFAULT_TOOLSETS.baseToolset,
      readToolset: decoded.readToolset ?? DEFAULT_TOOLSETS.readToolset,
      modifyToolset: decoded.modifyToolset ?? DEFAULT_TOOLSETS.modifyToolset,
    },
  };
};

/** Options with no roles at the defaults: for tests and hosts without settings. */
export const defaultSubagentSettings = (
  options: Partial<SubagentOptions> = {},
): Context.Context<SubagentSettings> =>
  Context.make(SubagentSettings, {
    current: () => ({ ...subagentOptions({}, undefined), ...options }),
  });

/** The current options. */
export const currentOptions = Effect.map(SubagentSettings, (settings) => settings.current());
