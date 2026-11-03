// What cloudpid calls itself at an authorization server (`docs/architecture/mcp-sign-in.md` → Client registration, Settings):
// the client name of the client document and of DCR. Pure, so the Registry's start and the Settings page's form say the
// same name.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values.
import * as Arr from "effect/Array";

/** The longest `client_name` (`oauth.clientName`: 1–100 characters). */
const MAX_CLIENT_NAME_LENGTH = 100;

/** The stage a client name is made for: its label (absent on `prod`) and whether it runs under `alchemy dev`. */
export type McpStageNaming = {
  readonly label?: string | undefined;
  readonly local: boolean;
};

/** The ` (<label>)` or ` (<label>, local)` a non-prod stage adds to a client name; empty on `prod`. */
const suffixOf = ({ label, local }: McpStageNaming): string =>
  label === undefined ? "" : ` (${label}${local ? ", local" : ""})`;

/**
 * The name cloudpid registers and shows as: `cloudpid` on prod, `cloudpid (<label>)` on other deployed stages and
 * `cloudpid (<label>, local)` under `alchemy dev`. A configured `oauth.clientName` gets the suffix off prod too. The
 * suffix is never cut: past 100 characters the configured part is shortened at a code-point boundary.
 */
export const mcpClientNameFor = (stage: McpStageNaming, configured?: string): string => {
  const suffix = suffixOf(stage);
  const base = Array.from(configured ?? "cloudpid");
  const room = Math.max(0, MAX_CLIENT_NAME_LENGTH - Array.from(suffix).length);

  return `${Arr.join(Arr.take(base, room), "")}${suffix}`;
};
