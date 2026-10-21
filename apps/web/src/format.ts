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

/** "12 ms", "1.5 s", "2 min 5 s": how long a call took. */
export const duration = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;

  const seconds = milliseconds / 1000;

  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;

  if (seconds < 60) return `${Math.round(seconds)} s`;

  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
};

/** "$0.42", "$12.50", "$0.003": US dollars, with the cents a small amount needs to show it is not nothing. */
export const dollars = (amount: number): string => {
  if (amount === 0) return "$0.00";

  if (amount < 0.01) return `$${amount.toPrecision(1)}`;

  return `$${amount.toFixed(2)}`;
};

/** "950", "12.3k", "1.2M": a token count, for a header. */
export const tokenCount = (tokens: number): string => {
  if (tokens < 1_000) return String(Math.round(tokens));

  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`;

  return `${Math.round(tokens / 100_000) / 10}M`;
};

/** How near a Session is to its limit: `none` without one, `over` at or past it, `near` from four fifths. */
export const spendLevel = (cost: number, limit: number | null): "none" | "ok" | "near" | "over" => {
  if (limit === null) return "none";

  if (cost >= limit) return "over";

  return cost >= limit * 0.8 ? "near" : "ok";
};
