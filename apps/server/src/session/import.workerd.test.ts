// The Session object's side of a Session import, against real Durable Object storage (`docs/architecture/mcp-endpoint.md`
// → Session import → The import channel): slices kept in SQLite, `importing` until the end, the notice last, the text sent
// after it, and the expiry. workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { MAX_MCP_INPUT_BYTES } from "@cloudpid/protocol";
import type { ApiResult, SessionVia, StageImportBegin } from "@cloudpid/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { destroyedWorkspaces, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const via: SessionVia = { auth: "oauth", client: { name: "claude-code" } };

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

const workspace = { branch: "feature/x", repos: [{ name: "app", directory: "/workspace/app" }] };

/** The value of an `ok` result: a failure fails the test with its error. */
const okValue = <T>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

/** The error of a failed result: an `ok` one fails the test. */
const errorOf = <T>(result: ApiResult<T>) => {
  if (result.ok) throw new Error("The call was expected to fail.");

  return result.error;
};

const sha256 = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

const header = JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/home/o/app" });

const userLine = (text: string) =>
  JSON.stringify({
    type: "message",
    id: "1",
    parentId: null,
    message: { role: "user", content: text, timestamp: 1 },
  });

const assistantLine = (text: string, tokens = 10) =>
  JSON.stringify({
    type: "message",
    id: "2",
    parentId: "1",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: tokens, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 5 },
      stopReason: "stop",
      timestamp: 2,
    },
  });

/** A small pi file: a header, a question and its answer, and a line of a kind the baseline drops. */
const file = [
  header,
  userLine("What does the build do?"),
  assistantLine("It compiles."),
  JSON.stringify({ type: "model_change", id: "m" }),
].join("\n");

type Stub = DurableObjectStub<TestSession>;

const begin = async (stub: Stub, text: string, request: Partial<StageImportBegin> = {}) =>
  okValue(
    await stub.stageBegin({
      size_bytes: new TextEncoder().encode(text).length,
      workspace,
      via,
      ...request,
    }),
  );

const send = async (stub: Stub, text: string, offset = 0) =>
  okValue(await stub.stageAppend({ offset, data: text }));

const entriesOf = (stub: Stub) =>
  runInDurableObject(stub, (instance: TestSession) => instance.rootEntries());

describe("a Session import in the Session object", () => {
  it("shows importing, refuses messages and moves, and keeps the slices where they end", async () => {
    const stub = fresh();
    const first = file.slice(0, 40);
    const rest = file.slice(40);

    const staged = await begin(stub, file);

    expect(staged.received).toBe(0);
    expect(staged.expires_at).toBeGreaterThan(Date.now());
    expect(okValue(await stub.mcpStatus()).status).toBe("importing");

    expect(errorOf(await stub.mcpSubmit({ input: "hello", via }))).toMatchObject({
      code: "session_importing",
    });
    await expect(
      runInDurableObject(stub, (instance: TestSession) =>
        instance.forkInto("fork-of-an-import", { quiet: "none" }),
      ),
    ).rejects.toThrow(/still importing/u);

    // The tree does not move either (`/tree`).
    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        // SAFETY: the move is refused before the entry is looked up, so no entry has to exist.
        instance.navigate({ entryId: 1 as never, position: "at" }),
      ),
    ).toMatchObject({ failure: expect.stringMatching(/still importing/u) });

    expect((await send(stub, first)).received).toBe(first.length);

    // A slice that does not start where the held bytes end says where to send from.
    expect(errorOf(await stub.stageAppend({ offset: 100, data: rest }))).toMatchObject({
      code: "offset_mismatch",
      details: { received: first.length },
    });

    // A slice sent again, whose answer was lost, is held already: nothing changes.
    expect((await send(stub, first)).received).toBe(first.length);
    expect((await send(stub, rest, first.length)).received).toBe(file.length);
  });

  it("refuses a begin that goes past what it declared, and a slice that is too long", async () => {
    const stub = fresh();

    await begin(stub, "abc");

    expect(errorOf(await stub.stageAppend({ offset: 0, data: "abcdef" }))).toMatchObject({
      code: "import_too_large",
    });
  });

  it("asks for the rest when finish comes early, and refuses a wrong checksum", async () => {
    const stub = fresh();

    await begin(stub, file);
    await send(stub, file.slice(0, 20));

    expect(errorOf(await stub.stageFinish({ sha256: await sha256(file) }))).toMatchObject({
      code: "offset_mismatch",
      details: { received: 20 },
    });

    await send(stub, file.slice(20), 20);

    const mismatch = errorOf(await stub.stageFinish({ sha256: await sha256("something else") }));

    expect(mismatch).toMatchObject({ code: "checksum_mismatch" });
    // The bytes are kept: it does not tell the Local agent to begin again, only that the right checksum finishes it.
    expect(mismatch.message).toMatch(/bytes are kept/u);

    // The bytes are kept: the right checksum finishes it.
    expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).status).not.toBe(
      "importing",
    );
  });

  it("translates on finish: the notice last, the text sent after it, a title, and the Session open", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["On it"]));
    await begin(stub, file, { text: "Carry on with the build", model: "anthropic/gone" });
    await send(stub, file);

    const finished = okValue(await stub.stageFinish({ sha256: await sha256(file) }));

    expect(finished.summary).toMatchObject({ dropped: { model_change: 1 } });
    // The model is not the owner's: the default is used, and the Local agent is told.
    expect(finished.warnings.join(" ")).toMatch(/anthropic\/gone/u);
    expect(finished.cursor).toBeDefined();

    const entries = await entriesOf(stub);
    const texts = entries.map((entry) => entry.text);
    const notice = texts.findIndex((text) => text.includes("[cloudpid import]"));

    expect(texts[0]).toBe("What does the build do?");
    expect(texts[1]).toBe("It compiles.");
    expect(notice).toBe(2);
    // The text came after the notice, as the Local agent's message.
    expect(texts.indexOf("Carry on with the build")).toBeGreaterThan(notice);

    // The Session is open: it ran the text, and is idle again.
    await vi.waitFor(async () => expect(okValue(await stub.mcpStatus()).status).toBe("idle"), {
      timeout: 10_000,
    });

    // Nothing of the bytes or the instruction is left.
    const state = await runInDurableObject(stub, (instance: TestSession) => instance.importState());

    expect(state.record?.phase).toBe("ended");
    expect(state.record?.text).toBeUndefined();
    expect(state.received).toBe(0);
  });

  it("keeps a model the owner has, without a warning", async () => {
    const stub = fresh();

    await begin(stub, file, { model: "anthropic/claude-sonnet-5-5", thinking: "high" });
    await send(stub, file);

    const finished = okValue(await stub.stageFinish({ sha256: await sha256(file) }));

    expect(finished.warnings).toEqual([]);
    expect(okValue(await stub.mcpStatus()).status).not.toBe("importing");
  });

  it("warns when the imported context is near the model's window", async () => {
    const stub = fresh();
    const big = [header, userLine("hello"), assistantLine("ok", 500_000)].join("\n");

    await begin(stub, big);
    await send(stub, big);

    const finished = okValue(await stub.stageFinish({ sha256: await sha256(big) }));

    expect(finished.warnings.join(" ")).toMatch(/context_over_window/u);
  });

  it("fails a file that is not a pi Session, and says so on finish until it is cancelled", async () => {
    const stub = fresh();
    const text = "this is not json\n";

    await begin(stub, text);
    await send(stub, text);

    expect(errorOf(await stub.stageFinish({ sha256: await sha256(text) })).message).toMatch(
      /header/u,
    );
    expect(okValue(await stub.mcpStatus()).status).toBe("importing");
    expect(errorOf(await stub.stageFinish({ sha256: await sha256(text) })).code).toBe(
      "invalid_argument",
    );
  });

  it("answers `importing` when the translation outlasts finish's wait, and ends it afterwards", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.importFinishWait(0));
    await begin(stub, file);
    await send(stub, file);

    const finished = okValue(await stub.stageFinish({ sha256: await sha256(file) }));

    expect(["importing", "idle"]).toContain(finished.status);

    await vi.waitFor(
      async () => expect(okValue(await stub.mcpStatus()).status).not.toBe("importing"),
      { timeout: 10_000 },
    );

    // Finish again after the end: the same answer.
    expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).status).not.toBe(
      "importing",
    );
  });

  it("expires after an hour with no slice: the alarm asks for the Session to be deleted", async () => {
    const stub = fresh();

    await begin(stub, file);
    await send(stub, file.slice(0, 10));
    await runInDurableObject(stub, (instance: TestSession) => instance.expireImport());

    // Inside a call it only says so: the deletion would cut the call off.
    expect(errorOf(await stub.stageAppend({ offset: 10, data: file.slice(10) }))).toMatchObject({
      code: "import_expired",
    });
    expect((await runInDurableObject(stub, (i: TestSession) => i.importState())).discards).toBe(0);

    await runInDurableObject(stub, (instance: TestSession) => instance.alarm());

    const state = await runInDurableObject(stub, (instance: TestSession) => instance.importState());

    expect(state.discards).toBe(1);
    expect(state.received).toBe(0);
  });

  it("tells the Local agent when the instruction could not be sent, and still ends the import", async () => {
    const stub = fresh();

    await begin(stub, file, { text: "x".repeat(MAX_MCP_INPUT_BYTES + 1) });
    await send(stub, file);

    const finished = okValue(await stub.stageFinish({ sha256: await sha256(file) }));

    expect(finished.warnings.join(" ")).toMatch(/instruction was not sent.*session_send/u);
    expect(finished.summary).toBeDefined();
    expect(okValue(await stub.mcpStatus()).status).not.toBe("importing");
  });

  describe("a translation that does not end", () => {
    const fails = async (stub: Stub) => {
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.importTranslationFails(true),
      );
      await begin(stub, file);
      await send(stub, file);
    };

    const state = (stub: Stub) =>
      runInDurableObject(stub, (instance: TestSession) => instance.importState());

    const alarm = (stub: Stub) =>
      runInDurableObject(stub, (instance: TestSession) => instance.alarm());

    it("counts each start before it runs, and gives the import up after five", async () => {
      const stub = fresh();

      await fails(stub);

      // The fiber failed: it is still finishing, with the attempt kept in the record.
      expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).status).toBe(
        "importing",
      );
      expect((await state(stub)).record).toMatchObject({ phase: "finishing", attempts: 1 });

      for (let attempt = 2; attempt <= 5; attempt++) {
        await alarm(stub);
        await vi.waitFor(async () => expect((await state(stub)).record?.attempts).toBe(attempt));
      }

      // The sixth would be over the cap: it fails the import, whose bytes and text go, instead of starting.
      await alarm(stub);

      expect((await state(stub)).record).toMatchObject({ phase: "failed", attempts: 5 });
      expect((await state(stub)).received).toBe(0);
      expect(errorOf(await stub.stageFinish({ sha256: await sha256(file) })).message).toMatch(
        /could not be completed.*Cancel it/u,
      );
    });

    it("can be cancelled while it finishes, and its bytes go", async () => {
      const stub = fresh();

      await fails(stub);
      await stub.stageFinish({ sha256: await sha256(file) });

      expect((await state(stub)).record?.phase).toBe("finishing");
      expect(okValue(await stub.stageCancel())).toEqual({ cancelled: true });
      expect((await state(stub)).record).toMatchObject({ phase: "cancelled" });
      expect((await state(stub)).received).toBe(0);
    });

    it("expires while it finishes: the alarm asks for the Session to be deleted", async () => {
      const stub = fresh();

      await fails(stub);
      await stub.stageFinish({ sha256: await sha256(file) });
      await runInDurableObject(stub, (instance: TestSession) => instance.expireImport());
      await alarm(stub);

      expect((await state(stub)).discards).toBe(1);
    });
  });

  describe("an import whose entries are in the Session", () => {
    const state = (stub: Stub) =>
      runInDurableObject(stub, (instance: TestSession) => instance.importState());

    const alarm = (stub: Stub) =>
      runInDurableObject(stub, (instance: TestSession) => instance.alarm());

    it("is not given up or deleted while the Registry cannot be told, and ends once it can", async () => {
      const stub = fresh();
      const failures = 7;

      await runInDurableObject(stub, (instance: TestSession) =>
        instance.importEndedFails(failures),
      );
      await begin(stub, file, { text: "Carry on" });
      await send(stub, file);

      // The entries went in, then telling the Registry failed: the import waits, with the attempt that wrote them counted.
      expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).status).toBe(
        "importing",
      );
      expect((await state(stub)).record).toMatchObject({
        phase: "finishing",
        attempts: 1,
        held: true,
      });
      expect((await entriesOf(stub)).length).toBeGreaterThan(0);

      // Even an hour on, with more failures than attempts allowed, the Session is not deleted and not failed.
      await runInDurableObject(stub, (instance: TestSession) => instance.expireImport());

      for (let left = failures - 2; left >= 0; left--) {
        await vi.waitFor(
          async () => {
            await alarm(stub);

            expect((await state(stub)).endedFailsLeft).toBe(left);
          },
          { timeout: 10_000 },
        );

        expect((await state(stub)).record).toMatchObject({
          phase: "finishing",
          attempts: 1,
          held: true,
        });
        expect((await state(stub)).discards).toBe(0);
      }

      // The Registry answers at last: the import ends, once, with the instruction sent once.
      await vi.waitFor(
        async () => {
          await alarm(stub);

          expect((await state(stub)).record?.phase).toBe("ended");
        },
        { timeout: 10_000 },
      );

      expect((await state(stub)).discards).toBe(0);
      expect((await entriesOf(stub)).filter((entry) => entry.text === "Carry on")).toHaveLength(1);
      expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).summary).toBeDefined();
    });

    it("is not cancelled over an end it reached first: the cancel is refused and the import stays ended", async () => {
      const stub = fresh();

      await runInDurableObject(stub, (instance: TestSession) => {
        instance.importEndedGate(true);
        instance.importFinishWait(0);
      });
      await begin(stub, file);
      await send(stub, file);

      // The translation is alive, held at the Registry's answer.
      expect(okValue(await stub.stageFinish({ sha256: await sha256(file) })).status).toBe(
        "importing",
      );
      expect((await state(stub)).record).toMatchObject({ phase: "finishing", held: true });

      // The cancel read the import as finishing and stops the translation, which cannot stop inside its end.
      const cancelled = stub.stageCancel();

      await new Promise((resolve) => setTimeout(resolve, 100));
      await runInDurableObject(stub, (instance: TestSession) => instance.importEndedGate(false));

      expect(errorOf(await cancelled)).toMatchObject({
        code: "invalid_argument",
        message: expect.stringMatching(/has ended/u),
      });
      expect((await state(stub)).record?.phase).toBe("ended");
      expect((await state(stub)).discards).toBe(0);
    });
  });

  describe("an import that expires, with the Session's own deletion", () => {
    const DISCARD_REGISTRY = "import-discard-registry";

    it("leaves no Registry record, no Workspace and no storage, and a retried alarm, on this instance and a new one, finds nothing to run", async () => {
      const registry = env.REGISTRIES.getByName(DISCARD_REGISTRY);
      const session = "import-session-1";

      expect(
        await registry.createSession(
          {
            id: session,
            title: null,
            workspace: {
              kind: "new",
              id: "0a0b0c0d",
              environment: DEFAULT_ENVIRONMENT,
              branch: "feature/x",
              base: null,
            },
            marks: { kind: "import", auth: "oauth" },
          },
          1_000,
        ),
      ).toMatchObject({ id: session, importing: true });

      const stub = fresh();

      await runInDurableObject(stub, (instance: TestSession) =>
        instance.importRegistry(session, DISCARD_REGISTRY),
      );
      await begin(stub, file);
      await send(stub, file.slice(0, 10));
      await runInDurableObject(stub, (instance: TestSession) => instance.expireImport());

      const empty = () =>
        runInDurableObject(stub, async (_instance: TestSession, state) => ({
          keys: Array.from(state.storage.kv.list(), ([key]) => key),
          tables: state.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
            )
            .toArray(),
          alarm: await state.storage.getAlarm(),
        }));

      await runInDurableObject(stub, (instance: TestSession) => instance.alarm());

      // The Registry's record and the Workspace first, the object's own storage last.
      expect(await registry.getSession(session)).toBeNull();
      expect(await registry.getWorkspace("0a0b0c0d")).toBeNull();
      expect(destroyedWorkspaces.get(stub.id.toString())).toHaveLength(1);
      expect(await empty()).toEqual({ keys: [], tables: [], alarm: null });

      // An alarm that is retried over the wiped storage runs nothing and brings nothing back.
      await runInDurableObject(stub, (instance: TestSession) => instance.alarm());
      await runInDurableObject(stub, (instance: TestSession) => instance.alarm());

      expect(await empty()).toEqual({ keys: [], tables: [], alarm: null });
      expect(destroyedWorkspaces.get(stub.id.toString())).toHaveLength(1);

      // The same over a new instance (the object was evicted before the alarm was retried). Waking it opens the
      // Harness's own empty tables and notes what it reports; the alarm over them adds nothing, and nothing of the
      // import, the Session or its Workspace is made or run again.
      await evictDurableObject(stub);
      await runInDurableObject(stub, () => undefined);

      const woken = await empty();

      expect(woken.alarm).toBeNull();
      expect(woken.tables.every((table) => table.name.startsWith("pi_"))).toBe(true);

      await runInDurableObject(stub, (instance: TestSession) => instance.alarm());

      expect(await empty()).toEqual(woken);
      expect(await registry.getSession(session)).toBeNull();
      expect(await registry.getWorkspace("0a0b0c0d")).toBeNull();
      expect(destroyedWorkspaces.get(stub.id.toString())).toHaveLength(1);
    });
  });

  it("cancels: the bytes go, and later calls find nothing to import", async () => {
    const stub = fresh();

    await begin(stub, file, { text: "later" });
    await send(stub, file.slice(0, 10));

    expect(okValue(await stub.stageCancel())).toEqual({ cancelled: true });
    expect(errorOf(await stub.stageAppend({ offset: 10, data: "x" })).code).toBe("not_found");

    const state = await runInDurableObject(stub, (instance: TestSession) => instance.importState());

    expect(state.received).toBe(0);
    expect(state.record?.text).toBeUndefined();
  });

  it("answers a begin sent again with the import as it stands", async () => {
    const stub = fresh();

    await begin(stub, file);
    await send(stub, file.slice(0, 10));

    expect((await begin(stub, file)).received).toBe(10);
  });
});
