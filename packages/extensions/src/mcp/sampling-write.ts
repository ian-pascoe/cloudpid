// @effect-diagnostics missingPipeableSignature:off -- a builder over the Session's services.
// The write behind the Sampling card's *Always allow* and *Never* (`docs/architecture/mcp-server-requests.md` → Sampling
// requests, The card): the owner's choice sets the server's `sampling` to `allow` or `off` in the definition, at the Scope
// the definition is in (Global's, or the Environment's own entry; never a Repo's file). It goes through the same
// `SettingsAccess.change` the agent's approved changes do (`./settings-mcp-commit.ts`), as a change the owner approved by
// the click, so it is recorded in Settings' Agent changes and can be reverted there, and the new set is pushed to the
// Environment's host (`pushMcpSet`). The entry is written whole, as `settings_mcp_update` writes it, only while it is as the
// owner's Settings had it.
import { overrideInherited, settingsFieldValue } from "@cloudpid/config";
import { isJsonObject } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import { McpQuestionsError } from "./question-records.ts";
import type { McpSamplingRemember } from "./sampling-questions.ts";
import { pushMcpSet, type SettingsMcpAccessService } from "../settings-mcp-access.ts";
import { GLOBAL_SETTINGS_SCOPE, isGlobalView, type SettingsAccessService } from "../settings.ts";

/** The tool name the change is recorded under. */
export const SAMPLING_WRITE_TOOL = "mcp_sampling_answer";

const refused = (message: string) => McpQuestionsError.make({ message });

/** The Scope a definition of the `kind` of source is written at: Global, the Session's Environment, or none. */
const scopeOf = (kind: string | undefined, environment: string | null): string | null => {
  switch (kind) {
    case "global":
      return GLOBAL_SETTINGS_SCOPE;
    case "environment":
      return environment;
    default:
      return null;
  }
};

/** The write of a definition's `sampling` over the Session's Settings and its MCP access. */
export const rememberSampling =
  (access: {
    readonly settings: SettingsAccessService;
    readonly mcp: SettingsMcpAccessService;
  }): McpSamplingRemember =>
  ({ server, source, conversationId, value }) =>
    Effect.gen(function* () {
      const environment = yield* access.mcp.own;

      const scope = scopeOf(source?.kind, environment);

      if (scope === null) {
        return yield* refused(
          "This server's definition is not one the Settings hold, so it cannot be changed here",
        );
      }

      const view = yield* access.settings.get(scope);
      const field = `mcp.servers.${server}`;
      const stored = settingsFieldValue(view.settings, field);

      if (!isJsonObject(stored)) {
        return yield* refused(`The Settings have no definition of ${server} to change`);
      }

      const changed = yield* access.settings.change({
        scope,
        changes: [
          {
            field,
            value: Object.assign({}, stored, { sampling: value }),
            expected: isGlobalView(view)
              ? { value: stored }
              : { value: stored, inherited: overrideInherited(view.overrides, field) },
          },
        ],
        author: {
          conversation: conversationId,
          tool: SAMPLING_WRITE_TOOL,
          reason: `the owner chose ${value === "allow" ? "Always allow" : "Never"} on ${server}'s sampling card`,
          actor: "owner",
        },
      });

      if (changed.status === "rejected") return yield* refused(changed.message);

      if (changed.status === "changed-since") {
        return yield* refused(
          `${server}'s definition changed meanwhile; reload the Settings and try again`,
        );
      }

      // The host takes the new set at once, so the next request of the server is declared as it now says; a push that
      // fails is healed by the host's own pull.
      if (environment !== null) yield* pushMcpSet(access.mcp, environment);
    }).pipe(Effect.catchTag("SettingsAccessError", (error) => refused(error.message)));
