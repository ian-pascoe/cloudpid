/**
 * The tap's SSE splitter against the parser the SDK reads a request stream with (`eventsource-parser`, a devDependency
 * at the version the SDK resolves): for the same chunks it finds the same events, so what the tap counts as an answer
 * is what the SDK dispatches (`docs/architecture/mcp-connections.md` → Failures and cuts).
 */
// @effect-diagnostics preferEffectArray:off
import { createParser } from "eventsource-parser";
import { describe, expect, it } from "vitest";
import { crFollowsLf, EventSplitter, eventFields } from "./tap.ts";

/** A small seeded generator (mulberry32), so a failure is the same every run. */
const seeded = (seed: number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);

    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const LINES = [
  "data: x",
  "data:y",
  "data",
  "data: ",
  "id: 7",
  "id:",
  "event: e",
  "event:",
  "retry: 5",
  ": a comment",
  "unknown: field",
  "",
  "",
  "",
];

const ENDINGS = ["\n", "\r", "\r\n"];

interface Dispatched {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

/** Whether a CR follows the last LF of the stream `chunks`, as the tap tracks it. */
const crAfterLf = (chunks: ReadonlyArray<string>) => {
  let found = false;

  for (const chunk of chunks) found = crFollowsLf(found, chunk);

  return found;
};

/** A stream of random lines and line endings, cut into random chunks (and maybe left unfinished). */
const streamOf = (random: () => number) => {
  const pick = (items: ReadonlyArray<string>) => items[Math.floor(random() * items.length)] ?? "";

  const lines = Math.floor(random() * 12) + 1;
  let text = "";

  for (let line = 0; line < lines; line += 1) {
    text += pick(LINES) + (line === lines - 1 && random() < 0.2 ? "" : pick(ENDINGS));
  }

  const cuts = Array.from({ length: Math.floor(random() * 7) }, () =>
    Math.floor(random() * (text.length + 1)),
  ).toSorted((a, b) => a - b);

  const chunks: Array<string> = [];
  let from = 0;

  for (const cut of [...cuts, text.length]) {
    chunks.push(text.slice(from, cut));
    from = cut;
  }

  return chunks.filter((chunk) => chunk !== "");
};

/** What the SDK's parser dispatches for `chunks`, given the LF the tap adds after a stream that may end holding a CR. */
const bySdk = (chunks: ReadonlyArray<string>, endsWithLf: boolean) => {
  const dispatched: Array<Dispatched> = [];

  const parser = createParser({
    onEvent: ({ id, event, data }) => dispatched.push({ id, event, data }),
  });

  for (const chunk of chunks) parser.feed(chunk);

  if (endsWithLf) parser.feed("\n");

  return dispatched;
};

/** What the tap's splitter finds for the same chunks, the way `watchStream` ends a stream it passes through. */
const byTap = (chunks: ReadonlyArray<string>, endsWithLf: boolean) => {
  const splitter = new EventSplitter(Number.POSITIVE_INFINITY);
  const events: Array<string> = [];

  for (const chunk of chunks) events.push(...splitter.push(chunk));

  events.push(...(endsWithLf ? splitter.push("\n") : splitter.push("", true)));

  return events.flatMap((event) => {
    const { id, type, data, dataLines } = eventFields(event);

    return dataLines > 0 ? [{ id, event: type, data }] : [];
  });
};

describe("the tap's SSE splitter", () => {
  it("finds the events the SDK's parser dispatches, for any line endings and chunking", () => {
    const random = seeded(542);

    for (let index = 0; index < 2000; index += 1) {
      const chunks = streamOf(random);
      const endsWithLf = crAfterLf(chunks);

      expect(byTap(chunks, endsWithLf), JSON.stringify(chunks)).toEqual(bySdk(chunks, endsWithLf));
    }
  });

  it("tracks a CR after the last LF, the one case the SDK holds back", () => {
    expect(crAfterLf(["data: a\n\r", "data: b\n"])).toBe(false);
    expect(crAfterLf(["data: a\n", "\r"])).toBe(true);
    expect(crAfterLf(["data: a\r", "id: 1"])).toBe(true);
  });
});
