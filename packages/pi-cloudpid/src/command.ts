// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- native array methods over plain values (the extension carries no Effect runtime); plain functions over values, called directly.
/**
 * The `/cloudpid` command line (docs/architecture/mcp-endpoint.md → Session import → The `/cloudpid` command → Command):
 * one command with subcommands, parsed here as a pure function so the verbs are tested without pi. `import` takes
 * everything after it, verbatim, as the instruction: an explicit verb, so an instruction that starts with `login` or
 * `logout` is never misread. A bare command or an unknown verb only prints the usage.
 */

/** What the owner typed after `/cloudpid`. */
export type Command =
  | { readonly kind: "import"; readonly instruction: string }
  | { readonly kind: "login" }
  | { readonly kind: "logout" }
  /** `problem` says what was wrong with the line (an unknown verb, an argument a verb does not take), when anything was. */
  | { readonly kind: "usage"; readonly problem: string | undefined };

/** The subcommands, in the order the usage and the completions list them. */
export const SUBCOMMANDS = [
  { name: "import", description: "Import this pi session into cloudpid: import [instruction]" },
  { name: "login", description: "Sign in to cloudpid (opens your browser)" },
  { name: "logout", description: "Forget the stored sign-in for the configured endpoint" },
] as const;

export const USAGE = [
  "Usage:",
  "  /cloudpid import [instruction]   import this pi session into cloudpid; everything after `import` is the instruction it starts with",
  "  /cloudpid login                  sign in to cloudpid",
  "  /cloudpid logout                 forget the stored sign-in",
].join("\n");

/** `args` (what pi passes after `/cloudpid`) as a {@link Command}. */
export const parseCommand = (args: string): Command => {
  const line = args.trim();

  if (line === "") return { kind: "usage", problem: undefined };

  const space = line.search(/\s/);
  const verb = space === -1 ? line : line.slice(0, space);
  const rest = space === -1 ? "" : line.slice(space).trim();

  if (verb === "import") return { kind: "import", instruction: rest };

  if (verb === "login" || verb === "logout") {
    return rest === ""
      ? { kind: verb }
      : { kind: "usage", problem: `\`${verb}\` takes no arguments (got: ${rest}).` };
  }

  return { kind: "usage", problem: `Unknown subcommand: ${verb}.` };
};

/** What pi's autocompletion shows for the verb being typed; none once it is past the verb. */
export const completionsFor = (
  prefix: string,
): Array<{ value: string; label: string; description: string }> | null => {
  if (/\s/.test(prefix)) return null;

  const matches = SUBCOMMANDS.flatMap((subcommand) =>
    subcommand.name.startsWith(prefix)
      ? [{ value: subcommand.name, label: subcommand.name, description: subcommand.description }]
      : [],
  );

  return matches.length === 0 ? null : matches;
};
