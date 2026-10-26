// Secrets through real runs: the agent asks, the owner answers in the masked form, and tools use the value through
// references, while the value never reaches the transcript, tool output, or the model. pi-durable's Harness is
// Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";
import { SECRET_LIFETIME_MS, secretEnvName, secretReference } from "./secrets.ts";
import { call, openSecretsHarness } from "./secrets/harness.fixture.ts";
import { toolSearchExtension } from "./tool-search.ts";

const VALUE = "ghp_live0123456789abcdef";
const ref = secretReference;
const env = secretEnvName;

describe("secrets", () => {
  it("keeps telling the model not to ask for a pasted Secret while the secret tools are deferred", async () => {
    const session = await openSecretsHarness([
      toolSearchExtension(["secret_ask", "secret_list", "secret_forget"], { offered: [] }),
    ]);

    await session.prompt("Deploy");

    const [request] = session.requests;
    const prompt = getCurrentSystemPrompt(request ?? []);

    expect(getCurrentTools(request ?? []).map((tool) => tool.name)).not.toContain("secret_ask");
    expect(prompt).toContain("call secret_ask instead of asking the user to paste it");
    expect(prompt).toContain("load them with tool_search");
  });

  it("lets a command use a Secret the owner entered in the masked form", async () => {
    const session = await openSecretsHarness();

    const running = session.prompt(
      "Deploy",
      call("secret_ask", { names: ["GITHUB_TOKEN"], reason: "push the branch" }),
      call("bash", { command: `echo token=$${env("GITHUB_TOKEN")}` }),
    );

    const ask = await session.enter({ GITHUB_TOKEN: VALUE });

    await running;

    expect(ask).toMatchObject({ names: ["GITHUB_TOKEN"], reason: "push the branch" });
    expect(session.announced.at(-1)).toEqual([]);
    expect(session.execs.at(-1)?.env[env("GITHUB_TOKEN")]).toBe(VALUE);
    expect(await session.lastResult()).toEqual({
      text: `echo token=${ref("GITHUB_TOKEN")}`,
      isError: false,
    });
    expect(await session.transcript()).not.toContain(VALUE);
    expect(JSON.stringify(session.requests)).not.toContain(VALUE);
    expect(session.dump()).not.toContain(VALUE);
  });

  it("tells the agent how to use what was entered, and what was skipped", async () => {
    const session = await openSecretsHarness();
    const running = session.prompt("Go", call("secret_ask", { names: ["API_KEY", "OPTIONAL"] }));

    await session.enter({ API_KEY: VALUE });
    await running;

    const result = await session.lastResult();

    expect(result?.text).toContain(`API_KEY: provided. Use $${env("API_KEY")} in bash commands`);
    expect(result?.text).toContain(ref("API_KEY"));
    expect(result?.text).toContain("OPTIONAL: skipped by the user.");
  });

  it("tells the agent the owner cancelled", async () => {
    const session = await openSecretsHarness();
    const running = session.prompt("Go", call("secret_ask", { names: ["API_KEY"] }));

    await session.enter(null);
    await running;

    expect((await session.lastResult())?.text).toContain("the user cancelled");
  });

  it("resolves a placeholder when the tool runs, and the transcript keeps the reference", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Go", call("record", { text: `key=${ref("API_KEY")}` }));

    expect(session.recorded.at(-1)).toEqual({ text: `key=${VALUE}` });
    expect(await session.lastResult()).toEqual({
      text: `recorded: key=${ref("API_KEY")}`,
      isError: false,
    });
    expect(await session.transcript()).toContain(ref("API_KEY"));
    expect(await session.transcript()).not.toContain(VALUE);
  });

  it("blocks a call that references a Secret the Session does not hold, with guidance", async () => {
    const session = await openSecretsHarness();

    await session.prompt("Go", call("record", { text: ref("MISSING") }));

    const result = await session.lastResult();

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("does not hold");
    expect(result?.text).toContain("Call secret_ask");
    expect(session.recorded).toEqual([]);

    await session.prompt("Go", call("bash", { command: `echo $${env("MISSING")}` }));

    expect((await session.lastResult())?.text).toContain("does not hold");
    expect(session.execs).toEqual([]);
  });

  it("blocks a malformed reference, saying what a Secret Name looks like", async () => {
    const session = await openSecretsHarness();

    await session.prompt("Go", call("record", { text: ref("lower") }));

    expect((await session.lastResult())?.text).toContain("not a valid Secret Name");
    expect(session.recorded).toEqual([]);
  });

  it("passes an environment tool's reference through unresolved, held or not, for the tool to refuse", async () => {
    const saved: string[] = [];

    const session = await openSecretsHarness([
      defineExtension({
        name: "environment",
        tools: [
          defineTool({
            name: "environment_variable_set",
            description: "Save a variable",
            parameters: Type.Object({ value: Type.String() }),
            execute: async ({ value }) => {
              saved.push(value);

              return { output: [{ type: "text", text: "saved" }] };
            },
          }),
        ],
      }),
    ]);

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Go", call("environment_variable_set", { value: ref("MISSING") }));
    await session.prompt("Go", call("environment_variable_set", { value: ref("API_KEY") }));

    expect(saved).toEqual([ref("MISSING"), ref("API_KEY")]);
  });

  it("writes an escaped reference as literal text", async () => {
    const session = await openSecretsHarness();

    await session.prompt("Go", call("record", { text: `docs: \\${ref("API_KEY")}` }));

    expect(session.recorded.at(-1)).toEqual({ text: `docs: ${ref("API_KEY")}` });
  });

  it("redacts output streamed in chunks before the Harness keeps it", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Go", call("stream", { text: `out ${ref("API_KEY")} end` }));

    expect(session.recorded.at(-1)).toEqual({ retained: `out ${ref("API_KEY")} end` });
  });

  it("scrubs a value the user pastes into the chat from provider requests", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.prompt(`oops, my key is ${VALUE}`);

    const last = JSON.stringify(session.requests.at(-1));

    expect(last).not.toContain(VALUE);
    expect(last).toContain(ref("API_KEY"));
  });

  it("scrubs model calls other than generations, such as a compaction summary of the chat", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });

    const model = session.models.getModel("faux", "faux-1");

    expect(model).toBeDefined();

    const before = session.requests.length;

    await session.models.completeSimple(model!, {
      messages: [{ role: "user", content: `summarize: my key is ${VALUE}`, timestamp: 1 }],
    });
    await session.models
      .streamSimple(model!, {
        messages: [{ role: "user", content: `again: ${VALUE}`, timestamp: 2 }],
      })
      .result();

    const sent = JSON.stringify(session.requests.slice(before));

    expect(session.requests).toHaveLength(before + 2);
    expect(sent).not.toContain(VALUE);
    expect(sent).toContain(`summarize: my key is ${ref("API_KEY")}`);
    expect(sent).toContain(`again: ${ref("API_KEY")}`);
  });

  it("resolves references in calls a program makes, and gives the program redacted results", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.prompt(
      "Go",
      call("program", { tool: "record", args: { text: `key=${ref("API_KEY")}` } }),
    );

    expect(session.recorded.at(-1)).toEqual({ text: `key=${VALUE}` });

    const result = await session.lastResult();

    expect(result?.text).toContain(`recorded: key=${ref("API_KEY")}`);
    expect(await session.transcript()).not.toContain(VALUE);
  });

  it("stops resolving a Secret after its lifetime", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.advance(SECRET_LIFETIME_MS);
    await session.prompt("Go", call("record", { text: ref("API_KEY") }));

    expect((await session.lastResult())?.text).toContain("expired, was forgotten");
    expect(session.recorded).toEqual([]);
  });

  it("uses the Secrets kept for the Environment like entered ones, and does not forget them", async () => {
    const session = await openSecretsHarness(
      [],
      [{ name: "DATABASE_URL", value: VALUE, scope: "environment", build: false }],
    );

    await session.prompt(
      "Go",
      call("bash", { command: `echo url=$${env("DATABASE_URL")}` }),
      call("secret_list", {}),
    );

    expect(session.execs.at(-1)?.env[env("DATABASE_URL")]).toBe(VALUE);
    expect((await session.lastResult())?.text).toContain(
      "DATABASE_URL: kept for this Environment.",
    );

    await session.prompt("Go", call("secret_forget", { names: ["DATABASE_URL"] }));

    expect((await session.lastResult())?.text).toContain("which a Session cannot forget");

    await session.prompt("Go", call("record", { text: ref("DATABASE_URL") }));

    expect(session.recorded.at(-1)).toEqual({ text: VALUE });
    expect(await session.transcript()).not.toContain(VALUE);
    expect(JSON.stringify(session.requests)).not.toContain(VALUE);
    expect(session.dump()).not.toContain(VALUE);
  });

  it("forgets a Secret on request", async () => {
    const session = await openSecretsHarness();

    await session.hold({ API_KEY: VALUE });
    await session.prompt("Go", call("secret_list", {}));

    expect((await session.lastResult())?.text).toContain("API_KEY: held until");

    await session.prompt("Go", call("secret_forget", { names: ["API_KEY"] }));

    expect((await session.lastResult())?.text).toBe("API_KEY: forgotten.");

    await session.prompt("Go", call("record", { text: ref("API_KEY") }));

    expect((await session.lastResult())?.isError).toBe(true);
    expect(session.dump()).not.toContain("ciphertext");
  });

  it("keeps secret_ask and secret_forget from child agents, which still list the root's Secrets", () => {
    const resolved = resolveTools(
      undefined,
      ["bash", "secret_ask", "secret_list", "secret_forget"],
      DEFAULT_TOOLSETS,
    );

    expect(resolved).toMatchObject({ success: { tools: ["bash", "secret_list"] } });
  });
});
