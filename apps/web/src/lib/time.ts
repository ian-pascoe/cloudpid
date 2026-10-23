// @effect-diagnostics globalDate:off -- a time shown in the browser's own time of day format.

/** The time of day of `ms` (since the epoch), as the owner reads it: when a Browser Handoff times out, say. */
export const timeOfDay = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
