// Secrets through real runs: the agent asks, the owner answers in the masked form, and tools use the value through
// references, while the value never reaches the transcript, tool output, or the model. pi-durable's Harness is
// Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off schemaSync:off
import { getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { decodeProgramCall, runSized } from "./program.fixture.ts";
import { MAX_NESTED_STRUCTURED_OUTPUT_BYTES } from "./result-bounds.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";
import {
  type KeepRequest,
  type KeepResult,
  type KeptSecret,
  SECRET_LIFETIME_MS,
  secretEnvName,
  secretReference,
} from "./secrets.ts";
import { call, openSecretsHarness } from "./secrets/harness.fixture.ts";
import { AskOutput, ForgetOutput, ListOutput } from "./secrets/outputs.ts";
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

  describe("keeping what the owner enters", () => {
    /** Keeps what it is handed in the fixture's Registry, as the Session's hook saves it. */
    const keeping = (request: KeepRequest, registry: { secrets: KeptSecret[] }) => {
      for (const { name, value } of request.secrets) {
        registry.secrets.push({ name, value, scope: request.scope, build: false });
      }

      return request.secrets.map(({ name }): KeepResult => ({ name, kept: true }));
    };

    it("offers the agent's suggestion in the request, and tells it the scope the owner chose, never the value", async () => {
      const session = await openSecretsHarness([], [], keeping);

      const running = session.prompt(
        "Go",
        call("secret_ask", { names: ["API_KEY"], reason: "deploy", keep: "environment" }),
      );

      // The owner changes the pre-selected scope in the form.
      const ask = await session.enter({ API_KEY: VALUE }, "all");

      await running;

      expect(ask).toMatchObject({ names: ["API_KEY"], keep: "environment" });

      const result = await session.lastResult();

      expect(result?.text).toContain("API_KEY: provided and kept Global");
      expect(result?.text).toContain("it does not expire");
      expect(result?.text).not.toContain(VALUE);
      expect(session.registry.secrets).toEqual([
        { name: "API_KEY", value: VALUE, scope: "every", build: false },
      ]);
      expect(await session.transcript()).not.toContain(VALUE);
      expect(JSON.stringify(session.requests)).not.toContain(VALUE);
      expect(session.dump()).not.toContain(VALUE);
    });

    it("lists a Secret it kept as kept, and uses it after the 15 minutes an entered one lasts", async () => {
      const session = await openSecretsHarness([], [], keeping);
      const running = session.prompt("Go", call("secret_ask", { names: ["API_KEY"] }));

      await session.enter({ API_KEY: VALUE }, "environment");
      await running;
      await session.advance(SECRET_LIFETIME_MS + 1);
      await session.prompt("Go", call("secret_list", {}));

      expect((await session.lastResult())?.text).toContain("API_KEY: kept for this Environment.");

      await session.prompt("Go", call("bash", { command: `echo $${env("API_KEY")}` }));

      expect(session.execs.at(-1)?.env[env("API_KEY")]).toBe(VALUE);
    });

    it("holds it for the Session, as it always did, when the agent asks for nothing and the owner keeps nothing", async () => {
      const session = await openSecretsHarness([], [], keeping);
      const running = session.prompt("Go", call("secret_ask", { names: ["API_KEY"] }));

      const ask = await session.enter({ API_KEY: VALUE });

      await running;

      expect(ask).not.toHaveProperty("keep");
      expect((await session.lastResult())?.text).toContain("Held for this Session only");
      expect(session.registry.secrets).toEqual([]);

      await session.advance(SECRET_LIFETIME_MS + 1);
      await session.prompt("Go", call("record", { text: ref("API_KEY") }));

      expect((await session.lastResult())?.isError).toBe(true);
    });

    it("says why the Secret was held for the Session only when it could not be kept", async () => {
      const session = await openSecretsHarness([], [], (request) =>
        request.secrets.map(({ name }): KeepResult => ({
          name,
          kept: false,
          problem: "At most 100 Secrets are kept for this environment",
        })),
      );

      const running = session.prompt("Go", call("secret_ask", { names: ["API_KEY"] }));

      await session.enter({ API_KEY: VALUE }, "environment");
      await running;

      const text = (await session.lastResult())?.text;

      expect(text).toContain("The user chose to keep it, but it could not be kept: At most 100");
      expect(text).toContain(`Use $${env("API_KEY")}`);
    });
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

  describe("what programs get", () => {
    const decodeAsk = Schema.decodeUnknownSync(AskOutput);
    const decodeList = Schema.decodeUnknownSync(ListOutput);
    const decodeForget = Schema.decodeUnknownSync(ForgetOutput);

    /** What a program got of calling `tool` with `args`, as the `program` stand-in reports it. */
    const nested = async (
      session: Awaited<ReturnType<typeof openSecretsHarness>>,
      tool: string,
      args: JsonObject,
    ) => {
      await session.prompt("Go", call("program", { tool, args }));

      return decodeProgramCall((await session.lastResult())?.text ?? "");
    };

    it("gives a program how to reference each Secret asked for, and never a value", async () => {
      const session = await openSecretsHarness();

      const running = session.prompt(
        "Go",
        call("program", { tool: "secret_ask", args: { names: ["API_KEY", "OPTIONAL"] } }),
      );

      await session.enter({ API_KEY: VALUE });
      await running;

      const asked = decodeProgramCall((await session.lastResult())?.text ?? "");

      expect(asked).toMatchObject({ isError: false, diagnostics: [] });
      expect(decodeAsk(asked.structuredOutput)).toMatchObject({
        cancelled: false,
        secrets: [
          { name: "API_KEY", status: "provided", env: env("API_KEY"), reference: ref("API_KEY") },
          { name: "OPTIONAL", status: "skipped", env: null, reference: null, expires_at: null },
        ],
      });
      expect(JSON.stringify(asked)).not.toContain(VALUE);
    });

    it("says the owner cancelled", async () => {
      const session = await openSecretsHarness();

      const running = session.prompt(
        "Go",
        call("program", { tool: "secret_ask", args: { names: ["API_KEY"] } }),
      );

      await session.enter(null);
      await running;

      const asked = decodeProgramCall((await session.lastResult())?.text ?? "");

      expect(asked).toMatchObject({ isError: false, diagnostics: [] });
      expect(decodeAsk(asked.structuredOutput)).toMatchObject({
        cancelled: true,
        secrets: [{ name: "API_KEY", status: "cancelled" }],
      });
    });

    it("says where the owner chose to keep a Secret", async () => {
      const session = await openSecretsHarness([], [], (request, registry) => {
        for (const { name, value } of request.secrets) {
          registry.secrets.push({ name, value, scope: request.scope, build: false });
        }

        return request.secrets.map(({ name }): KeepResult => ({ name, kept: true }));
      });

      const running = session.prompt(
        "Go",
        call("program", { tool: "secret_ask", args: { names: ["API_KEY"] } }),
      );

      await session.enter({ API_KEY: VALUE }, "all");
      await running;

      const asked = decodeProgramCall((await session.lastResult())?.text ?? "");

      expect(decodeAsk(asked.structuredOutput).secrets).toMatchObject([
        { name: "API_KEY", status: "kept", scope: "every", expires_at: null },
      ]);
    });

    it("lists what is held and what is kept, then forgets what can be", async () => {
      const session = await openSecretsHarness(
        [],
        [{ name: "DATABASE_URL", value: VALUE, scope: "environment", build: false }],
      );

      await session.hold({ API_KEY: VALUE.toUpperCase() });

      const listed = await nested(session, "secret_list", {});

      expect(listed).toMatchObject({ isError: false, diagnostics: [] });
      expect(decodeList(listed.structuredOutput)).toMatchObject({
        secrets_truncated: false,
        secrets: [
          { name: "API_KEY", status: "held", scope: null, env: env("API_KEY") },
          {
            name: "DATABASE_URL",
            status: "kept",
            scope: "environment",
            expires_at: null,
            reference: ref("DATABASE_URL"),
          },
        ],
      });
      expect(decodeList(listed.structuredOutput).secrets[0]?.expires_at).toEqual(
        expect.stringMatching(/^\d{4}-/),
      );

      const none = await nested(session, "secret_list", { query: "nothing like it" });

      expect(decodeList(none.structuredOutput)).toEqual({ secrets: [], secrets_truncated: false });

      const forgotten = await nested(session, "secret_forget", {
        names: ["API_KEY", "DATABASE_URL", "MISSING"],
      });

      expect(forgotten).toMatchObject({ isError: false, diagnostics: [] });
      expect(decodeForget(forgotten.structuredOutput)).toEqual({
        secrets_truncated: false,
        secrets: [
          { name: "API_KEY", status: "forgotten", scope: null },
          { name: "DATABASE_URL", status: "kept", scope: "environment" },
          { name: "MISSING", status: "not_held", scope: null },
        ],
      });
    });

    it("cuts a long list of Secrets, and the call still succeeds", async () => {
      const kept: KeptSecret[] = Array.from({ length: 4000 }, (_, index) => ({
        name: `KEPT_SECRET_${String(index).padStart(5, "0")}_${"X".repeat(40)}`,
        value: `value-${index}-0123456789`,
        scope: "environment",
        build: false,
      }));

      const session = await openSecretsHarness([], kept);
      const [got] = await runSized([session.extension], [["secret_list", {}]]);

      // The text is cut too, which pi-durable says in a diagnostic: the value is what is under test.
      expect(got).toMatchObject({
        isError: false,
        truncated: { secrets_truncated: true },
      });
      expect(got?.lengths.secrets).toBeGreaterThan(0);
      expect(got?.lengths.secrets).toBeLessThan(kept.length);
      expect(got?.bytes).toBeLessThan(MAX_NESTED_STRUCTURED_OUTPUT_BYTES);
    });

    it("cuts a long list of names forgotten, and the call still succeeds", async () => {
      const session = await openSecretsHarness();

      const names = Array.from(
        { length: 4000 },
        (_, index) => `NAME_${String(index).padStart(5, "0")}_${"X".repeat(60)}`,
      );

      const [got] = await runSized([session.extension], [["secret_forget", { names }]]);

      // The text is cut too, which pi-durable says in a diagnostic: the value is what is under test.
      expect(got).toMatchObject({ isError: false, truncated: { secrets_truncated: true } });
      expect(got?.lengths.secrets).toBeGreaterThan(0);
      expect(got?.lengths.secrets).toBeLessThan(names.length);
      expect(got?.bytes).toBeLessThan(MAX_NESTED_STRUCTURED_OUTPUT_BYTES);
    });

    // The program stand-in's own result is redacted too, which would hide a value left in the nested one: so the nested
    // call's whole result is kept by a stand-in that calls the tool beside it.
    it("redacts a Secret's value from a tool's structured output before the program sees it", async () => {
      const relayed: Array<{ isError?: boolean; structuredOutput?: Schema.Json }> = [];

      const leaky = defineExtension({
        name: "leaky",
        tools: [
          defineTool({
            name: "leaky",
            description: "Return a Secret's value in its structured output",
            parameters: Type.Object({}),
            structuredOutputSchema: Type.Object({
              token: Type.String(),
              nested: Type.Array(Type.Object({ line: Type.String() })),
            }),
            execute: async () => ({
              output: [{ type: "text", text: "leaked" }],
              structuredOutput: {
                token: VALUE,
                nested: [{ line: `Authorization: Bearer ${VALUE}` }],
              },
            }),
          }),
          defineTool({
            name: "relay",
            description: "Call a tool and keep what the program got of it",
            parameters: Type.Object({ tool: Type.String() }),
            execute: async ({ tool }, api, context) => {
              relayed.push(await api.executeTool(tool, {}, context));

              return { output: [{ type: "text", text: "relayed" }] };
            },
          }),
        ],
      });

      const session = await openSecretsHarness([leaky]);

      await session.hold({ API_KEY: VALUE });
      await session.prompt("Go", call("relay", { tool: "leaky" }));

      expect(relayed).toHaveLength(1);
      expect(relayed[0]?.isError).not.toBe(true);
      expect(relayed[0]?.structuredOutput).toEqual({
        token: ref("API_KEY"),
        nested: [{ line: `Authorization: Bearer ${ref("API_KEY")}` }],
      });
      expect(JSON.stringify(relayed)).not.toContain(VALUE);
      expect(await session.transcript()).not.toContain(VALUE);
    });
  });
});
