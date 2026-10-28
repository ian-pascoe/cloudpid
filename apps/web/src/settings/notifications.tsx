// Global's Notifications section of the Settings page: whether this device gets a push when a Run ends, fails, or
// needs input (docs/architecture/client-and-protocol.md → Notifications). It takes effect at once, like no other
// section's setting, so it has no Save.

import { useAtom, useAtomValue } from "@effect/atom-react";
import { Button } from "../components/ui/button.tsx";
import { disablePushAtom, enablePushAtom, pushStatusValueAtom } from "../push-state.ts";
import { Group, SettingsSection } from "./parts.tsx";

export const NotificationsSection = () => {
  const status = useAtomValue(pushStatusValueAtom);
  const [enabling, enable] = useAtom(enablePushAtom);
  const [disabling, disable] = useAtom(disablePushAtom);
  const busy = enabling.waiting || disabling.waiting;
  const on = status?.kind === "on";

  return (
    <SettingsSection
      title="Notifications"
      description="A push to this device when a run finishes or fails, or when the agent needs you to enter a secret or approve a change, linking to the session. Each device chooses for itself."
    >
      <Group title="This device">
        {status?.kind === "unsupported" && (
          <p className="text-sm text-muted-foreground">
            This browser cannot receive push notifications. On an iPhone or iPad, add the app to the
            home screen first.
          </p>
        )}
        {status?.kind === "denied" && (
          <p role="alert" className="text-sm text-destructive">
            Notifications are blocked for this site. Allow them in the browser's site settings, then
            turn them on here.
          </p>
        )}
        {status?.kind === "error" && (
          <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
            {status.message}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant={on ? "outline" : "default"}
            disabled={
              status === null || busy || status.kind === "unsupported" || status.kind === "denied"
            }
            onClick={() => {
              if (on) disable();
              else enable();
            }}
          >
            {busy ? "Working…" : on ? "Turn off on this device" : "Turn on for this device"}
          </Button>
          {on && (
            <span role="status" className="text-sm text-muted-foreground">
              On for this device
            </span>
          )}
        </div>
      </Group>
    </SettingsSection>
  );
};
