// @effect-diagnostics globalDate:off preferEffectArray:off -- Fire times shown as ISO strings.
import { describe, expect, it } from "vitest";
import {
  cronProblem,
  dueFires,
  nextFires,
  scheduleProblem,
  zoneProblem,
} from "./trigger-schedule.ts";

const at = (iso: string) => Date.parse(iso);

const iso = (times: ReadonlyArray<number>) => times.map((time) => new Date(time).toISOString());

const chicago = (cron: string) => ({ cron, zone: "America/Chicago" });

describe("cronProblem", () => {
  it("takes 5-field cron with names, and the @hourly, @daily and @weekly shortcuts", () => {
    for (const cron of [
      "0 9 * * MON",
      "*/15 * * * *",
      "30 2 1,15 JAN-JUN mon-fri",
      "0 0 * JUL WED",
      "5 4 * * 0",
      "@hourly",
      "@daily",
      "@weekly",
      "  0 9 * * 1  ",
    ]) {
      expect(cronProblem(cron), cron).toBeUndefined();
    }
  });

  it("refuses 6- and 7-field forms", () => {
    expect(cronProblem("0 0 9 * * MON")).toMatch(/5 fields/);
    expect(cronProblem("0 0 9 * * MON 2027")).toMatch(/5 fields/);
  });

  it("refuses the L, W and # extensions, and croner's ? and +", () => {
    for (const cron of [
      "0 9 L * *",
      "0 9 15W * *",
      "0 9 * * MON#1",
      "0 9 * * 5L",
      "0 9 ? * *",
      "0 9 1 * +MON",
    ]) {
      expect(cronProblem(cron), cron).toBeDefined();
    }
  });

  it("refuses other shortcuts, an empty expression and one croner can't read", () => {
    for (const cron of [
      "@monthly",
      "@yearly",
      "@reboot",
      "",
      "61 * * * *",
      "0 9 * * FUNDAY",
      "0 9 * *",
    ]) {
      expect(cronProblem(cron), cron).toBeDefined();
    }
  });
});

describe("zoneProblem", () => {
  it("takes IANA zones", () => {
    for (const zone of ["America/Chicago", "Europe/Stockholm", "UTC", "Asia/Kolkata"]) {
      expect(zoneProblem(zone), zone).toBeUndefined();
    }
  });

  it("refuses an empty zone, an unknown one and a bare offset", () => {
    for (const zone of ["", "Mars/Olympus", "+05:00", "-0800"]) {
      expect(zoneProblem(zone), zone).toBeDefined();
    }
  });
});

describe("nextFires", () => {
  it("lists the next Fire times in the Schedule's zone, after the time given", () => {
    // Monday 2026-11-02 09:00 CST is 15:00 UTC; the week before was still CDT.
    expect(iso(nextFires(chicago("0 9 * * MON"), at("2026-10-20T00:00:00Z"), 3))).toEqual([
      "2026-10-26T14:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
      "2026-11-09T15:00:00.000Z",
    ]);
  });

  it("never lists the time given itself", () => {
    expect(iso(nextFires(chicago("@daily"), at("2026-11-07T06:00:00Z"), 1))).toEqual([
      "2026-11-08T06:00:00.000Z",
    ]);
  });

  describe("daylight saving time, as croner gives it", () => {
    it("fires a fixed time the spring gap skips once, at the first valid moment after it", () => {
      // 2026-03-08: 02:00 CST jumps to 03:00 CDT, so 02:30 doesn't exist that day.
      expect(iso(nextFires(chicago("30 2 * * *"), at("2026-03-07T12:00:00Z"), 2))).toEqual([
        "2026-03-08T08:00:00.000Z", // 03:00 CDT
        "2026-03-09T07:30:00.000Z", // 02:30 CDT
      ]);
    });

    it("fires a fixed time the autumn repeats once, at its first occurrence", () => {
      // 2026-11-01: 02:00 CDT falls back to 01:00 CST, so 01:30 happens twice.
      expect(iso(nextFires(chicago("30 1 * * *"), at("2026-10-31T12:00:00Z"), 2))).toEqual([
        "2026-11-01T06:30:00.000Z", // 01:30 CDT
        "2026-11-02T07:30:00.000Z", // 01:30 CST, the next day
      ]);
    });

    it("skips an interval's times in the spring gap", () => {
      expect(iso(nextFires(chicago("*/30 * * * *"), at("2026-03-08T07:00:00Z"), 3))).toEqual([
        "2026-03-08T07:30:00.000Z", // 01:30 CST
        "2026-03-08T08:00:00.000Z", // 03:00 CDT: 02:00 and 02:30 are skipped
        "2026-03-08T08:30:00.000Z",
      ]);
    });

    it("fires an interval's repeated times on both occurrences", () => {
      expect(iso(nextFires(chicago("*/30 * * * *"), at("2026-11-01T05:45:00Z"), 5))).toEqual([
        "2026-11-01T06:00:00.000Z", // 01:00 CDT
        "2026-11-01T06:30:00.000Z", // 01:30 CDT
        "2026-11-01T07:00:00.000Z", // 01:00 CST
        "2026-11-01T07:30:00.000Z", // 01:30 CST
        "2026-11-01T08:00:00.000Z", // 02:00 CST
      ]);
    });
  });
});

describe("dueFires", () => {
  const hourly = chicago("0 * * * *");

  it("has nothing due before the next Fire time", () => {
    expect(
      dueFires(hourly, { after: at("2026-11-07T10:00:00Z"), now: at("2026-11-07T10:59:59Z") }),
    ).toEqual({ fire: undefined, missed: [] });
  });

  it("fires the one time that came due", () => {
    expect(
      dueFires(hourly, { after: at("2026-11-07T10:00:00Z"), now: at("2026-11-07T11:00:02Z") }),
    ).toEqual({ fire: at("2026-11-07T11:00:00Z"), missed: [] });
  });

  it("fires a time due exactly now, as the alarm set for it wakes", () => {
    expect(
      dueFires(hourly, { after: at("2026-11-07T10:00:00Z"), now: at("2026-11-07T11:00:00Z") }),
    ).toEqual({ fire: at("2026-11-07T11:00:00Z"), missed: [] });
    expect(
      dueFires(hourly, {
        after: at("2026-11-07T10:00:00Z"),
        now: at("2026-11-07T11:00:00Z") + 1,
      }),
    ).toEqual({ fire: at("2026-11-07T11:00:00Z"), missed: [] });
  });

  it("fires once, for the latest missed time, and lists the others as missed, oldest first", () => {
    const due = dueFires(hourly, {
      after: at("2026-11-07T10:00:00Z"),
      now: at("2026-11-07T14:20:00Z"),
    });

    expect(due.fire).toBe(at("2026-11-07T14:00:00Z"));
    expect(iso(due.missed)).toEqual([
      "2026-11-07T11:00:00.000Z",
      "2026-11-07T12:00:00.000Z",
      "2026-11-07T13:00:00.000Z",
    ]);
  });

  it("lists at most `keep` missed times, the latest ones, however long the gap", () => {
    const due = dueFires(chicago("* * * * *"), {
      after: at("2026-01-01T00:00:00Z"),
      now: at("2026-11-07T00:00:30Z"),
      keep: 3,
    });

    expect(due.fire).toBe(at("2026-11-07T00:00:00Z"));
    expect(iso(due.missed)).toEqual([
      "2026-11-06T23:57:00.000Z",
      "2026-11-06T23:58:00.000Z",
      "2026-11-06T23:59:00.000Z",
    ]);
  });
});

describe("scheduleProblem", () => {
  it("needs both a valid expression and a zone", () => {
    expect(scheduleProblem({ cron: "0 9 * * MON", zone: "America/Chicago" })).toBeUndefined();
    expect(scheduleProblem({ cron: "0 9 * * MON", zone: "" })).toMatch(/zone/);
    expect(scheduleProblem({ cron: "0 0 9 * * MON", zone: "America/Chicago" })).toMatch(/5 fields/);
  });
});
