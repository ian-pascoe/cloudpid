// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off nodeBuiltinImport:off -- the service worker is plain JavaScript run here against a fake `self`.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

/** What the worker asks of a notification: its text, its replacement tag, and where a tap goes. */
type NotificationOptions = {
  body?: string;
  tag?: string;
  renotify?: boolean;
  data?: { url: string };
};

/** The payload of a push, as the Registry writes it. */
type Payload = { title?: string; body?: string; url?: string; tag?: string };

/** The events the worker handles, as far as it reads them. */
type FakeEvent = {
  data?: { json: () => Payload; text: () => string };
  notification?: { close: () => void; data: { url: string } | undefined };
  waitUntil?: (promise: Promise<unknown>) => void;
};

type Listener = (event: FakeEvent) => void;

type Client = {
  url: string;
  focused: boolean;
  navigatedTo?: string;
  focus: () => Promise<void>;
  navigate: (url: string) => Promise<void>;
};

const client = (url: string): Client => {
  const value: Client = {
    url,
    focused: false,
    focus: () => {
      value.focused = true;

      return Promise.resolve();
    },
    navigate: (to) => {
      value.navigatedTo = to;

      return Promise.resolve();
    },
  };

  return value;
};

/** The service worker, run against a fake worker scope; `dispatch` delivers an event and waits for what it waits on. */
const load = (windows: Client[] = []) => {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: NotificationOptions }> = [];
  const opened: string[] = [];

  const self = {
    location: { origin: "https://pi.example.dev" },
    registration: {
      showNotification: (title: string, options: NotificationOptions) => {
        shown.push({ title, options });

        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => {
        opened.push(url);

        return Promise.resolve(null);
      },
    },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
  };

  runInNewContext(source, { self, URL, Promise });

  const dispatch = async (type: string, event: FakeEvent) => {
    const waits: Promise<unknown>[] = [];

    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);
  };

  return { dispatch, shown, opened };
};

const pushOf = (payload: Payload): FakeEvent => ({
  data: { json: () => payload, text: () => JSON.stringify(payload) },
});

const clicked = (url: string | undefined) => {
  const state = { closed: false };

  return {
    state,
    event: {
      notification: {
        close: () => {
          state.closed = true;
        },
        data: url === undefined ? undefined : { url },
      },
    },
  };
};

describe("the service worker", () => {
  it("shows the notification a push carries, tagged so a repeat replaces it", async () => {
    const { dispatch, shown } = load();

    await dispatch(
      "push",
      pushOf({
        title: "Fix the build",
        body: "Run finished",
        url: "/sessions/s-1",
        tag: "s-1:finished",
      }),
    );

    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Fix the build");
    expect(shown[0]?.options).toMatchObject({
      body: "Run finished",
      tag: "s-1:finished",
      renotify: true,
      data: { url: "/sessions/s-1" },
    });
  });

  it("still shows something for a push with no readable payload", async () => {
    const { dispatch, shown } = load();

    await dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("not json");
        },
        text: () => "hello",
      },
    });
    await dispatch("push", {});

    expect(shown.map((one) => one.title)).toEqual(["Pi on Cloudflare", "Pi on Cloudflare"]);
    expect(shown[0]?.options).toMatchObject({ body: "hello" });
  });

  it("focuses the window already showing the session", async () => {
    const open = client("https://pi.example.dev/sessions/s-1");
    const other = client("https://pi.example.dev/");
    const { dispatch, opened } = load([other, open]);
    const click = clicked("/sessions/s-1");

    await dispatch("notificationclick", click.event);

    expect(click.state.closed).toBe(true);
    expect(open.focused).toBe(true);
    expect(open.navigatedTo).toBeUndefined();
    expect(other.focused).toBe(false);
    expect(opened).toEqual([]);
  });

  it("takes another open window of the app to the session", async () => {
    const open = client("https://pi.example.dev/settings");
    const { dispatch, opened } = load([open]);

    await dispatch("notificationclick", clicked("/sessions/s-1").event);

    expect(open.focused).toBe(true);
    expect(open.navigatedTo).toBe("https://pi.example.dev/sessions/s-1");
    expect(opened).toEqual([]);
  });

  it("opens the session when no window is open", async () => {
    const { dispatch, opened } = load([]);

    await dispatch("notificationclick", clicked("/sessions/s-1").event);

    expect(opened).toEqual(["https://pi.example.dev/sessions/s-1"]);
  });

  it("opens a page of another origin in a new window, never in the app's", async () => {
    const open = client("https://pi.example.dev/sessions/s-1");
    const { dispatch, opened } = load([open]);

    await dispatch("notificationclick", clicked("https://live.example.net/view/1").event);

    expect(opened).toEqual(["https://live.example.net/view/1"]);
    expect(open.focused).toBe(false);
  });

  it("opens the app's start page for a notification with no link", async () => {
    const { dispatch, opened } = load([]);

    await dispatch("notificationclick", clicked(undefined).event);

    expect(opened).toEqual(["https://pi.example.dev/"]);
  });
});
