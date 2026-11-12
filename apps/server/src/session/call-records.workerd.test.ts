// The chunked-record primitive (`docs/architecture/visuals.md` → The copy: Bounds, The store; `docs/architecture/visuals.md`
// → Testing), over a Session object's real key-value storage: records kept in parts, the index written last, the least
// recently mounted record evicted to a stub past the byte, record and stub bounds, and a replaced instance's storage
// (`refusingStorage`), which refuses every operation. The App record store's own tests (`mcp-apps-store.test.ts`,
// `mcp-apps.workerd.test.ts`) run through the primitive too, and cover its parts, the 1 MiB bound and the stubs of a Fork's
// copy; the eviction past 32 MiB and the counts are tested here alone.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import { describe, expect, it } from "vite-plus/test";
import type { TestSession } from "./host.fixture.ts";
import {
  callRecords,
  type CallRecordEntry,
  type CallRecords,
  PART_LENGTH,
} from "./call-records.ts";
import type { SessionKv } from "./session-kv.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const MiB = 1024 * 1024;

/** The bounds Visuals keep: 32 MiB, 1000 records, 2000 stubs. */
const BOUNDS = { bytes: 32 * MiB, records: 1000, stubs: 2000 };

const INDEX = "test-records:index";
const partKey = (callId: string, part: number) => `test-records:${callId}:${part}`;
const sideKey = (callId: string) => `test-records:side:${callId}`;

/** An entry as a store adds its own fields to the primitive's. */
type Own = { readonly title: string };

type Entry = CallRecordEntry<Own>;

const entry = (callId: string, fields: Partial<Entry> = {}): Entry => ({
  callId,
  conversation: "1",
  state: "kept",
  bytes: 10,
  parts: 1,
  mountedAt: 1,
  title: callId,
  ...fields,
});

/** What a stub of an entry keeps of its own fields; the primitive sets the rest. */
const keeps = (each: Entry): Own => ({ title: each.title });

const open = (storage: SessionKv): CallRecords<Own> =>
  callRecords<Own>({
    storage,
    indexKey: INDEX,
    partKey,
    alsoKeys: (callId) => [sideKey(callId)],
    bounds: BOUNDS,
    keeps,
  });

let counter = 0;

/** Run `body` in a fresh object, given its state and so its real storage. */
const inSession = <A>(body: (state: DurableObjectState) => A) => {
  counter += 1;

  return runInDurableObject(env.SESSIONS.getByName(`call-records-${counter}`), (_, state) =>
    body(state),
  );
};

const keysOf = (kv: SessionKv & { readonly list: DurableObjectStorage["kv"]["list"] }) =>
  Array.from(kv.list({ prefix: "test-records:" }), ([key]) => key).toSorted();

/** Keep `text` as call `callId`'s record and settle, as a store's write does. */
const keep = (
  records: CallRecords<Own>,
  callId: string,
  text: string,
  fields: Partial<Entry> = {},
) =>
  records.settle(
    records.write(records.index(), callId, text, (parts) => entry(callId, { ...fields, parts })),
    callId,
  );

describe("the chunked-record primitive", () => {
  it("keeps a record in parts of at most PART_LENGTH characters, and reads it back whole", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);
      const text = "a".repeat(PART_LENGTH) + "b".repeat(PART_LENGTH) + "c".repeat(10);

      keep(records, "big", text);

      const [kept] = records.index();

      expect(kept).toMatchObject({ callId: "big", parts: 3 });
      expect(keysOf(state.storage.kv)).toEqual([
        partKey("big", 0),
        partKey("big", 1),
        partKey("big", 2),
        INDEX,
      ]);
      expect(state.storage.kv.get<string>(partKey("big", 0))).toHaveLength(PART_LENGTH);
      expect(state.storage.kv.get<string>(partKey("big", 2))).toBe("c".repeat(10));
      expect(kept === undefined ? undefined : records.read(kept)).toBe(text);
    });
  });

  it("replaces a record without leaving its old parts or its other values behind", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);

      keep(records, "page", "x".repeat(3 * PART_LENGTH));
      state.storage.kv.put(sideKey("page"), ["note"]);
      keep(records, "page", "short");

      const [kept] = records.index();

      expect(records.index()).toHaveLength(1);
      expect(kept === undefined ? undefined : records.read(kept)).toBe("short");
      // The other value goes with the parts it was kept beside: a store that has one writes it again.
      expect(keysOf(state.storage.kv)).toEqual([INDEX, partKey("page", 0)]);
    });
  });

  it("writes the index last of everything a write and its eviction touch", async () => {
    await inSession((state) => {
      const log: Array<string> = [];

      const recording: SessionKv = {
        get: (key) => state.storage.kv.get(key),
        put: (key, value) => {
          log.push(`put ${key}`);
          state.storage.kv.put(key, value);
        },
        delete: (key) => {
          log.push(`delete ${key}`);

          return state.storage.kv.delete(key);
        },
      };

      const records = callRecords<Own>({
        storage: recording,
        indexKey: INDEX,
        partKey,
        alsoKeys: (callId) => [sideKey(callId)],
        // Two records fit: the third written evicts the least recently mounted.
        bounds: { bytes: 25, records: 1000, stubs: 2000 },
        keeps,
      });

      keep(records, "old", "o".repeat(PART_LENGTH + 1), { mountedAt: 1 });
      keep(records, "mid", "m", { mountedAt: 2 });
      log.length = 0;

      keep(records, "new", "n".repeat(PART_LENGTH + 1), { mountedAt: 3 });

      expect(log).toEqual([
        `put ${partKey("new", 0)}`,
        `put ${partKey("new", 1)}`,
        `delete ${partKey("old", 0)}`,
        `delete ${partKey("old", 1)}`,
        `delete ${sideKey("old")}`,
        `put ${INDEX}`,
      ]);
      expect(records.index().map((each) => `${each.callId}:${each.state}`)).toEqual([
        "old:evicted",
        "mid:kept",
        "new:kept",
      ]);
    });
  });

  it("evicts the least recently mounted record, not the oldest written, past 1000 records", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);
      let entries: ReadonlyArray<Entry> = [];

      for (let at = 1; at <= 1000; at++) {
        entries = records.write(entries, `call-${at}`, "x", (parts) =>
          entry(`call-${at}`, { parts, mountedAt: at }),
        );
      }

      expect([...records.settle(entries, undefined)]).toEqual([]);
      expect(records.index().filter((each) => each.state === "kept")).toHaveLength(1000);

      // The first call is mounted again, so the second is now the least recently mounted.
      const [first] = records.index();

      if (first === undefined) throw new Error("no first record");

      records.touch(records.index(), first, 5000);

      const touched = keep(records, "call-1001", "x", { mountedAt: 5001 });
      const states = new Map(records.index().map((each) => [each.callId, each.state]));

      expect([...touched]).toEqual(["1"]);
      expect(states.get("call-2")).toBe("evicted");
      expect(states.get("call-1")).toBe("kept");
      expect(states.get("call-1001")).toBe("kept");
      expect(records.index().filter((each) => each.state === "kept")).toHaveLength(1000);
      // The stub keeps no parts.
      expect(state.storage.kv.get(partKey("call-2", 0))).toBeUndefined();
      expect(state.storage.kv.get(partKey("call-3", 0))).toBe("x");
    });
  });

  it("drops the oldest stubs past 2000, which then read as no record", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);

      const stubs = Array.from({ length: 2001 }, (_, at) =>
        entry(`stub-${at}`, {
          state: "evicted",
          bytes: 0,
          parts: 0,
          conversation: at === 0 ? "7" : "1",
        }),
      );

      const touched = records.settle([...stubs, entry("live")], undefined);
      const callIds = records.index().map((each) => each.callId);

      expect(callIds).toHaveLength(2001);
      expect(callIds).not.toContain("stub-0");
      expect(callIds).toContain("stub-1");
      expect(callIds).toContain("live");
      // The dropped stub's conversation is told, as an evicted record's is.
      expect([...touched]).toEqual(["7"]);
    });
  });

  it("evicts to stubs past 32 MiB, the least recently mounted first, and never the record just written", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);

      keep(records, "a", "a", { bytes: 10 * MiB, mountedAt: 1 });
      keep(records, "b", "b", { bytes: 10 * MiB, mountedAt: 2 });
      keep(records, "c", "c", { bytes: 10 * MiB, mountedAt: 3 });

      const states = () => records.index().map((each) => `${each.callId}:${each.state}`);

      expect(states()).toEqual(["a:kept", "b:kept", "c:kept"]);

      // 40 MiB: `a` goes, and keeps its entry, with no bytes or parts.
      keep(records, "d", "d", { bytes: 10 * MiB, mountedAt: 4 });

      expect(states()).toEqual(["a:evicted", "b:kept", "c:kept", "d:kept"]);
      // The stub keeps its own fields and its place in the order of mounts; the primitive empties the rest.
      expect(records.index()[0]).toMatchObject({
        callId: "a",
        conversation: "1",
        title: "a",
        bytes: 0,
        parts: 0,
        mountedAt: 1,
      });
      expect(state.storage.kv.get(partKey("a", 0))).toBeUndefined();

      // A lone record over the bound stays: the one just written is never evicted.
      keep(records, "huge", "h", { bytes: 40 * MiB, mountedAt: 5 });

      expect(states()).toEqual(["a:evicted", "b:evicted", "c:evicted", "d:evicted", "huge:kept"]);
    });
  });

  it("writes a stub over a call's record, last, with no parts of the record left", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);

      keep(records, "a", "x".repeat(PART_LENGTH + 1), { bytes: 50 });
      keep(records, "b", "b");
      state.storage.kv.put(sideKey("a"), ["note"]);

      records.settle(
        records.stub(records.index(), {
          callId: "a",
          conversation: "2",
          mountedAt: 9,
          title: "copied",
        }),
        undefined,
      );

      expect(records.index()).toEqual([
        expect.objectContaining({ callId: "b", state: "kept" }),
        {
          callId: "a",
          conversation: "2",
          mountedAt: 9,
          title: "copied",
          state: "evicted",
          bytes: 0,
          parts: 0,
        },
      ]);
      expect(keysOf(state.storage.kv)).toEqual([partKey("b", 0), INDEX]);
    });
  });

  it("evicts a record that is listed but cannot be read, leaving a stub and no parts", async () => {
    await inSession((state) => {
      const records = open(state.storage.kv);

      keep(records, "broken", "x".repeat(PART_LENGTH + 1));
      state.storage.kv.delete(partKey("broken", 1));

      const [listed] = records.index();

      if (listed === undefined) throw new Error("no record");

      // Its second part is gone: the text is short, so a store's parse fails and it evicts.
      expect(records.read(listed)).toHaveLength(PART_LENGTH);

      records.settle(records.evict(records.index(), listed), undefined);

      expect(records.index()).toEqual([
        expect.objectContaining({ callId: "broken", state: "evicted", parts: 0 }),
      ]);
      expect(keysOf(state.storage.kv)).toEqual([INDEX]);
    });
  });

  it("is left whole by a replaced instance, whose storage refuses every operation", async () => {
    await inSession((state) => {
      const before = open(state.storage.kv);

      keep(before, "kept", "the first", { mountedAt: 1 });

      const replaceable = refusingStorage(state.storage);
      const { kv } = replaceable.storage;

      // The code update reaches the instance after the record's parts are written, before the index is.
      const cut: SessionKv = {
        get: (key) => kv.get(key),
        put: (key, value) => {
          if (key === INDEX) replaceable.trip();

          kv.put(key, value);
        },
        delete: (key) => kv.delete(key),
      };

      const old = open(cut);

      expect(() => keep(old, "lost", "never listed", { mountedAt: 2 })).toThrow(/refused/);
      expect(replaceable.tripped()).toBe(true);
      // Every later operation of the instance refuses as well, reads included.
      expect(() => old.index()).toThrow(/refused/);
      expect(() => keep(old, "later", "x")).toThrow(/refused/);

      // The new instance opens the real storage: the index lists what it did before, whole.
      const next = open(state.storage.kv);
      const [listed] = next.index();

      expect(next.index()).toHaveLength(1);
      expect(listed).toMatchObject({ callId: "kept", state: "kept" });
      expect(listed === undefined ? undefined : next.read(listed)).toBe("the first");

      // The call the cut write left unlisted is written again as any new call.
      keep(next, "lost", "written again", { mountedAt: 3 });

      const lost = next.index().find((each) => each.callId === "lost");

      expect(next.index()).toHaveLength(2);
      expect(lost === undefined ? undefined : next.read(lost)).toBe("written again");
    });
  });
});
