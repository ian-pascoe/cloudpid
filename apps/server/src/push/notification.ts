// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain function over text.
// What a push says (`docs/architecture/client-and-protocol.md` → Notifications): a title, a line of body, and the Session's
// page, small enough for any push service and for a lock screen.
import { MAX_NOTICE_URL_LENGTH, type PushEvent } from "@cloudpid/extensions/notify";
import { sessionPagePath } from "@cloudpid/protocol";

export type { PushEvent, PushNotice } from "@cloudpid/extensions/notify";

/** The JSON a push carries, which the service worker shows. */
export type PushPayload = {
  readonly title: string;
  readonly body: string;
  /** Where a tap goes: the Session's page (with the Panes a notice opens), relative to the app's origin. */
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
      if (event.signIn !== undefined) {
        return `Sign-in needed: ${event.signIn.server} — ${event.signIn.reason}`;
      }

      if (event.mcp !== undefined) {
        return event.mcp.kind === "sampling"
          ? `${event.mcp.server} asks to use a model`
          : event.mcp.page === true
            ? `${event.mcp.server} asks you to open a page`
            : `${event.mcp.server} needs your input`;
      }

      if (event.approval !== undefined) {
        return `Approval needed: ${event.approval}${event.reason === undefined ? "" : ` (${event.reason})`}`;
      }

      const asked = event.names.length === 0 ? "" : `: ${event.names.join(", ")}`;

      return `Needs input${asked}${event.reason === undefined ? "" : ` (${event.reason})`}`;
    }
  }
};

/** A URL as it is written on the wire: printable ASCII only, so its JSON stays as long as it looks. */
const PLAIN_URL = /^[\x21-\x7e]+$/;

/**
 * Where a tap goes: the notice's own URL when it is usable (a query, such as a Browser Handoff's `?pane=live-view:7`, on
 * the Session's page), otherwise the Session's page.
 */
const target = (event: PushEvent, sessionId: string): string => {
  if (
    event.kind !== "notice" ||
    event.url === undefined ||
    event.url.length > MAX_NOTICE_URL_LENGTH ||
    !PLAIN_URL.test(event.url)
  ) {
    return sessionPagePath(sessionId);
  }

  return event.url.startsWith("?") ? `${sessionPagePath(sessionId)}${event.url}` : event.url;
};

/**
 * What a push's tag names: its kind, an Approval request apart from a Secret request, so neither replaces the other, and
 * an MCP server's question by the server (`mcp-input:<server>`).
 */
const tagKind = (event: PushEvent): string => {
  if (event.kind !== "input") return event.kind;

  if (event.signIn !== undefined) return `mcp-sign-in:${event.signIn.key}`;

  if (event.mcp !== undefined) return `mcp-input:${event.mcp.server}`;

  return event.approval !== undefined ? "approval" : event.kind;
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
  url: target(event, session.id),
  tag: `${session.id}:${tagKind(event)}`,
});

/**
 * The push for a Trigger's Fire that failed (`docs/architecture/triggers.md` → Fire records, origin marks and
 * notifications), titled by the Trigger, linking to its Environment's Triggers section; tagged by the Trigger, so one
 * Notification stands per Trigger.
 */
export const describeTriggerFailure = (
  trigger: { readonly id: string; readonly name: string; readonly environment: string },
  reason: string,
): PushPayload => ({
  title: brief(trigger.name, MAX_TITLE),
  body: brief(`Trigger failed: ${reason}`, MAX_BODY),
  url: `/settings/${encodeURIComponent(trigger.environment)}/triggers`,
  tag: `trigger:${trigger.id}:failed`,
});
