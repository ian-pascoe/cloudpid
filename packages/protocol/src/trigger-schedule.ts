// A Trigger's Schedule (`docs/architecture/triggers.md` → Schedules): 5-field cron with names and the `@hourly`, `@daily`
// and `@weekly` shortcuts, in a required IANA zone, read by croner with its DST rules as they are. Pure, so the Registry,
// the Trigger object, the agent's tools and the owner's form (its preview of the next Fires) all read a Schedule alike.
// @effect-diagnostics missingPipeableSignature:off globalDate:off preferEffectArray:off -- plain functions over croner, which reads and answers Dates.
import { Cron } from "croner";
import { MAX_FIRE_LOG } from "./triggers.ts";

/** The shortcuts a Schedule takes besides 5-field cron. */
export const SCHEDULE_SHORTCUTS = ["@hourly", "@daily", "@weekly"] as const;

/** A Schedule: a cron expression and the IANA zone it is read in. */
export type Schedule = {
  readonly cron: string;
  readonly zone: string;
};

const NAMES = new Set([
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]);

const EXTENSION = /[LW#]/i;

/** Why one atom of a field (between `,`, `-` and `/`) is not plain cron, or undefined. */
const atomProblem = (atom: string): string | undefined => {
  if (atom === "*" || /^\d+$/.test(atom) || NAMES.has(atom.toUpperCase())) return undefined;

  if (atom !== "" && /^[0-9A-Za-z#]+$/.test(atom) && EXTENSION.test(atom)) {
    return "The L, W and # extensions are not taken: write the days out";
  }

  return `"${atom}" is not a cron value: use numbers, *, ranges, steps, lists and the names JAN–DEC and SUN–SAT`;
};

/** Why `cron` is not a Schedule's expression, or undefined when it is. */
export const cronProblem = (cron: string): string | undefined => {
  const expression = cron.trim();

  if (expression === "") return "A Schedule needs a cron expression";

  if (expression.startsWith("@")) {
    return SCHEDULE_SHORTCUTS.some((shortcut) => shortcut === expression.toLowerCase())
      ? undefined
      : `The only shortcuts are ${SCHEDULE_SHORTCUTS.join(", ")}`;
  }

  const fields = expression.split(/\s+/);

  if (fields.length !== 5) {
    return "A cron expression has 5 fields: minute, hour, day of month, month and day of week";
  }

  for (const field of fields) {
    for (const atom of field.split(/[,/-]/)) {
      const problem = atomProblem(atom);

      if (problem !== undefined) return problem;
    }
  }

  try {
    new Cron(expression, { mode: "5-part", paused: true });
  } catch (error) {
    return `Not a cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }

  return undefined;
};

/** Why `zone` is not an IANA time zone, or undefined when it is. */
export const zoneProblem = (zone: string): string | undefined => {
  if (zone === "") return "A Schedule needs an IANA time zone, such as America/Chicago";

  if (/^[+-]/.test(zone) || /^\d/.test(zone)) {
    return `"${zone}" is an offset: name an IANA time zone, such as America/Chicago`;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    return `"${zone}" is not an IANA time zone, such as America/Chicago`;
  }

  return undefined;
};

/** Why `schedule` can't be a Trigger's Schedule, or undefined when it can. */
export const scheduleProblem = (schedule: Schedule): string | undefined =>
  cronProblem(schedule.cron) ?? zoneProblem(schedule.zone);

/** What is due of a Schedule at a time: the one Fire to make, if any, and the earlier times due, recorded `missed`. */
export type DueFires = {
  readonly fire: number | undefined;
  readonly missed: ReadonlyArray<number>;
};

/** croner's reading of a valid `schedule`; it never runs anything. */
const cronOf = (schedule: Schedule): Cron => {
  const expression = schedule.cron.trim();

  return new Cron(expression.startsWith("@") ? expression.toLowerCase() : expression, {
    mode: "5-part",
    paused: true,
    timezone: schedule.zone,
  });
};

/** The next `count` Fire times of a valid `schedule` after `after` (epoch ms, never `after` itself), oldest first. */
export const nextFires = (schedule: Schedule, after: number, count: number): Array<number> =>
  cronOf(schedule)
    .nextRuns(count, new Date(after))
    .map((time) => time.getTime());

/**
 * What is due of a valid `schedule` at `now`, for a Trigger whose Fires were handled up to `after` (epoch ms): one Fire,
 * for the latest time due, however late (the catch-up Fire), and the earlier times due, which are recorded `missed`
 * (`docs/architecture/triggers.md` → Schedules), oldest first and at most `keep` of them (a fire log's worth,
 * `MAX_FIRE_LOG`), the latest ones.
 */
export const dueFires = (
  schedule: Schedule,
  { after, now, keep = MAX_FIRE_LOG }: { after: number; now: number; keep?: number },
): DueFires => {
  if (now <= after) return { fire: undefined, missed: [] };

  // croner's previous runs are before the reference, which it reads to the second: a time exactly at `now` is found
  // from a second on (a Schedule's times are whole minutes), and what is past `now` is filtered out.
  const due = cronOf(schedule)
    .previousRuns(keep + 1, new Date(now + 1000))
    .map((time) => time.getTime())
    .filter((time) => time > after && time <= now);

  return { fire: due[0], missed: due.slice(1).reverse() };
};
