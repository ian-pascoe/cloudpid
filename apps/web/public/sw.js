// The web app's service worker (`docs/spec.md` → Client and protocol → Notifications). It exists for Web Push: it shows
// the notification a Session's push carries and opens that Session's page when the owner taps it. It caches nothing,
// so the app is never stale and a deploy needs no cache bust. Plain JavaScript, served as is from the site's root so
// its scope is the whole app.

/** What the Registry's push says (`apps/server/src/push/notification.ts`): title, body, url, tag. */
const readPayload = (event) => {
  if (event.data === null || event.data === undefined) return {};

  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
};

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const { title, body, url, tag } = readPayload(event);

  const options = {
    body: body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: url || "/" },
  };

  // A newer notification of a Session replaces the older one, and still alerts.
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(title || "Pi on Cloudflare", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(event.notification.data?.url || "/", self.location.origin);

  event.waitUntil(
    (async () => {
      // A page of another origin (a Live View) is not ours to focus: open it.
      if (target.origin === self.location.origin) {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const open = windows.find((client) => client.url === target.href) ?? windows[0];

        if (open !== undefined) {
          await open.focus();

          if (open.url !== target.href) {
            try {
              await open.navigate(target.href);
            } catch {
              // A page the worker cannot navigate keeps what it shows; the notification is dismissed anyway.
            }
          }

          return;
        }
      }

      await self.clients.openWindow(target.href);
    })(),
  );
});
