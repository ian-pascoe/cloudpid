// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain function over text.
// What a push says (`docs/architecture/client-and-protocol.md` → Notifications): a title, a line of body, and the Session's
// page, small enough for any push service and for a lock screen.
import { MAX_NOTICE_URL_LENGTH, type PushEvent } from "@cloudpid/extensions/notify";
import {
  type AgentChangeVia,
  agentChangesPath,
  agentChangeViaLabel,
  approvalPath,
  sessionPagePath,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

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

/**
 * The push for an Approval asked over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → After a change, and
 * Notifications; Approvals with no Session): titled by the change and its target, its body who asked and why, opening
 * its card (`approvalPath`). Tagged `approval:<id>`, so it is one Notification per request.
 */
export const describeApproval = (approval: {
  readonly id: string;
  readonly scope: string;
  readonly section: string;
  readonly card: { readonly change: string; readonly target: string; readonly reason: string };
  readonly via: Pick<AgentChangeVia, "client">;
}): PushPayload => ({
  title: brief(`Approve? ${approval.card.change} · ${approval.card.target}`, MAX_TITLE),
  body: brief(
    `Asked via ${approval.via.client === undefined ? "MCP" : `${approval.via.client.name} (MCP)`}: ${approval.card.reason}`,
    MAX_BODY,
  ),
  url: approvalPath(approval.scope, approval.section, approval.id),
  tag: `approval:${approval.id}`,
});

/** One of the changes an agent made over the MCP endpoint, as a Notification lists it. */
export type McpChangeLine = {
  readonly id: number;
  /** The Scope whose Agent changes section shows the change: an Environment's id, or `*` for Global (the Settings' are there). */
  readonly scope: string;
  /** What the body calls the Scope: "Default", "Global", "Settings". */
  readonly scopeName: string;
  readonly field: string;
};

/**
 * The push for the changes a caller made over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → After a change,
 * and Notifications), in any order: titled "Changed over MCP · <client>", its body the fields changed by Scope name
 * ("Default: variables.API_URL, name; Global: instructions"), linking to the newest change in its Scope's Agent changes
 * section. Tagged by `caller` (who it is: the Registry's rule), so a burst of calls leaves one Notification.
 */
export const describeMcpChanges = (
  who: { readonly via: Pick<AgentChangeVia, "client">; readonly caller: string },
  changes: Arr.NonEmptyReadonlyArray<McpChangeLine>,
): PushPayload => {
  const newest = Arr.sort(
    changes,
    Order.mapInput(Order.flip(Order.Number), (line: McpChangeLine) => line.id),
  );

  const latest = Arr.headNonEmpty(newest);
  const groups = new Map<string, string[]>();

  for (const { scopeName, field } of newest) {
    const fields = groups.get(scopeName) ?? [];

    if (!fields.includes(field)) fields.push(field);

    groups.set(scopeName, fields);
  }

  return {
    title: brief(agentChangeViaLabel(who.via), MAX_TITLE),
    body: brief(
      Array.from(groups, ([name, fields]) => `${name}: ${fields.join(", ")}`).join("; "),
      MAX_BODY,
    ),
    url: agentChangesPath(latest.scope, latest.id),
    tag: `mcp-changes:${who.caller}`,
  };
};
