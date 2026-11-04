// What a socket's limited requests have in common (`./socket-requests.ts`): the minute's count, what is in flight, and the
// end of a socket.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import { describe, expect, it } from "vitest";
import { socketRequests } from "./socket-requests.ts";

// SAFETY: the registry only keys its counts by the socket, and never calls it.
const socket = () => ({}) as WebSocket;

describe("a socket's requests", () => {
  it("lets through `limit` arrivals of a kind a minute, counts the ones it refuses, and lets one through a minute on", () => {
    let now = 0;

    const requests = socketRequests(() => now);
    const view = requests.of(socket());

    expect([1, 2, 3].map(() => view.admits("request", 2))).toEqual([true, true, false]);
    // Another kind has its own count.
    expect(view.admits("log", 2)).toBe(true);

    // A refused arrival is counted: it is over the limit for as long as it keeps asking within the minute.
    now = 59_999;
    expect(view.admits("request", 2)).toBe(false);

    now = 120_000;
    expect(view.admits("request", 2)).toBe(true);
  });

  it("keeps a requester for each key of a socket, and none for another socket", () => {
    const requests = socketRequests(() => 0);
    const one = socket();

    requests.of(one, "call-1").start("a");

    expect(requests.of(one, "call-1").running("a")).toBe(true);
    expect(requests.of(one, "call-2").running("a")).toBe(false);
    expect(requests.of(socket(), "call-1").running("a")).toBe(false);
    expect(requests.find(one, "call-3")).toBeUndefined();
    // Finding one makes none.
    expect(requests.find(one, "call-3")).toBeUndefined();
  });

  it("aborts what is in flight, by id or when the socket goes, and forgets the socket", () => {
    const requests = socketRequests(() => 0);
    const one = socket();
    const view = requests.of(one, "call");
    const first = view.start("1");
    const second = view.start("2");

    expect(view.inFlight()).toBe(2);
    view.abort("1");
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, false]);

    view.finish("1");
    expect(view.inFlight()).toBe(1);

    requests.end(one);
    expect(second.signal.aborted).toBe(true);
    expect(requests.find(one, "call")).toBeUndefined();
  });
});
