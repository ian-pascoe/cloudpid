// @effect-diagnostics preferEffectArray:off preferEffectRecord:off processEnv:off missingPipeableSignature:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain functions over values, called directly; reads the build's commit.
/**
 * Where the endpoint is (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Configuration): the
 * `cloudpid.baseUrl` pi setting, read with `defineLayeredSettings` (`@ian-pascoe/pi-utils`): `~/.pi/agent/settings.json`,
 * then `.pi/settings.json` of a trusted project. No default and no environment variable; an unset or invalid block is a
 * {@link Refusal}. Read on every run and at every `session_start` (`mcp-server.ts`), so a change needs no `/reload` for the command. How the command gets in is `oauth.ts`.
 */
import { defineLayeredSettings } from "@ian-pascoe/pi-utils/layered-settings";
import type { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Refusal } from "./errors.ts";

/** The endpoint `/cloudpid` talks to. */
export interface Config {
  /** The MCP endpoint, `https://<host>/mcp`. */
  readonly url: URL;
}

/** The key an endpoint's sign-in is stored under: its URL as a string. */
export const endpointKey = (config: Config): string => config.url.href;

const schema = Type.Object(
  { baseUrl: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

interface Defaults {
  baseUrl?: string;
}

const defaults: Defaults = {};

const layered = defineLayeredSettings({
  namespace: "cloudpid",
  label: "cloudpid",
  schema,
  defaults,
});

/** What of pi `/cloudpid` reads its settings from, and where the two files are (for the sentences that name one). */
export interface SettingsSource {
  readonly settingsManager: SettingsManager;
  /** Only because `readSettings`' signature asks for one: cloudpid has no session layer, so its branch is never read. */
  readonly sessionManager: Pick<SessionManager, "getBranch">;
  readonly files: { readonly global: string; readonly project: string };
}

export const SETUP_STEPS = [
  "Set `cloudpid.baseUrl` in pi's settings (`~/.pi/agent/settings.json`, or `.pi/settings.json` in a trusted project):",
  '  { "cloudpid": { "baseUrl": "https://<your cloudpid host>" } }',
  "Then run `/cloudpid login` to sign in. The extension's README has the rest.",
].join("\n");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `/mcp`, added to the path once: a path that already ends in it is taken as is. */
const mcpPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");

  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
};

/** The endpoint's URL: https (http only on loopback, for `alchemy dev`), with `/mcp` once; `where` names the setting for a refusal. */
const endpointUrl = (raw: string, where: string): URL => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Refusal(`${where} is not a URL: ${raw}\n${SETUP_STEPS}`);
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Refusal(
      `${where} must be an https URL (${raw}); http is for localhost only.\n${SETUP_STEPS}`,
    );
  }

  url.pathname = mcpPath(url.pathname);
  url.search = "";
  url.hash = "";

  return url;
};

/** The endpoint from pi's settings, or a {@link Refusal} that says what is missing or wrong, and where. */
export const readConfig = (source: SettingsSource): Config => {
  const { settingsManager, files } = source;

  for (const problem of settingsManager.drainErrors()) {
    throw new Refusal(
      `${problem.path ?? files[problem.scope]} cannot be read, so \`cloudpid.baseUrl\` is not known: ${problem.error.message}`,
    );
  }

  const layers = layered.readLayers(settingsManager);

  for (const scope of ["global", "project"] as const) {
    const layer = layers[scope];

    if (layer instanceof Error) {
      throw new Refusal(
        `The \`cloudpid\` settings in ${files[scope]} are invalid (${layer.message}). Only \`baseUrl\` (a URL) is known.\n${SETUP_STEPS}`,
      );
    }
  }

  const { settings, sources } = layered.readSettings(source, layers);

  if (settings.baseUrl === undefined) {
    throw new Refusal(`/cloudpid is not set up: \`cloudpid.baseUrl\` is not set.\n${SETUP_STEPS}`);
  }

  const scope = sources["baseUrl"];
  const file = scope === "project" ? files.project : files.global;

  return { url: endpointUrl(settings.baseUrl, `\`cloudpid.baseUrl\` in ${file}`) };
};

/**
 * The commit `dist/index.js` was built from (`build.ts` defines it), for `X-Cloudpid-Client`; `dev` when pi runs the
 * source (`pi -e packages/pi-cloudpid/src/index.ts`).
 */
export const BUILD_SHA: string = process.env.PI_CLOUDPID_SHA ?? "dev";

/** The `X-Cloudpid-Client` value: the endpoint shows it as the Session's client, trimmed to 40 characters. */
export const clientName = (sha: string = BUILD_SHA): string => `pi-cloudpid/${sha.slice(0, 12)}`;
