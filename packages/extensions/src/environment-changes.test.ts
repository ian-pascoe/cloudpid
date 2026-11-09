// docs/architecture/mcp-endpoint.md → Secret checks: the endpoint's check of a text a change keeps (`endpointTextCheck`).
// No Session holds a Secret there, so it finds the deploy-time credentials, in an encoding redaction knows too, and
// anything shaped like a GitHub token, and refuses a Secret Reference as `invalid_argument`; the Registry checks the
// kept Secrets itself. The cores' use of it is `environment.test.ts`'s and `environment-secret-marks.test.ts`'s.
// @effect-diagnostics missedPipeableOpportunity:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { DeployCredentials, EnvironmentsError } from "./environment.ts";
import { endpointTextCheck } from "./environment-changes.ts";
import { secretReference } from "./secrets/references.ts";

/** The deploy-time credential the check is given, as the GitHub App's key would be. */
const APP_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

/** The check with `APP_KEY` as the one deploy-time credential. */
const check = Effect.runSync(
  endpointTextCheck.pipe(Effect.provideService(DeployCredentials, { values: [APP_KEY] })),
);

describe("the endpoint's check of a kept text", () => {
  it.each([
    ["a plain text", "npm ci && npm test", false],
    ["a deploy-time credential", `KEY=${APP_KEY}`, true],
    ["a deploy-time credential in base64", btoa(APP_KEY), true],
    ["a text shaped like a GitHub token", `token ${GITHUB_TOKEN}`, true],
  ] as const)("finds %s: %#", (_, text, holds) => {
    expect(Effect.runSync(check(text))).toBe(holds);
  });

  it("refuses a Secret Reference as invalid_argument, which no change tool resolves", () => {
    const refused = Effect.runSync(Effect.flip(check(`curl -H ${secretReference("NPM_TOKEN")}`)));

    expect(refused).toBeInstanceOf(EnvironmentsError);
    expect(refused.code).toBe("invalid_argument");
  });
});
