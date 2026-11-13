// @effect-diagnostics preferEffectArray:off nodeBuiltinImport:off -- native array methods over plain values (the extension carries no Effect runtime); runs on node, on the owner's machine.
/**
 * Where the endpoint is (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Configuration): the `cloudpid`
 * setting from pi's global settings and a trusted project's, through pi's own `SettingsManager` over real files. No
 * default; an unset or invalid block is a refusal that names the setting and the file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as Predicate from "effect/Predicate";
import { endpointKey, readConfig, SETUP_STEPS } from "./config.ts";
import { Refusal } from "./errors.ts";
import type { JsonObject } from "./json.ts";

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-cloudpid-settings-"));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const globalFile = () => join(agentDir, "settings.json");

const projectFile = () => join(project, ".pi", "settings.json");

/** A `cloudpid` block (or any text) in a settings file. */
const write = (file: string, content: JsonObject | string) => {
  writeFileSync(file, Predicate.isString(content) ? content : JSON.stringify(content));
};

/** `readConfig` as `/cloudpid` calls it: a fresh `SettingsManager` over the files, as the run reads them. */
const read = (trusted = true) =>
  readConfig({
    settingsManager: SettingsManager.create(project, agentDir, { projectTrusted: trusted }),
    sessionManager: { getBranch: () => [] },
    files: { global: globalFile(), project: projectFile() },
  });

const refusal = (trusted = true): string => {
  try {
    read(trusted);
  } catch (error) {
    expect(error).toBeInstanceOf(Refusal);

    return error instanceof Error ? error.message : "";
  }

  throw new Error("expected a Refusal");
};

describe("the endpoint from settings", () => {
  it("refuses with setup steps naming the setting when nothing is set, and never falls back", () => {
    const message = refusal();

    expect(message).toContain("`cloudpid.baseUrl` is not set");
    expect(message).toContain("~/.pi/agent/settings.json");
    expect(message).toContain(".pi/settings.json");
    expect(message).toContain(SETUP_STEPS);

    // Other settings are not the block.
    write(globalFile(), { theme: "dark" });
    expect(refusal()).toContain("`cloudpid.baseUrl` is not set");
  });

  it("takes the global setting, with /mcp appended", () => {
    write(globalFile(), { cloudpid: { baseUrl: "https://pi.example.test" } });

    const config = read();

    expect(config.url.href).toBe("https://pi.example.test/mcp");
    expect(endpointKey(config)).toBe("https://pi.example.test/mcp");
  });

  it.each([
    ["https://pi.example.test", "https://pi.example.test/mcp"],
    ["https://pi.example.test/mcp/", "https://pi.example.test/mcp"],
    ["https://pi.example.test/base", "https://pi.example.test/base/mcp"],
    ["https://pi.example.test/?x=1#y", "https://pi.example.test/mcp"],
  ])("appends /mcp once: %s", (baseUrl, expected) => {
    write(globalFile(), { cloudpid: { baseUrl } });

    expect(read().url.href).toBe(expected);
  });

  it("takes http for loopback and nothing else", () => {
    write(globalFile(), { cloudpid: { baseUrl: "http://localhost:8787" } });
    expect(read().url.href).toBe("http://localhost:8787/mcp");

    write(globalFile(), { cloudpid: { baseUrl: "http://127.0.0.1:8787" } });
    expect(read().url.href).toBe("http://127.0.0.1:8787/mcp");

    write(globalFile(), { cloudpid: { baseUrl: "http://pi.example.test" } });
    expect(refusal()).toContain("must be an https URL");
    expect(refusal()).toContain(globalFile());
  });

  it("refuses a value that is no URL, naming the file", () => {
    write(globalFile(), { cloudpid: { baseUrl: "not a url" } });

    expect(refusal()).toContain(`\`cloudpid.baseUrl\` in ${globalFile()} is not a URL`);
  });
});

describe("global and project settings", () => {
  beforeEach(() => {
    write(globalFile(), { cloudpid: { baseUrl: "https://global.example.test" } });
  });

  it("takes a trusted project's setting over the global one", () => {
    write(projectFile(), { cloudpid: { baseUrl: "https://preview.example.test" } });

    expect(read(true).url.href).toBe("https://preview.example.test/mcp");
  });

  it("ignores an untrusted project's setting", () => {
    write(projectFile(), { cloudpid: { baseUrl: "https://preview.example.test" } });

    expect(read(false).url.href).toBe("https://global.example.test/mcp");
  });

  it("takes a trusted project's setting when there is no global one, and refuses an untrusted one's", () => {
    rmSync(globalFile());
    write(projectFile(), { cloudpid: { baseUrl: "https://preview.example.test" } });

    expect(read(true).url.href).toBe("https://preview.example.test/mcp");
    expect(refusal(false)).toContain("`cloudpid.baseUrl` is not set");
  });

  it("names the project's file when its value is the bad one", () => {
    write(projectFile(), { cloudpid: { baseUrl: "http://preview.example.test" } });

    expect(refusal(true)).toContain(`in ${projectFile()} must be an https URL`);
  });
});

describe("an invalid block", () => {
  it.each([
    [
      "an unknown field",
      { cloudpid: { baseUrl: "https://a.example.test", clientId: "x" } },
      "cloudpid settings/clientId:",
    ],
    [
      "a block that is not an object",
      { cloudpid: "https://a.example.test" },
      "cloudpid settings: must be object",
    ],
  ])(
    "refuses %s, naming the file and the field path, and never falls back",
    (_name, content, field) => {
      write(globalFile(), content);

      const message = refusal();

      expect(message).toContain(globalFile());
      expect(message).toContain(field);
      expect(message).toContain("invalid");
    },
  );

  it("refuses an invalid block in a trusted project's file, and ignores it in an untrusted one", () => {
    write(globalFile(), { cloudpid: { baseUrl: "https://global.example.test" } });
    write(projectFile(), { cloudpid: { baseUrl: "" } });

    expect(refusal(true)).toContain(projectFile());
    expect(read(false).url.href).toBe("https://global.example.test/mcp");
  });

  it("refuses a settings file that is not JSON, naming it", () => {
    write(globalFile(), "{ not json");

    const message = refusal();

    expect(message).toContain(globalFile());
    expect(message).toContain("cannot be read");
  });
});
