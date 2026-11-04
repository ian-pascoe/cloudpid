// docs/architecture/mcp-endpoint.md → The Local agent's service token: what `bun run --cwd infra local-agent-token`
// reads out of a stage's alchemy state.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LOCAL_AGENT_TOKEN_ID } from "@cloudpid/server/mcp-access";

/** The stack's name, the first part of every state path: it must match `Alchemy.Stack("cloudpid", …)` in `infra/alchemy.run.ts`. */
const STACK = "cloudpid";

/** Where alchemy keeps the stage's service token record: `<stack>/<stage>/<namespace>/<logical id>`. */
export const localAgentTokenStatePath = (stage: string): string =>
  `${STACK}/${stage}/Server/${LOCAL_AGENT_TOKEN_ID}`;

/** What the Local agent's client needs, and when its secret expires. */
export interface LocalAgentToken {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly expiresAt: string | undefined;
}

/** A redacted value as alchemy writes it into state. */
const StateSecret = Schema.Struct({ __redacted__: Schema.String });

/** The part of a state record this reads: the resource's output attributes. */
const StateRecord = Schema.Struct({
  attr: Schema.optionalKey(
    Schema.Struct({
      clientId: Schema.optionalKey(Schema.String),
      clientSecret: Schema.optionalKey(StateSecret),
      expiresAt: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeStateRecord = Schema.decodeUnknownOption(Schema.fromJsonString(StateRecord));

/**
 * The token out of `alchemy state read`'s JSON for its record. Alchemy writes a redacted value as `{"__redacted__": …}`;
 * the secret is only ever on the record, so a record without one (a token not created by this stage's deploy, or not
 * finished) is an error, not a token with no secret. Throws with the reason otherwise.
 */
export const localAgentTokenFromState = (json: string): LocalAgentToken => {
  const attr = Option.getOrUndefined(decodeStateRecord(json))?.attr;

  if (attr === undefined) {
    throw new Error("the stage has no Local agent service token yet: deploy it first");
  }

  const { clientId, clientSecret, expiresAt } = attr;
  const secret = clientSecret?.__redacted__;

  if (clientId === undefined || secret === undefined) {
    throw new Error(
      "the stage's state has no client secret for the Local agent service token: Cloudflare shows it only on create, " +
        "so bump `clientSecretVersion` and deploy, or destroy the stage and deploy it again",
    );
  }

  return { clientId, clientSecret: secret, expiresAt };
};

/** The lines the script prints. */
export const formatLocalAgentToken = (token: LocalAgentToken): string =>
  Arr.join(
    [
      `CLOUDPID_ACCESS_CLIENT_ID=${token.clientId}`,
      `CLOUDPID_ACCESS_CLIENT_SECRET=${token.clientSecret}`,
      `# expires ${token.expiresAt ?? "at an unknown time"}`,
    ],
    "\n",
  );
