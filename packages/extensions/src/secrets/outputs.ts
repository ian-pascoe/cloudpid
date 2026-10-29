// What the Secrets tools return to programs (`docs/architecture/agent-capabilities.md` → Values for programs): each
// tool's `structuredOutput`, declared as its `structuredOutputSchema`. It mirrors the tool's details, which hold how to
// reference each Secret (its environment variable and its reference), when it expires, and where it is kept, and never
// a value; the Secrets extension's `afterTool` redaction covers it also when a value reaches it. A list that can grow
// (`secret_list`, `secret_forget`) is cut to `MAX_PART_BYTES` stored, with a `secrets_truncated` flag.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";

const Name = Schema.String.annotate({ description: "The Secret's name" });

const Scope = Schema.NullOr(Schema.Literals(["environment", "every"])).annotate({
  description:
    'Where a kept Secret is kept: "environment" (this Session\'s Environment) or "every" (Global); null for one held for this Session only',
});

const Env = Schema.String.annotate({
  description: "The environment variable a bash command reads it from, without the leading $",
});

const Reference = Schema.String.annotate({
  description:
    "The reference to write in other tool arguments, which the tool resolves; never the value",
});

const ExpiresAt = Schema.NullOr(Schema.String).annotate({
  description:
    "When a Secret held for this Session only expires, as an ISO time; null when it does not expire",
});

/** One name `secret_ask` asked for, and how it came out. */
export const AskedSecret = Schema.Struct({
  name: Name,
  status: Schema.Literals(["provided", "kept", "skipped", "cancelled"]).annotate({
    description:
      "provided: entered, held for this Session only; kept: entered and kept for the Environment or Global, as the user chose; skipped: the user left it empty; cancelled: the user cancelled the request",
  }),
  env: Schema.NullOr(Env).annotate({
    description: "Its environment variable; null when it was not provided",
  }),
  reference: Schema.NullOr(Reference).annotate({
    description: "Its reference; null when it was not provided",
  }),
  scope: Scope,
  expires_at: ExpiresAt,
  not_kept: Schema.NullOr(Schema.String).annotate({
    description:
      "Why a Secret the user chose to keep is held for this Session only; null when nothing went wrong",
  }),
}).annotate({ description: "How one name asked for came out" });

/** `secret_ask`: each name asked for, in order. At most 20 names, so it is not cut. */
export const AskOutput = Schema.Struct({
  secrets: Schema.Array(AskedSecret).annotate({
    description: "One per name asked for, in the order asked",
  }),
  cancelled: Schema.Boolean.annotate({ description: "The user cancelled the request" }),
});

/** One Secret `secret_list` says is held. */
export const HeldSecretOutput = Schema.Struct({
  name: Name,
  status: Schema.Literals(["held", "kept"]).annotate({
    description:
      "held: entered for this Session only, until it expires; kept: kept for the Environment or Global, with no expiry",
  }),
  scope: Scope,
  env: Env,
  reference: Reference,
  expires_at: ExpiresAt,
}).annotate({ description: "A Secret this Session holds, without its value" });

/** `secret_list`: the Secrets held, never a value. */
export const ListOutput = Schema.Struct({
  secrets: Schema.Array(HeldSecretOutput).annotate({
    description: "The Secrets held, matching the query",
  }),
  secrets_truncated: Schema.Boolean.annotate({
    description: "The list was cut to stay within the size bound of a value; narrow it with query",
  }),
});

/** What `secret_forget` did with one name. */
export const ForgottenSecret = Schema.Struct({
  name: Name,
  status: Schema.Literals(["forgotten", "not_held", "kept"]).annotate({
    description:
      "forgotten: it was held for this Session and is forgotten (scope says where a kept Secret of the name is kept, which is used from now on); not_held: this Session did not hold it; kept: a kept Secret has the name, which a Session cannot forget",
  }),
  scope: Scope,
}).annotate({ description: "What became of one name" });

/** `secret_forget`: what became of each name. */
export const ForgetOutput = Schema.Struct({
  secrets: Schema.Array(ForgottenSecret).annotate({
    description: "One per name, in the order given",
  }),
  secrets_truncated: Schema.Boolean.annotate({
    description: "The list was cut to stay within the size bound of a value",
  }),
});
