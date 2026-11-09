// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off
// A webhook Trigger's object over real storage and alarms (`docs/architecture/triggers.md` → Webhooks, → Testing): its
// secrets, the checks of each delivery in order, what it counts and keeps, the bot-loop guard, a repeat, rotation and
// Fire again. The Registry's real `admitFire` runs behind it; only the Sessions' `fire` is scripted.
import {
  DEFAULT_ENVIRONMENT,
  type EnvironmentTriggerInput,
  MAX_DELIVERY_BODY_BYTES,
  MAX_KEPT_BODY_BYTES,
  type TriggerMatch,
} from "@cloudpid/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type * as Types from "effect/Types";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestTrigger } from "./object.fixture.ts";
import type { Delivery, DeliveryHeaders } from "./object.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
      readonly TRIGGERS: DurableObjectNamespace<TestTrigger>;
    }
  }
}

const DAY = 24 * 60 * 60_000;

/**
 * 8:00 UTC on a day a week after the real clock, as `object.workerd.test.ts` has it: it follows the real clock, since
 * workerd runs an alarm set in the past at once.
 */
const start = (() => {
  const day = new Date(Date.now() + 7 * DAY);

  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8);
})();

/** The UTC day of `at`, as the per-day counts name it. */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

const encoder = new TextEncoder();

/** `text` as the bytes a delivery carries. */
const bytes = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(encoder.encode(text));

let counter = 0;

const webhook = (format: "github" | "standard", match?: TriggerMatch): EnvironmentTriggerInput => ({
  kind: "environment",
  environment: DEFAULT_ENVIRONMENT,
  name: "On events",
  message: "Look at the event.",
  source: match === undefined ? { type: "webhook", format } : { type: "webhook", format, match },
});

/** A webhook Trigger made in a new Registry at `start`, and its object, synced at `start`. */
const made = async (format: "github" | "standard" = "github", match?: TriggerMatch) => {
  const id = `w${String(counter++)}`;
  const registry = env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

  expect(await registry.createTrigger(id, webhook(format, match), start)).toMatchObject({
    status: "ok",
  });

  const trigger = env.TRIGGERS.getByName(`trigger:${id}`);

  await trigger.use(registry.id.toString());
  await trigger.setNow(start);
  await trigger.sync();

  const answer = await trigger.reveal();

  if (answer.status !== "ok") throw new Error("A webhook Trigger has no secrets");

  return { id, registry, trigger, ...answer.secrets };
};

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const hmac = async (secret: string, message: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]),
    message,
  );

type GitHubSent = {
  readonly event?: string;
  readonly delivery?: string;
  readonly contentType?: string | undefined;
  readonly signWith?: string;
  readonly signature?: string | null;
};

/** A GitHub delivery of `body`, signed with `secret` unless `signature` says otherwise. */
const githubBytes = async (
  token: string,
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  sent: GitHubSent = {},
): Promise<Delivery> => {
  const signature =
    sent.signature === undefined
      ? `sha256=${hex(await hmac(sent.signWith ?? secret, body))}`
      : sent.signature;

  const headers: Types.Mutable<DeliveryHeaders> = {
    contentType: "contentType" in sent ? sent.contentType : "application/json",
    event: sent.event ?? "issues",
    delivery: sent.delivery ?? `d-${String(counter++)}`,
  };

  if (signature !== null) headers.signature = signature;

  return { token, headers, body, size: body.length };
};

/** A GitHub delivery of `text`, signed with `secret` unless `signature` says otherwise. */
const github = (token: string, secret: string, text: string, sent: GitHubSent = {}) =>
  githubBytes(token, secret, bytes(text), sent);

/** A Standard Webhooks delivery of `text` sent at `at`, id `webhookId`. */
const standard = async (
  token: string,
  rawSecret: string,
  text: string,
  at: number,
  options: { readonly id?: string; readonly sentAt?: number } = {},
): Promise<Delivery> => {
  const body = bytes(text);
  const id = options.id ?? `msg_${String(counter++)}`;
  const timestamp = String(Math.floor((options.sentAt ?? at) / 1000));
  const signed = bytes(`${id}.${timestamp}.${text}`);
  const digest = btoa(String.fromCharCode(...new Uint8Array(await hmac(rawSecret, signed))));

  return {
    token,
    body,
    size: body.length,
    headers: {
      contentType: "application/json",
      webhookId: id,
      webhookTimestamp: timestamp,
      webhookSignature: `v1,${digest}`,
    },
  };
};

/** The secret `standard` Triggers sign with: `reveal` shows it as `whsec_<base64 of the key>`. */
const keyOfShown = (shown: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(shown.slice("whsec_".length)), (c) => c.charCodeAt(0)),
  );

const tables = (trigger: DurableObjectStub<TestTrigger>) =>
  runInDurableObject(trigger, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name),
  );

const issue = (action = "opened", login = "octocat") =>
  JSON.stringify({ action, issue: { number: 7, title: "It broke" }, sender: { login } });

describe("a webhook Trigger's secrets", () => {
  it("are made at the object's first sync: 43 base64url characters each, and the same at every reveal", async () => {
    const { token, secret, trigger } = await made();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(secret);
    expect(await trigger.reveal()).toEqual({ status: "ok", secrets: { token, secret } });
    expect(await trigger.sync()).toMatchObject({ definition: { name: "On events" } });
    expect(await trigger.reveal()).toEqual({ status: "ok", secrets: { token, secret } });
  });

  it("show a standard Trigger's Signing secret as whsec_<base64>, which decodes to the key the checks use", async () => {
    const { secret, trigger } = await made("standard");

    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(keyOfShown(secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await trigger.reveal()).toMatchObject({ status: "ok", secrets: { secret } });
  });

  it("are kept sealed: no row of the object's storage holds either as text", async () => {
    const { token, secret, trigger } = await made();

    const rows = await runInDurableObject(trigger, (_instance, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM trigger_secrets").toArray()),
    );

    expect(rows).not.toContain(token);
    expect(rows).not.toContain(secret);
    expect(rows).toContain("ciphertext");
  });

  it("are not made for a Schedule's Trigger", async () => {
    const id = `w${String(counter++)}`;
    const registry = env.REGISTRIES.get(env.REGISTRIES.newUniqueId());

    await registry.createTrigger(
      id,
      {
        kind: "environment",
        environment: DEFAULT_ENVIRONMENT,
        name: "Daily",
        message: "m",
        source: { type: "schedule", cron: "0 9 * * *", zone: "UTC" },
      },
      start,
    );

    const trigger = env.TRIGGERS.getByName(`trigger:${id}`);

    await trigger.use(registry.id.toString());
    await trigger.setNow(start);
    await trigger.sync();

    expect(await trigger.reveal()).toEqual({ status: "none" });
    expect(
      await runInDurableObject(
        trigger,
        (_instance, state) =>
          state.storage.sql.exec("SELECT COUNT(*) AS n FROM trigger_secrets").one().n,
      ),
    ).toBe(0);
  });

  it("are new after a removal that was reverted: its object was wiped, and made again", async () => {
    const { id, registry, token, secret, trigger } = await made();

    await registry.removeTrigger(id);
    await trigger.sync();

    expect(await trigger.reveal()).toEqual({ status: "none" });

    // The revert brings the definition back: the object, reached again, makes its own.
    await registry.createTrigger(id, webhook("github"), start + 1_000);
    await trigger.sync();

    const again = await trigger.reveal();

    if (again.status !== "ok") throw new Error("The brought back Trigger has no secrets");

    expect(again.secrets.token).not.toBe(token);
    expect(again.secrets.secret).not.toBe(secret);
  });
});

describe("a delivery to a Trigger URL", () => {
  it("to an object with no Trigger is a 404 and writes nothing", async () => {
    const trigger = env.TRIGGERS.getByName(`trigger:ghost${String(counter++)}`);
    const token = "t".repeat(43);

    const delivery: Delivery = {
      token,
      headers: { contentType: "application/json", signature: "sha256=00" },
      body: bytes("{}"),
      size: 2,
    };

    expect(await trigger.deliver(delivery)).toEqual({ status: 404, outcome: "not_found" });
    expect(await tables(trigger)).toEqual([]);
    expect(await trigger.deliveries()).toEqual({ counts: [], lastDeliveryAt: null, pingAt: null });
    expect(await tables(trigger)).toEqual([]);
  });

  it("is checked token first: a wrong token is a 404 and counted, with no signature looked at", async () => {
    const { secret, trigger } = await made();
    const wrong = "w".repeat(43);

    expect(await trigger.deliver(await github(wrong, secret, issue()))).toEqual({
      status: 404,
      outcome: "not_found",
    });
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "not_found", n: 1 },
    ]);
  });

  it("is a 401, counted, with a bad, a missing or another secret's signature, and never reaches the Registry", async () => {
    const { secret, token, trigger } = await made();
    const before = await trigger.registryCalls();

    for (const bad of [
      await github(token, secret, issue(), { signWith: "another secret" }),
      await github(token, secret, issue(), { signature: null }),
      await github(token, secret, issue(), { signature: "sha256=zz" }),
      await github(token, secret, issue(), { signature: `sha1=${"0".repeat(40)}` }),
    ]) {
      expect(await trigger.deliver(bad)).toEqual({ status: 401, outcome: "unauthorized" });
    }

    // A body changed after it was signed.
    const signed = await github(token, secret, issue());

    expect(
      await trigger.deliver({
        ...signed,
        body: bytes(issue("closed")),
        size: issue("closed").length,
      }),
    ).toEqual({ status: 401, outcome: "unauthorized" });

    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "unauthorized", n: 5 },
    ]);
    expect(await trigger.registryCalls()).toEqual(before);
    expect(await trigger.state()).toMatchObject({ pending: 0 });
    expect(await trigger.fireLog()).toEqual([]);
  });

  it("is a 401 for a standard delivery with no headers, another secret, or a timestamp outside 5 minutes", async () => {
    const { secret, token, trigger } = await made("standard");
    const key = keyOfShown(secret);
    const body = JSON.stringify({ type: "invoice.paid" });

    expect(await trigger.deliver(await standard(token, key, body, start))).toEqual({
      status: 200,
      outcome: "accepted",
    });

    for (const bad of [
      await standard(token, "another secret", body, start),
      await standard(token, key, body, start, { sentAt: start - 6 * 60_000 }),
      await standard(token, key, body, start, { sentAt: start + 6 * 60_000 }),
      {
        ...(await standard(token, key, body, start)),
        headers: { contentType: "application/json" },
      },
    ]) {
      expect(await trigger.deliver(bad)).toEqual({ status: 401, outcome: "unauthorized" });
    }

    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "unauthorized", n: 4 },
    ]);
  });

  it("is a 415 for a content type other than JSON, a form or text, and for none", async () => {
    const { secret, token, trigger } = await made();

    for (const contentType of ["application/xml", "multipart/form-data; boundary=x", undefined]) {
      expect(await trigger.deliver(await github(token, secret, "<a/>", { contentType }))).toEqual({
        status: 415,
        outcome: "unsupported",
      });
    }

    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "unsupported", n: 3 },
    ]);
  });

  it("is a 413 over 25 MiB, once the token is right: the body is not read, so no signature is looked at", async () => {
    const { secret, token, trigger } = await made();

    const over: Delivery = {
      token,
      headers: { contentType: "application/json" },
      body: new Uint8Array(0),
      size: MAX_DELIVERY_BODY_BYTES + 1,
    };

    expect(await trigger.deliver(over)).toEqual({ status: 413, outcome: "too_large" });
    expect(await trigger.deliver({ ...over, token: "x".repeat(43) })).toEqual({
      status: 404,
      outcome: "not_found",
    });
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "not_found", n: 1 },
      { day: dayOf(start), outcome: "too_large", n: 1 },
    ]);
    expect(secret).toBeTruthy();
  });

  it("takes 25 MiB, signed, and fires it with its size but no body", async () => {
    const { id, secret, token, trigger } = await made();
    const body = new Uint8Array(MAX_DELIVERY_BODY_BYTES).fill(0x20);

    body.set(bytes('{"action":"opened"}'));

    expect(
      await trigger.deliver(await githubBytes(token, secret, body, { delivery: "big" })),
    ).toEqual({
      status: 200,
      outcome: "accepted",
    });

    await trigger.setNow(start + 1_000);
    await runDurableObjectAlarm(trigger);

    const [sent] = await trigger.sent();

    expect(sent?.request.requestId).toBe(`${id}:big`);
    expect(sent?.request.payload).toEqual({
      format: "github",
      event: "issues",
      action: "opened",
      delivery: "big",
      contentType: "application/json",
      size: MAX_DELIVERY_BODY_BYTES,
    });
  });

  it("keeps a body of 1 MiB whole and fires one byte over without it", async () => {
    const { secret, token, trigger } = await made();

    const padded = (bytes: number, delivery: string) => {
      const head = '{"action":"opened","pad":"';
      const tail = '"}';
      const text = head + "a".repeat(bytes - head.length - tail.length) + tail;

      return github(token, secret, text, { delivery });
    };

    expect(await trigger.deliver(await padded(MAX_KEPT_BODY_BYTES, "edge"))).toMatchObject({
      status: 200,
    });
    expect(await trigger.deliver(await padded(MAX_KEPT_BODY_BYTES + 1, "over"))).toMatchObject({
      status: 200,
    });

    await trigger.setNow(start + 1_000);
    await runDurableObjectAlarm(trigger);

    const payloads = (await trigger.sent()).map((fire) => fire.request.payload);
    const edge = payloads.find((payload) => payload?.delivery === "edge");
    const over = payloads.find((payload) => payload?.delivery === "over");

    expect(edge?.size).toBe(MAX_KEPT_BODY_BYTES);
    expect(edge?.body?.length).toBe(MAX_KEPT_BODY_BYTES);
    expect(over?.size).toBe(MAX_KEPT_BODY_BYTES + 1);
    expect(over).not.toHaveProperty("body");
  });

  it("is a 200 once its Fire is stored, then started by the alarm with the payload, the header and the event in the title", async () => {
    const { id, registry, secret, token, trigger } = await made();
    const at = start + 5_000;

    await trigger.setNow(at);

    expect(
      await trigger.deliver(
        await github(token, secret, issue(), { delivery: "d-1", event: "issues" }),
      ),
    ).toEqual({ status: 200, outcome: "accepted" });

    // Stored, not yet started: the answer does not wait for the Session.
    expect(await trigger.sent()).toEqual([]);
    expect(await trigger.state()).toMatchObject({ pending: 1 });
    expect(await trigger.alarmAt()).toBe(at);

    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toEqual([
      {
        session: "s-1",
        request: {
          trigger: { id, name: "On events" },
          requestId: `${id}:d-1`,
          message: "Look at the event.",
          header: { name: "On events", zone: "UTC", firedAt: at },
          payload: {
            format: "github",
            event: "issues",
            action: "opened",
            delivery: "d-1",
            contentType: "application/json",
            size: issue().length,
            body: issue(),
          },
        },
      },
    ]);
    expect(await trigger.fireLog()).toEqual([
      {
        key: `${id}:d-1`,
        at,
        source: { type: "webhook", delivery: "d-1", event: "issues" },
        outcome: { type: "started", session: "s-1" },
      },
    ]);
    expect((await registry.getSession("s-1"))?.title).toContain("issues");
    expect(await trigger.deliveries()).toEqual({ counts: [], lastDeliveryAt: at, pingAt: null });
  });

  it("fires a standard delivery under its webhook-id, the event its body's type", async () => {
    const { id, secret, token, trigger } = await made("standard");

    await trigger.deliver(
      await standard(
        token,
        keyOfShown(secret),
        JSON.stringify({ type: "invoice.paid", data: {} }),
        start,
        {
          id: "msg_1",
        },
      ),
    );
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toMatchObject([
      {
        request: {
          requestId: `${id}:msg_1`,
          payload: { format: "standard", event: "invoice.paid", delivery: "msg_1" },
        },
      },
    ]);
  });

  it("reads a GitHub form delivery's JSON for `match`, and keeps the form as received", async () => {
    const { secret, token, trigger } = await made("github", { "issue.number": ["7"] });
    const form = `payload=${encodeURIComponent(issue())}`;

    await trigger.deliver(
      await github(token, secret, form, { contentType: "application/x-www-form-urlencoded" }),
    );
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toMatchObject([
      { request: { payload: { body: form, contentType: "application/x-www-form-urlencoded" } } },
    ]);
  });

  it("is answered again, with no second Fire, when the sender sends the same delivery again", async () => {
    const { registry, secret, token, trigger } = await made();
    const one = await github(token, secret, issue(), { delivery: "same" });

    expect(await trigger.deliver(one)).toEqual({ status: 200, outcome: "accepted" });
    expect(await trigger.deliver(one)).toEqual({ status: 200, outcome: "accepted" });
    expect(await trigger.state()).toMatchObject({ pending: 1 });

    await runDurableObjectAlarm(trigger);

    expect(await trigger.deliver(one)).toEqual({ status: 200, outcome: "accepted" });
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toHaveLength(1);
    expect(await trigger.fireLog()).toHaveLength(1);
    expect(await registry.listSessions()).toHaveLength(1);
  });

  it("is recorded skipped while its Trigger is paused, with no Session", async () => {
    const { id, registry, secret, token, trigger } = await made();

    await registry.setTriggerPaused(id, true, start + 1_000);
    await trigger.sync();
    await trigger.setNow(start + 2_000);

    expect(
      await trigger.deliver(await github(token, secret, issue(), { delivery: "p-1" })),
    ).toEqual({
      status: 200,
      outcome: "accepted",
    });
    expect(await trigger.fireLog()).toEqual([
      {
        key: `${id}:p-1`,
        at: start + 2_000,
        source: { type: "webhook", delivery: "p-1", event: "issues" },
        outcome: { type: "skipped", reason: "paused" },
      },
    ]);
    expect(await registry.listSessions()).toEqual([]);
  });

  it("cuts a delivery id too long for a key to a hash", async () => {
    const { id, secret, token, trigger } = await made();

    await trigger.deliver(await github(token, secret, issue(), { delivery: "z".repeat(500) }));
    await runDurableObjectAlarm(trigger);

    const [sent] = await trigger.sent();

    expect(sent?.request.requestId).toMatch(new RegExp(`^${id}:h-[0-9a-f]{64}$`));
  });
});

describe("a Trigger's filter and the bot-loop guard", () => {
  const match = { event: ["issues"], action: ["opened"], "issue.number": ["7"] };

  it("answers a delivery that does not match 200, counts it filtered and starts nothing", async () => {
    const { secret, token, trigger } = await made("github", match);
    const before = await trigger.registryCalls();

    expect(await trigger.deliver(await github(token, secret, issue("closed")))).toEqual({
      status: 200,
      outcome: "filtered",
    });
    expect(
      await trigger.deliver(await github(token, secret, issue(), { event: "issue_comment" })),
    ).toEqual({
      status: 200,
      outcome: "filtered",
    });
    expect(await trigger.deliver(await github(token, secret, "not json"))).toEqual({
      status: 200,
      outcome: "filtered",
    });
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "filtered", n: 3 },
    ]);
    expect(await trigger.state()).toMatchObject({ pending: 0 });
    expect(await trigger.registryCalls()).toEqual(before);

    // The one that matches is kept.
    expect(await trigger.deliver(await github(token, secret, issue()))).toEqual({
      status: 200,
      outcome: "accepted",
    });
    expect(await trigger.state()).toMatchObject({ pending: 1 });
  });

  it("drops a delivery the App's own bot sent, whatever the filter, and counts it filtered", async () => {
    const { secret, token, trigger } = await made();

    await trigger.setBot("Cloudpid-App[bot]");

    expect(
      await trigger.deliver(await github(token, secret, issue("created", "cloudpid-app[bot]"))),
    ).toEqual({
      status: 200,
      outcome: "filtered",
    });
    // Another bot's, and a person's, go through.
    expect(
      await trigger.deliver(await github(token, secret, issue("created", "dependabot[bot]"))),
    ).toMatchObject({
      outcome: "accepted",
    });
    expect(
      await trigger.deliver(await github(token, secret, issue("created", "octocat"))),
    ).toMatchObject({
      outcome: "accepted",
    });
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "filtered", n: 1 },
    ]);
    expect(await trigger.state()).toMatchObject({ pending: 2 });
  });

  it("drops any bot's delivery while GitHub cannot say which bot is the App's, counted as bot_unverified", async () => {
    const { secret, token, trigger } = await made();

    await trigger.setBot(undefined);

    expect(
      await trigger.deliver(await github(token, secret, issue("created", "dependabot[bot]"))),
    ).toEqual({
      status: 200,
      outcome: "bot_unverified",
    });
    expect(
      await trigger.deliver(await github(token, secret, issue("created", "octocat"))),
    ).toMatchObject({
      outcome: "accepted",
    });
    // Counted apart from a filter's, so the owner sees why the delivery was dropped.
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "bot_unverified", n: 1 },
    ]);
  });

  it("does not guard a standard Trigger: a bot-looking sender is not the App's", async () => {
    const { secret, token, trigger } = await made("standard");

    expect(
      await trigger.deliver(
        await standard(
          token,
          keyOfShown(secret),
          JSON.stringify({ type: "x", sender: { login: "a[bot]" } }),
          start,
        ),
      ),
    ).toMatchObject({ outcome: "accepted" });
  });
});

describe("a GitHub ping", () => {
  it("is answered 200 and its time kept, and it never fires", async () => {
    const { secret, token, trigger } = await made();
    const at = start + 9_000;

    await trigger.setNow(at);

    expect(
      await trigger.deliver(await github(token, secret, '{"zen":"hi"}', { event: "ping" })),
    ).toEqual({
      status: 200,
      outcome: "ping",
    });
    expect(await trigger.deliveries()).toEqual({ counts: [], lastDeliveryAt: at, pingAt: at });
    expect(await trigger.state()).toMatchObject({ pending: 0 });
    expect(await trigger.fireLog()).toEqual([]);

    // A ping with a bad signature is refused as any delivery is.
    expect(
      await trigger.deliver(
        await github(token, secret, '{"zen":"hi"}', { event: "ping", signWith: "no" }),
      ),
    ).toEqual({ status: 401, outcome: "unauthorized" });
  });
});

describe("the counts of refused and filtered deliveries", () => {
  it("are per UTC day, and a day older than 30 is dropped", async () => {
    const { secret, token, trigger } = await made("github", { event: ["never"] });
    const bad = "b".repeat(43);

    await trigger.deliver(await github(bad, secret, issue()));
    await trigger.setNow(start + DAY);
    await trigger.deliver(await github(token, secret, issue()));
    await trigger.deliver(await github(token, secret, issue()));

    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "not_found", n: 1 },
      { day: dayOf(start + DAY), outcome: "filtered", n: 2 },
    ]);

    // 29 days after the first, both are kept; 30 days after, the first day is gone.
    await trigger.setNow(start + 29 * DAY);
    expect((await trigger.deliveries()).counts).toHaveLength(2);

    await trigger.setNow(start + 30 * DAY);
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start + DAY), outcome: "filtered", n: 2 },
    ]);

    // The next count drops the rows that went out of the window.
    await trigger.deliver(await github(bad, secret, issue()));
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start + DAY), outcome: "filtered", n: 2 },
      { day: dayOf(start + 30 * DAY), outcome: "not_found", n: 1 },
    ]);
    await trigger.setNow(start + 75 * DAY);
    expect((await trigger.deliveries()).counts).toEqual([]);
  });
});

describe("rotation", () => {
  it("a new URL answers the old token 404 at once and the new one 200, the secret unchanged", async () => {
    const { secret, token, trigger } = await made();

    const rotated = await trigger.rotate("url");

    if (rotated.status !== "ok") throw new Error("The rotation answered no secrets");

    expect(rotated.secrets.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.secrets.token).not.toBe(token);
    expect(rotated.secrets.secret).toBe(secret);
    expect(await trigger.reveal()).toEqual(rotated);
    expect(await trigger.deliver(await github(token, secret, issue()))).toMatchObject({
      status: 404,
    });
    expect(
      await trigger.deliver(await github(rotated.secrets.token, secret, issue())),
    ).toMatchObject({
      status: 200,
    });
  });

  it("a new Signing secret answers the old signature 401 at once and the new one 200, the URL unchanged", async () => {
    const { secret, token, trigger } = await made();

    const rotated = await trigger.rotate("secret");

    if (rotated.status !== "ok") throw new Error("The rotation answered no secrets");

    expect(rotated.secrets.token).toBe(token);
    expect(rotated.secrets.secret).not.toBe(secret);
    expect(await trigger.deliver(await github(token, secret, issue()))).toMatchObject({
      status: 401,
    });
    expect(
      await trigger.deliver(await github(token, rotated.secrets.secret, issue())),
    ).toMatchObject({
      status: 200,
    });
  });

  it("answers none for an object with no Trigger, and makes no storage", async () => {
    const trigger = env.TRIGGERS.getByName(`trigger:ghost${String(counter++)}`);

    expect(await trigger.rotate("url")).toEqual({ status: "none" });
    expect(await trigger.reveal()).toEqual({ status: "none" });
    expect(await tables(trigger)).toEqual([]);
  });
});

describe("Fire again", () => {
  it("sends the last accepted delivery once more as a manual Fire, one Fire per key", async () => {
    const { id, secret, token, trigger } = await made();

    expect(await trigger.fireAgain("k0")).toEqual({ status: "none" });

    await trigger.deliver(await github(token, secret, issue(), { delivery: "d-1" }));
    await runDurableObjectAlarm(trigger);
    await trigger.deliver(await github(token, secret, issue("edited"), { delivery: "d-2" }));
    await runDurableObjectAlarm(trigger);
    await trigger.setNow(start + 60_000);

    expect(await trigger.fireAgain("k1")).toEqual({ status: "queued", key: `${id}:manual:k1` });
    expect(await trigger.fireAgain("k1")).toEqual({ status: "queued", key: `${id}:manual:k1` });
    await runDurableObjectAlarm(trigger);

    const sent = await trigger.sent();

    expect(sent).toHaveLength(3);
    expect(sent[2]?.request).toMatchObject({
      requestId: `${id}:manual:k1`,
      header: { again: true },
      payload: { delivery: "d-2", action: "edited", body: issue("edited") },
    });
    expect((await trigger.fireLog())[0]).toMatchObject({
      key: `${id}:manual:k1`,
      source: { type: "manual" },
      outcome: { type: "started" },
    });
  });

  it("is refused while the Trigger is paused", async () => {
    const { id, registry, secret, token, trigger } = await made();

    await trigger.deliver(await github(token, secret, issue()));
    await registry.setTriggerPaused(id, true, start + 1_000);

    expect(await trigger.fireAgain("k")).toEqual({ status: "paused" });
  });
});

/** What the object keeps of its pending Fires, as storage holds them. */
const pendingRows = (trigger: DurableObjectStub<TestTrigger>) =>
  runInDurableObject(trigger, (_instance, state) =>
    state.storage.sql
      .exec<{
        key: string;
        body: ArrayBuffer | null;
        facts: string | null;
        revision: number | null;
      }>("SELECT key, body, facts, revision FROM trigger_pending ORDER BY key")
      .toArray()
      .map((row) => ({
        key: row.key,
        body: row.body === null ? null : Array.from(new Uint8Array(row.body)),
        facts: row.facts,
        revision: row.revision,
      })),
  );

describe("a delivery kept while the Trigger's match changes", () => {
  it("is counted filtered, with no Session, when the match narrowed between the delivery and the alarm", async () => {
    const { id, registry, secret, token, trigger } = await made("github", { action: ["opened"] });

    await trigger.deliver(await github(token, secret, issue("opened")));

    expect(await trigger.state()).toMatchObject({ pending: 1 });
    expect((await pendingRows(trigger))[0]?.revision).toBe(1);

    expect(
      await registry.updateTrigger(id, { match: { action: ["closed"] } }, start + 500),
    ).toMatchObject({ status: "ok" });

    await trigger.setNow(start + 1_000);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toEqual([]);
    expect(await trigger.state()).toMatchObject({ pending: 0 });
    expect(await trigger.fireLog()).toEqual([]);
    expect(await registry.listSessions()).toEqual([]);
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "filtered", n: 1 },
    ]);
  });

  it("fires, admitted at the revision now current, when the match changed but still passes it", async () => {
    const { id, registry, secret, token, trigger } = await made("github", { action: ["opened"] });

    await trigger.deliver(await github(token, secret, issue("opened")));
    await registry.updateTrigger(id, { match: { action: ["opened", "closed"] } }, start + 500);
    await trigger.setNow(start + 1_000);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toHaveLength(1);
    expect((await trigger.deliveries()).counts).toEqual([]);
  });

  /** A delivery over 1 MiB of issue 7, kept as the facts its `match` read, then the match set to `next`. */
  const overTheBody = async (next: TriggerMatch) => {
    const { id, registry, secret, token, trigger } = await made("github", {
      "issue.number": ["7"],
    });

    const text = JSON.stringify({
      action: "opened",
      issue: { number: 7 },
      pad: "a".repeat(MAX_KEPT_BODY_BYTES),
    });

    await trigger.deliver(await github(token, secret, text));

    const [row] = await pendingRows(trigger);

    // The body is not kept: what the match read of it is, by path.
    expect(row?.body).toBeNull();
    expect(JSON.parse(row?.facts ?? "null")).toEqual({ issue: { number: "7" } });

    await registry.updateTrigger(id, { match: next }, start + 500);
    await trigger.setNow(start + 1_000);
    await runDurableObjectAlarm(trigger);

    return { registry, trigger };
  };

  it("is checked against the facts of a body over 1 MiB, and filtered when they no longer match", async () => {
    const { registry, trigger } = await overTheBody({ "issue.number": ["8"] });

    expect(await trigger.sent()).toEqual([]);
    expect(await registry.listSessions()).toEqual([]);
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "filtered", n: 1 },
    ]);
  });

  it("is filtered when the new match reads a path of a body over 1 MiB that was not kept", async () => {
    const { trigger } = await overTheBody({ action: ["opened"] });

    expect(await trigger.sent()).toEqual([]);
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "filtered", n: 1 },
    ]);
  });

  it("fires when a body over 1 MiB still matches the facts, with its size and no body", async () => {
    const { trigger } = await overTheBody({ "issue.number": ["7", "8"] });

    const [sent] = await trigger.sent();

    expect(sent?.request.payload?.size).toBeGreaterThan(MAX_KEPT_BODY_BYTES);
    expect(sent?.request.payload).not.toHaveProperty("body");
  });
});

describe("a Trigger whose kept secrets no longer read", () => {
  const corrupt = (trigger: DurableObjectStub<TestTrigger>) =>
    runInDurableObject(trigger, (_instance, state) => {
      state.storage.sql.exec("UPDATE trigger_secrets SET token = 'junk'");
    });

  const tokenRow = (trigger: DurableObjectStub<TestTrigger>) =>
    runInDurableObject(
      trigger,
      (_instance, state) =>
        state.storage.sql.exec<{ token: string }>("SELECT token FROM trigger_secrets").one().token,
    );

  it("answers every delivery 404 as a wrong token is, counts it and says so in the logs", async () => {
    const { secret, token, trigger } = await made();

    await corrupt(trigger);

    expect(await trigger.deliver(await github(token, secret, issue()))).toEqual({
      status: 404,
      outcome: "not_found",
    });
    expect((await trigger.deliveries()).counts).toEqual([
      { day: dayOf(start), outcome: "not_found", n: 1 },
    ]);
    expect(await trigger.logged()).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "Error" })]),
    );
    expect(await trigger.state()).toMatchObject({ pending: 0 });
  });

  it("is not replaced by a sync, and says unreadable when asked to reveal", async () => {
    const { trigger } = await made();

    await corrupt(trigger);
    await trigger.sync();

    expect(await tokenRow(trigger)).toBe("junk");
    expect(await trigger.reveal()).toEqual({ status: "unreadable" });
    expect(await tokenRow(trigger)).toBe("junk");
  });

  it("gets both secrets new from a rotation, whichever is asked, and takes deliveries again", async () => {
    const { secret, token, trigger } = await made();

    await corrupt(trigger);

    const rotated = await trigger.rotate("secret");

    if (rotated.status !== "ok") throw new Error("The rotation answered no secrets");

    expect(rotated.secrets.token).not.toBe(token);
    expect(rotated.secrets.secret).not.toBe(secret);
    expect(await trigger.reveal()).toEqual(rotated);
    expect(
      await trigger.deliver(await github(rotated.secrets.token, rotated.secrets.secret, issue())),
    ).toMatchObject({ status: 200, outcome: "accepted" });
  });
});

describe("a webhook Trigger whose secrets were never made", () => {
  const forget = (trigger: DurableObjectStub<TestTrigger>) =>
    runInDurableObject(trigger, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM trigger_secrets");
    });

  it("makes them when the owner asks to reveal them", async () => {
    const { token, secret, trigger } = await made();

    await forget(trigger);

    const revealed = await trigger.reveal();

    if (revealed.status !== "ok") throw new Error("The reveal answered no secrets");

    expect(revealed.secrets.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(revealed.secrets.token).not.toBe(token);
    expect(await trigger.reveal()).toEqual(revealed);
    expect(
      await trigger.deliver(await github(revealed.secrets.token, revealed.secrets.secret, issue())),
    ).toMatchObject({ status: 200 });
    expect(secret).toBeTruthy();
  });

  it("makes both when the owner rotates one", async () => {
    const { token, secret, trigger } = await made();

    await forget(trigger);

    const rotated = await trigger.rotate("url");

    if (rotated.status !== "ok") throw new Error("The rotation answered no secrets");

    expect(rotated.secrets.token).not.toBe(token);
    expect(rotated.secrets.secret).not.toBe(secret);
    expect(await trigger.reveal()).toEqual(rotated);
  });
});

describe("a Trigger brought back by a reverted removal", () => {
  it("has new secrets once the revert wipes its object, even where the removal's own sync was lost", async () => {
    const { id, registry, token, secret, trigger } = await made();

    // The removal's sync never reached the object: it still holds the removed Trigger's secrets.
    await registry.removeTrigger(id);
    await registry.createTrigger(id, webhook("github"), start + 1_000);

    // The revert wipes the object before it wakes it, as `revertAgentChange` does.
    await trigger.remove();
    await trigger.sync();

    const again = await trigger.reveal();

    if (again.status !== "ok") throw new Error("The brought back Trigger has no secrets");

    expect(again.secrets.token).not.toBe(token);
    expect(again.secrets.secret).not.toBe(secret);
    expect(await trigger.deliver(await github(token, secret, issue()))).toMatchObject({
      status: 404,
    });
  });

  it("would keep the old secrets with no wipe, which is why the revert wipes", async () => {
    const { id, registry, token, secret, trigger } = await made();

    await registry.removeTrigger(id);
    await registry.createTrigger(id, webhook("github"), start + 1_000);
    await trigger.sync();

    expect(await trigger.reveal()).toEqual({ status: "ok", secrets: { token, secret } });
  });
});

describe("a repeated delivery", () => {
  it("makes no second Fire within 24 hours of the first, and makes one once they have passed", async () => {
    const { secret, token, trigger } = await made();
    const one = await github(token, secret, issue(), { delivery: "again" });

    await trigger.deliver(one);
    await runDurableObjectAlarm(trigger);

    expect(await trigger.sent()).toHaveLength(1);

    await trigger.setNow(start + DAY - 1_000);
    expect(await trigger.deliver(one)).toEqual({ status: 200, outcome: "accepted" });
    expect(await trigger.state()).toMatchObject({ pending: 0 });

    await trigger.setNow(start + DAY + 1_000);
    expect(await trigger.deliver(one)).toEqual({ status: 200, outcome: "accepted" });
    expect(await trigger.state()).toMatchObject({ pending: 1 });
  });
});

describe("a delivery's body", () => {
  /** A BOM, JSON with an action, and a byte no UTF-8 text holds. */
  const raw = Uint8Array.from([
    0xef,
    0xbb,
    0xbf,
    ...bytes('{"action":"opened","text":"'),
    0xff,
    ...bytes('"}'),
  ]);

  it("is kept as the bytes received, and decoded only when it is sent, with its byte order mark and a replacement character", async () => {
    const { secret, token, trigger } = await made();

    await trigger.deliver(await githubBytes(token, secret, raw, { delivery: "raw" }));

    const [row] = await pendingRows(trigger);

    expect(row?.body).toEqual(Array.from(raw));

    await runDurableObjectAlarm(trigger);

    const [sent] = await trigger.sent();

    expect(sent?.request.payload?.size).toBe(raw.length);
    expect(sent?.request.payload?.body).toBe('\uFEFF{"action":"opened","text":"\uFFFD"}');
  });

  it("is sent again as the bytes received, by Fire again", async () => {
    const { secret, token, trigger } = await made();

    await trigger.deliver(await githubBytes(token, secret, raw, { delivery: "raw" }));
    await runDurableObjectAlarm(trigger);
    await trigger.setNow(start + 60_000);
    await trigger.fireAgain("k");
    await runDurableObjectAlarm(trigger);

    const sent = await trigger.sent();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.request.payload?.body).toBe(sent[0]?.request.payload?.body);
    expect(sent[1]?.request.payload?.size).toBe(raw.length);
  });

  it("counts by its bytes for the 1 MiB it is kept to: bytes the text would make longer are kept", async () => {
    const { secret, token, trigger } = await made();

    // 1 MiB of bytes that each decode to a three-byte replacement character.
    const body = new Uint8Array(MAX_KEPT_BODY_BYTES).fill(0xff);

    body.set(bytes('{"action":"opened"}'));

    await trigger.deliver(await githubBytes(token, secret, body, { delivery: "bytes" }));

    const [row] = await pendingRows(trigger);

    expect(row?.body).toHaveLength(MAX_KEPT_BODY_BYTES);
  });
});
