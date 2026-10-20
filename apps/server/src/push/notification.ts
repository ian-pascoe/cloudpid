// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain function over text.
// What a push says (`docs/spec.md` → Client and protocol → Notifications): a title, a line of body, and the Session's
// page, small enough for any push service and for a lock screen.
import { sessionPagePath } from "@cloudpid/protocol";

/** Something a Session tells the owner about. */
export type PushEvent =
  | PushNotice
  /** A Run ended with an answer. */
  | { readonly kind: "finished" }
  /** A Run ended without one: a model error, a restart limit. `reason` is the error's text, when there is one. */
  | { readonly kind: "failed"; readonly reason?: string | undefined }
  /** The agent waits for the owner to enter Secrets. */
  | {
      readonly kind: "input";
      readonly names: ReadonlyArray<string>;
      readonly reason?: string | undefined;
    };

/**
 * Anything else the owner should hear, in the Session's name: the caller words it. `url` is where tapping it goes
 * (a path of the app, or an absolute URL such as a Browser Handoff's Live View); the Session's page by default.
 */
export type PushNotice = {
  readonly kind: "notice";
  readonly title?: string | undefined;
  readonly body: string;
  readonly url?: string | undefined;
};

/** The JSON a push carries, which the service worker shows. */
export type PushPayload = {
  readonly title: string;
  readonly body: string;
  /** The Session's page, relative to the app's origin. */
  readonly url: string;
  /** A notification with the same tag replaces the one on screen, so a repeat does not pile up. */
  readonly tag: string;
};

const MAX_TITLE = 80;
const MAX_BODY = 140;

/** `text` on one line, cut to `max` characters with an ellipsis. */
const brief = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

const body = (event: PushEvent): string => {
  switch (event.kind) {
    case "notice":
      return event.body;
    case "finished":
      return "Run finished";
    case "failed":
      return event.reason === undefined || event.reason.trim() === ""
        ? "Run failed"
        : `Run failed: ${event.reason}`;
    case "input": {
      const asked = event.names.length === 0 ? "" : `: ${event.names.join(", ")}`;

      return `Needs input${asked}${event.reason === undefined ? "" : ` (${event.reason})`}`;
    }
  }
};

/** The push for `event` in Session `session`, titled by the Session's title once it has one. */
export const describeEvent = (
  event: PushEvent,
  session: { readonly id: string; readonly title: string | null },
): PushPayload => ({
  title: brief(
    event.kind === "notice" && event.title !== undefined
      ? event.title
      : (session.title ?? "Session"),
    MAX_TITLE,
  ),
  body: brief(body(event), MAX_BODY),
  url: event.kind === "notice" && event.url !== undefined ? event.url : sessionPagePath(session.id),
  tag: `${session.id}:${event.kind}`,
});
