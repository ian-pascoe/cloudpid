// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off asyncFunction:off
// The `secrets` extension (`docs/architecture/agent-capabilities.md` → Secrets), ported from pi-secret's `pi-secret-extension.ts` (see
// ../../NOTICE.md): `secret_ask`, `secret_list`, and `secret_forget`; a `beforeTool` hook that blocks calls referencing
// a Secret the Session does not hold; an `afterTool` hook that redacts every result; and wraps that resolve references
// in the tools that use Secrets. Provider requests are scrubbed at the Session's model seam (`./models.ts`), which the
// host installs, so every model call is covered, not only generations.
//
// Values never enter durable state. pi-durable records the arguments a `beforeTool` hook returns (in the call's intent
// and in a nested call's progress), so the hook only blocks; the wrap of each tool that uses Secrets resolves its
// placeholders, injects the environment variables into its commands, and redacts its streamed output inside
// `execute`, where nothing it sees is stored. Tools whose arguments become conversation content (code mode scripts,
// subagent tasks, notes, handoffs) are not wrapped: their references stay references, and the calls they lead to
// resolve their own.
import { defineEffectTool, effectHook, effectSection } from "@cloudpid/effect-durable";
import { SecretKeep } from "@cloudpid/protocol";
import type { JsonValue as DetailsJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Extension,
  ToolTask,
  type ToolExecutionApi,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { BackendEnv } from "../coding-tools.ts";
import { ENVIRONMENT_TOOL_PREFIX } from "../environment.ts";
import {
  isSecretName,
  referencedSecretNames,
  rewriteReferences,
  SECRET_NAME_PATTERN,
  secretEnvName,
  secretReference,
} from "./references.ts";
import type { KeptScope } from "./kept.ts";
import {
  type AskOutcome,
  type ForgetOutcome,
  type SecretAsk,
  Secrets,
  type SecretsService,
} from "./store.ts";

export const extensionName = "secrets";

/** The tools a child agent never gets: it uses the Secrets its root holds, but cannot ask for or forget them. */
export const PARENT_ONLY_SECRET_TOOLS = ["secret_ask", "secret_forget"] as const;

/** The Secrets tools, whose arguments name Secrets rather than reference them. */
const SECRET_TOOLS: ReadonlySet<string> = new Set(["secret_ask", "secret_list", "secret_forget"]);

const ESCAPE_HINT =
  "To write a reference as literal text instead, put a backslash right before it; the backslash is removed before the tool runs.";

/** The system prompt's guidance, built from its parts so no source spells a reference. */
export const SECRET_GUIDELINES = [
  "When a task needs a Secret such as an API key or password, call secret_ask instead of asking the user to paste it into the conversation; the user enters it in a masked form, and its value never reaches you.",
  `Use a held Secret as $${secretEnvName("NAME")} in bash commands, which keeps it off the command line, and as ${secretReference("NAME")} in other tool arguments. Tool output shows ${secretReference("NAME")} where a value was redacted.`,
  "Secrets expire 15 minutes after the user enters them; call secret_ask again for one that expired, and secret_forget for one no longer needed. Secrets the user keeps for the Environment do not expire and cannot be forgotten; secret_list shows them.",
  'A Secret that every Session of an Environment needs (a database URL, a registry token) is better kept than asked for again each time: pass keep to secret_ask ("environment", or "all" for every Environment) to offer it. The user chooses in the form, this Session only by default, and the answer says what they chose.',
];

const iso = (time: number): string => DateTime.formatIso(DateTime.makeUnsafe(time));

/**
 * Why a call referencing `names` cannot run, or undefined when every one is a held Secret. A malformed name and a name
 * this Session does not hold each get their own advice.
 */
const unresolvedReason = (
  names: ReadonlyArray<string>,
  isHeld: (name: string) => boolean,
): string | undefined => {
  const malformed = names.filter((name) => !isSecretName(name));
  const unheld = names.filter((name) => isSecretName(name) && !isHeld(name));
  const sentences = ["The call did not run."];

  if (malformed.length > 0) {
    const listed = malformed.map((name) => JSON.stringify(name)).join(", ");

    const verb =
      malformed.length === 1 ? "is not a valid Secret Name" : "are not valid Secret Names";

    sentences.push(
      `${listed} ${verb}: a Secret Name uses uppercase letters, digits, and underscores, and does not start with a digit.`,
    );
  }

  if (unheld.length > 0) {
    sentences.push(
      `It references ${unheld.map(secretReference).join(", ")}, which this Session does not hold. The Secret expired, was forgotten, or was never provided. Call secret_ask to request it again.`,
    );
  }

  if (sentences.length === 1) return undefined;

  sentences.push(ESCAPE_HINT);

  return sentences.join(" ");
};

/** The values of every Secret `names` reference, or why the call cannot run. */
const resolveAll = (secrets: SecretsService, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const values = new Map<string, string>();

    for (const name of names) {
      const value = isSecretName(name) ? yield* secrets.resolve(name) : undefined;

      if (value !== undefined) values.set(name, value);
    }

    const reason = unresolvedReason(names, (name) => values.has(name));

    return reason === undefined ? { values } : { reason };
  });

/**
 * Redact the Result Spill at `path` in place: it holds a command's raw output, in the Workspace's `/tmp`, which outlives
 * the Secret and is readable by every Session on the Workspace. Runs on its own context, so an aborted command's spill
 * is redacted too; a spill that cannot be rewritten is removed.
 */
const redactSpill = async (env: ExecutionEnv, path: string, redact: (text: string) => string) => {
  const read = await env.readTextFile(path, BACKGROUND_CONTEXT);

  if (read.ok) {
    const redacted = redact(read.value);

    if (redacted === read.value) return;

    const written = await env.writeFile(path, redacted, BACKGROUND_CONTEXT);

    if (written.ok) return;
  }

  await env.remove(path, { force: true }, BACKGROUND_CONTEXT);
};

/**
 * `env` with every held Secret added to the environment of each command it runs, read when the command starts, and the
 * Result Spill of each command redacted before the command's result reaches the tool.
 */
const withSecretEnvironment = (
  env: ExecutionEnv,
  variables: () => Promise<Readonly<Record<string, string>>>,
  redactions: Pick<SecretsService, "redact" | "redacting">,
): ExecutionEnv =>
  new Proxy(env, {
    get: (target, key) => {
      if (key === "exec") {
        const exec: ExecutionEnv["exec"] = async (command, options, context) => {
          const result = await target.exec(
            command,
            { ...options, env: { ...options?.env, ...(await variables()) } },
            context,
          );

          const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;

          // Read back only when redaction can change it: a spill is up to megabytes over the Workspace's RPC.
          if (spillPath !== undefined && redactions.redacting()) {
            await redactSpill(target, spillPath, (text) => redactions.redact(text));
          }

          return result;
        };

        return exec;
      }

      if (key === "onBackend" && "onBackend" in target) {
        // SAFETY: `onBackend` exists on the target, which makes it an environment with backends (`coding-tools.ts`).
        const backends = target as ExecutionEnv & BackendEnv;

        const onBackend: BackendEnv["onBackend"] = (backend) =>
          withSecretEnvironment(backends.onBackend(backend), variables, redactions);

        return onBackend;
      }

      // SAFETY: every other property is read from the environment itself, as its own type describes it.
      const value = target[key as keyof ExecutionEnv];

      // Methods run on the environment itself, whose private state a proxy would not have.
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });

/**
 * `tool` running with the Session's Secrets: its placeholders resolved and escapes removed, the held Secrets in the
 * environment of its commands, and its running output, details, and diagnostics redacted before they are committed.
 * A reference that no longer resolves (the Secret expired since the call was admitted, or the call reruns after an
 * eviction) fails the call with the same advice the `beforeTool` hook gives.
 */
const withSecrets =
  (secrets: SecretsService, run: <A>(effect: Effect.Effect<A>) => Promise<A>) =>
  (tool: ToolRegistration): ToolRegistration => ({
    ...tool,
    execute: async (args, api, context) => {
      // SAFETY: the Harness validated the arguments against the tool's parameters: they are JSON.
      const json = args as JsonValue;

      // The kept Secrets first, so the output is redacted of them also when nothing references them.
      await run(secrets.refresh);

      const resolved = await run(resolveAll(secrets, [...referencedSecretNames(json)]));

      if ("reason" in resolved) throw new Error(resolved.reason);

      const stream = secrets.stream();
      const decoder = new TextDecoder();

      const flush = () => {
        const rest = stream.flush();

        if (rest !== "") api.output(rest);
      };

      const secretApi: ToolExecutionApi = {
        ...api,
        env:
          api.env === undefined
            ? undefined
            : withSecretEnvironment(api.env, () => run(secrets.environment), secrets),
        output: (chunk) => {
          const settled = stream.push(
            Predicate.isString(chunk) ? chunk : decoder.decode(chunk, { stream: true }),
          );

          if (settled !== "") api.output(settled);
        },
        // Output an environment skipped would bypass the redaction, so the environment sends all of it.
        outputWindow: undefined,
        retainedOutput: () => {
          flush();

          return api.retainedOutput();
        },
        diagnostic: (diagnostic) => {
          api.diagnostic(secrets.redact(diagnostic));
        },
        details: (value, detailsContext) => api.details(secrets.redact(value), detailsContext),
      };

      try {
        return await tool.execute(
          rewriteReferences(json, (name) => resolved.values.get(name) ?? ""),
          secretApi,
          context,
        );
      } finally {
        flush();
      }
    },
  });

const SecretName = Schema.String.check(Schema.isPattern(SECRET_NAME_PATTERN)).annotate({
  description: "Secret Name in environment-variable style, such as OPENAI_API_KEY",
});

const AskParameters = Schema.Struct({
  names: Schema.Array(SecretName)
    .check(Schema.isMinLength(1), Schema.isMaxLength(20), Schema.isUnique())
    .annotate({ description: "Secret Names to request from the user, one masked field each" }),
  reason: Schema.optional(
    Schema.String.annotate({ description: "Why the Secrets are needed, shown to the user" }),
  ),
  keep: Schema.optional(
    SecretKeep.annotate({
      description:
        'Where to suggest keeping them: "session" (the default: held for this Session for 15 minutes), "environment" (kept for this Session\'s Environment, so every Session of it has them, without expiry) or "all" (kept for every Environment). It only pre-selects the choice in the form: the user always chooses among the three, and the answer says what they chose',
    }),
  ),
});

const ListParameters = Schema.Struct({
  query: Schema.optional(
    Schema.String.annotate({ description: "Case-insensitive text matched against Secret Names" }),
  ),
});

const ForgetParameters = Schema.Struct({
  names: Schema.Array(SecretName)
    .check(Schema.isMinLength(1), Schema.isUnique())
    .annotate({ description: "Secret Names to forget now, before their lifetime ends" }),
});

const usage = (name: string): string =>
  `Use $${secretEnvName(name)} in bash commands and ${secretReference(name)} in other tool arguments.`;

const askLine = (outcome: AskOutcome): string => {
  switch (outcome.status) {
    case "provided":
      return `${outcome.name}: provided. ${usage(outcome.name)} Held for this Session only: it expires ${iso(outcome.expiresAt)}.${outcome.notKept === undefined ? "" : ` The user chose to keep it, but it could not be kept: ${outcome.notKept}`}`;
    case "kept":
      return `${outcome.name}: provided and ${keptWhere(outcome.scope)}, as the user chose; it does not expire. ${usage(outcome.name)}${outcome.shadowed === true ? " The Environment keeps its own Secret of this name, which wins in its Sessions over the one kept for every Environment." : ""}`;
    case "skipped":
      return `${outcome.name}: skipped by the user.`;
    case "cancelled":
      return `${outcome.name}: not provided; the user cancelled the request.`;
  }
};

/** Where a kept Secret is kept, as `secret_list` says it. */
const keptWhere = (scope: KeptScope): string =>
  scope === "environment" ? "kept for this Environment" : "kept for every Environment";

/** What `secret_forget` says of one name. */
const forgetLine = ({ name, forgotten, kept }: ForgetOutcome): string => {
  if (kept === undefined)
    return forgotten ? `${name}: forgotten.` : `${name}: not held by this Session.`;

  return forgotten
    ? `${name}: forgotten; the Secret ${keptWhere(kept)} under this name is used from now on.`
    : `${name}: ${keptWhere(kept)}, which a Session cannot forget; the user removes it on the Environments page.`;
};

/** A tool result of `lines`, with `secrets` as its details; never a value. */
const result = (
  lines: ReadonlyArray<string>,
  secrets: ReadonlyArray<{ readonly [key: string]: DetailsJson }>,
) => ({
  output: [{ type: "text" as const, text: lines.join("\n") }],
  details: { secrets: [...secrets] },
});

/** The outcome as details: JSON, with the expiry as an ISO time and the scope of a kept Secret. */
const outcomeDetails = (outcome: AskOutcome) => {
  switch (outcome.status) {
    case "provided": {
      const held = {
        name: outcome.name,
        status: outcome.status,
        env: secretEnvName(outcome.name),
        reference: secretReference(outcome.name),
        expires_at: iso(outcome.expiresAt),
      };

      return outcome.notKept === undefined ? held : { ...held, not_kept: outcome.notKept };
    }

    case "kept":
      return {
        name: outcome.name,
        status: outcome.status,
        scope: outcome.scope,
        env: secretEnvName(outcome.name),
        reference: secretReference(outcome.name),
      };

    default:
      return { name: outcome.name, status: outcome.status };
  }
};

/**
 * The `secrets` extension. The `resolving` tools (the coding and file tools, and `web_fetch`) run with Secrets; every
 * other tool sees references as written. Needs the Session's `Secrets`.
 */
export const secretsExtension = (
  resolving: ReadonlyArray<ToolRegistration>,
): Effect.Effect<Extension, never, Secrets> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const services = yield* Effect.context<never>();
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(services)(effect);

    const ask = yield* defineEffectTool({
      name: "secret_ask",
      description:
        "Ask the user to enter Secrets (API keys, passwords, tokens) in a masked form in their browser. Waits for the answer and returns how to reference each one; never its value. The form lets the user keep what they enter for this Session only (the default, 15 minutes), for this Session's Environment or for every Environment, where it does not expire; keep only suggests one of the three, and the answer says which the user chose. A Secret kept this way is recorded in the Environment's Agent changes by name, and listed in the Run's Notification.",
      parameters: AskParameters,
      executionMode: "sequential",
      // An eviction cuts the wait off; the rerun waits for the same request, which the user still sees.
      replay: "safe",
      execute: ({ names, reason, keep }, api) =>
        Effect.gen(function* () {
          const shown = reason?.trim() === "" ? undefined : reason;

          const request: Types.Mutable<SecretAsk> = {
            id: String(api.taskId),
            conversationId: api.conversationId,
            names,
          };

          if (shown !== undefined) request.reason = shown;

          if (keep !== undefined) request.keep = keep;

          const outcomes = yield* secrets.ask(request);

          const cancelled = Arr.some(outcomes, (outcome) => outcome.status === "cancelled");

          const lines = [
            ...(cancelled
              ? ["The user cancelled the Secret request. Do not ask again unless they want to."]
              : []),
            ...outcomes.map(askLine),
          ];

          return result(lines, outcomes.map(outcomeDetails));
        }),
    });

    const list = yield* defineEffectTool({
      name: "secret_list",
      description:
        "List the Secrets this Session holds: those the user entered, with when each expires, and those kept for the Environment; never their values.",
      parameters: ListParameters,
      replay: "safe",
      execute: ({ query }) =>
        Effect.gen(function* () {
          yield* secrets.sweep;

          const needle = query?.toLowerCase() ?? "";

          const held = Arr.filter(yield* secrets.held, (secret) =>
            secret.name.toLowerCase().includes(needle),
          );

          if (held.length === 0) {
            return result(["No Secrets are held. Call secret_ask to request one."], []);
          }

          return result(
            held.map(
              (secret) =>
                `${secret.name}: ${secret.kept === undefined ? `held until ${iso(secret.expiresAt)}` : keptWhere(secret.kept)}. Use $${secretEnvName(secret.name)} or ${secretReference(secret.name)}.`,
            ),
            held.map((secret) =>
              secret.kept === undefined
                ? {
                    name: secret.name,
                    status: "held",
                    env: secretEnvName(secret.name),
                    reference: secretReference(secret.name),
                    expires_at: iso(secret.expiresAt),
                  }
                : {
                    name: secret.name,
                    status: "kept",
                    scope: secret.kept,
                    env: secretEnvName(secret.name),
                    reference: secretReference(secret.name),
                  },
            ),
          );
        }),
    });

    const forget = yield* defineEffectTool({
      name: "secret_forget",
      description: "Forget Secrets now, before their lifetime ends.",
      parameters: ForgetParameters,
      replay: "safe",
      execute: ({ names }) =>
        Effect.map(secrets.forget(names), (forgotten) =>
          result(
            forgotten.map(forgetLine),
            forgotten.map(({ name, forgotten: was, kept }) =>
              kept === undefined
                ? { name, status: was ? "forgotten" : "not_held" }
                : { name, status: was ? "forgotten" : "kept", scope: kept },
            ),
          ),
        ),
    });

    const tools = yield* effectHook(ToolTask, {
      beforeTool: (call) =>
        Effect.gen(function* () {
          if (SECRET_TOOLS.has(call.name)) return undefined;

          // So the call's result is redacted of the kept Secrets (`afterTool`) also when it references none.
          yield* secrets.refresh;

          // The `environment` tools save plain values as written and resolve no Secret Reference (`docs/architecture/agent-changes.md`):
          // a reference in their arguments is text, whether or not the Session holds it.
          if (call.name.startsWith(ENVIRONMENT_TOOL_PREFIX)) return undefined;

          const names = [...referencedSecretNames(call.arguments)];

          if (names.length === 0) return undefined;

          const resolved = yield* resolveAll(secrets, names);

          return "reason" in resolved ? { block: resolved.reason } : undefined;
        }),
      afterTool: (_call, toolResult) => Effect.sync(() => secrets.redact(toolResult)),
    });

    // Also when the secret tools are deferred: the guidance not to ask the owner to paste a Secret into the conversation
    // must not depend on having loaded the tool that replaces it.
    const guidelines = yield* effectSection("secrets", (input) =>
      Effect.sync(() => {
        const isSecretTool = (tool: { readonly name: string }) => SECRET_TOOLS.has(tool.name);

        if (Arr.some(input.agent.tools, isSecretTool)) {
          return SECRET_GUIDELINES.map((line) => `- ${line}`).join("\n");
        }

        return Arr.some(input.agent.deferred, isSecretTool)
          ? [
              ...SECRET_GUIDELINES,
              "The secret tools are deferred: load them with tool_search before you call them.",
            ]
              .map((line) => `- ${line}`)
              .join("\n")
          : undefined;
      }),
    );

    const wrap = withSecrets(secrets, run);

    return defineExtension({
      name: extensionName,
      tools: [ask, list, forget],
      hooks: [tools],
      sections: [guidelines],
      wraps: resolving.map((tool) => wrapTool(tool, wrap)),
    });
  });
