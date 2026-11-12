// @effect-diagnostics preferEffectArray:off preferEffectRecord:off
import { describe, expect, it } from "vite-plus/test";
import {
  actionOf,
  bodyOf,
  contentKind,
  eventOf,
  botGuard,
  keyedDelivery,
  senderLogin,
} from "./delivery.ts";

describe("contentKind", () => {
  it("takes JSON (also a +json type), form-urlencoded and text, whatever the case or parameters", () => {
    expect(contentKind("application/json")).toBe("json");
    expect(contentKind("Application/JSON; charset=utf-8")).toBe("json");
    expect(contentKind("application/cloudevents+json")).toBe("json");
    expect(contentKind("application/x-www-form-urlencoded")).toBe("form");
    expect(contentKind("text/plain; charset=utf-8")).toBe("text");
    expect(contentKind("text/x-anything")).toBe("text");
  });

  it("refuses everything else, and a missing type", () => {
    expect(contentKind("application/xml")).toBeUndefined();
    expect(contentKind("multipart/form-data; boundary=x")).toBeUndefined();
    expect(contentKind("application/jsonx")).toBeUndefined();
    expect(contentKind("")).toBeUndefined();
    expect(contentKind(undefined)).toBeUndefined();
  });
});

describe("bodyOf", () => {
  it("parses JSON, and the JSON inside a form's payload field", () => {
    expect(bodyOf("json", '{"a":1}')).toEqual({ a: 1 });
    expect(bodyOf("form", `payload=${encodeURIComponent('{"a":{"b":"c"}}')}&x=1`)).toEqual({
      a: { b: "c" },
    });
    expect(bodyOf("text", '{"a":1}')).toEqual({ a: 1 });
  });

  it("is undefined where the body is no JSON, or the form has no payload", () => {
    expect(bodyOf("json", "not json")).toBeUndefined();
    expect(bodyOf("form", "x=1")).toBeUndefined();
    expect(bodyOf("form", "payload=%7Bnope")).toBeUndefined();
    expect(bodyOf("text", "hello")).toBeUndefined();
  });
});

describe("eventOf and actionOf", () => {
  it("reads a github event from its header and a standard event from the body's type", () => {
    expect(eventOf("github", { event: "push" }, { type: "ignored" })).toBe("push");
    expect(eventOf("github", {}, { type: "ignored" })).toBeUndefined();
    expect(eventOf("standard", { event: "ignored" }, { type: "invoice.paid" })).toBe(
      "invoice.paid",
    );
    expect(eventOf("standard", {}, { type: 3 })).toBeUndefined();
    expect(eventOf("standard", {}, undefined)).toBeUndefined();
  });

  it("reads the action only when it is text", () => {
    expect(actionOf({ action: "opened" })).toBe("opened");
    expect(actionOf({ action: 1 })).toBeUndefined();
    expect(actionOf([{ action: "opened" }])).toBeUndefined();
    expect(actionOf(undefined)).toBeUndefined();
  });
});

describe("the bot-loop guard", () => {
  it("reads the sender's login", () => {
    expect(senderLogin({ sender: { login: "Cloudpid-App[bot]" } })).toBe("Cloudpid-App[bot]");
    expect(senderLogin({ sender: "x" })).toBeUndefined();
    expect(senderLogin({})).toBeUndefined();
  });

  it("drops the App's own bot, whatever the case, and lets other senders through", () => {
    expect(botGuard("Cloudpid-App[bot]", "cloudpid-app[bot]")).toBe("own");
    expect(botGuard("someone", "cloudpid-app[bot]")).toBe("pass");
    expect(botGuard("dependabot[bot]", "cloudpid-app[bot]")).toBe("pass");
    expect(botGuard(undefined, "cloudpid-app[bot]")).toBe("pass");
  });

  it("fails closed on a bot while the App's own is not known, and only on a bot", () => {
    expect(botGuard("dependabot[bot]", undefined)).toBe("unverified");
    expect(botGuard("someone", undefined)).toBe("pass");
    expect(botGuard(undefined, undefined)).toBe("pass");
  });
});

describe("keyedDelivery", () => {
  it("keeps a delivery id as it is, and shortens one too long for a key to a hash", () => {
    expect(keyedDelivery("abc-123")).toBe("abc-123");

    const long = keyedDelivery("x".repeat(500));

    expect(long).toMatch(/^h-[0-9a-f]{64}$/);
    expect(keyedDelivery("x".repeat(500))).toBe(long);
    expect(keyedDelivery("y".repeat(500))).not.toBe(long);
  });
});
