// @effect-diagnostics missingPipeableSignature:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

/** "just now", "5 minutes ago", "yesterday": how long before `now` a time was, for a list of Sessions. */
export const relativeTime = (time: number, now: number): string => {
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(seconds) < 45) return "just now";

  const minutes = Math.round(seconds / 60);

  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");

  const hours = Math.round(minutes / 60);

  if (Math.abs(hours) < 24) return format.format(hours, "hour");

  return format.format(Math.round(hours / 24), "day");
};
