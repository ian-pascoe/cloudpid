// A fake GitHub for a Trigger's GitHub-managed hook (`github-hook.ts`), in Node and in workerd alike: the App's own
// endpoints (`/app`, its installations, a token per mint) and each repo's hooks, kept in memory. An installation mints
// a token that asks for `repository_hooks` only once its account has accepted Webhooks: write (`accepted`), as GitHub
// refuses the mint with a 422 otherwise; a repo takes at most `limit` hooks per event, as GitHub's 20. `down` makes the
// hooks' calls answer 503. Every request is recorded (`seen`), its body as sent.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off -- a `fetch` stand-in, over native arrays.

/** A hook the fake keeps on a repo. */
export type FakeHook = {
  readonly id: number;
  readonly url: string;
  readonly secret: string;
  readonly events: ReadonlyArray<string>;
  readonly contentType: string;
};

/** A request the fake GitHub was sent: its method, its path (with its query) and its body. */
export type SeenRequest = {
  readonly method: string;
  readonly path: string;
  readonly token: string;
  readonly body: string;
};

/** What the fake GitHub is set up with; each can change between calls. */
export type FakeGitHubState = {
  /** The accounts the App is installed on, by installation id. */
  installations: Array<{ readonly id: number; readonly login: string }>;
  /** The accounts whose installation accepted Webhooks: write. */
  accepted: Set<string>;
  /** The hooks of each repo, `owner/name`. */
  hooks: Map<string, Array<FakeHook>>;
  /** The most hooks one event may have on a repo. */
  limit: number;
  /** While set, every call on a repo's hooks answers 503. */
  down: boolean;
  /** Every request, in order. */
  seen: Array<SeenRequest>;
};

const HookBody = (body: string) =>
  // SAFETY: the code under test sends the hook's JSON; a test reads back what it sent.
  JSON.parse(body) as {
    readonly events: ReadonlyArray<string>;
    readonly config: {
      readonly url: string;
      readonly secret: string;
      readonly content_type: string;
    };
  };

/** A fake GitHub over `state`, as a `fetch`. */
export const fakeGitHub = (
  state: FakeGitHubState,
): ((url: string, init: RequestInit) => Promise<Response>) => {
  let next = 1;
  let minted = 0;

  return async (url, init) => {
    const method = init.method ?? "GET";
    const path = url.replace("https://api.github.com", "");

    const body =
      init.body === undefined || init.body === null ? "" : await new Response(init.body).text();

    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";

    state.seen.push({ method, path, token, body });

    if (method === "GET" && path === "/app") {
      return Response.json({ owner: { login: "ian-pascoe" }, slug: "cloudpid-app" });
    }

    if (method === "GET" && path === "/app/installations?per_page=100") {
      return Response.json(
        state.installations.map(({ id, login }) => ({ id, account: { login } })),
      );
    }

    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(path);

    if (method === "POST" && mint !== null) {
      const login = state.installations.find(({ id }) => String(id) === mint[1])?.login ?? "";

      // SAFETY: the App's mint names its permissions as JSON.
      const asked = JSON.parse(body === "" ? "{}" : body) as {
        readonly permissions?: Readonly<Record<string, string>>;
      };

      if (asked.permissions?.["repository_hooks"] !== undefined && !state.accepted.has(login)) {
        return Response.json(
          { message: "The permissions requested are not granted to this installation." },
          { status: 422 },
        );
      }

      minted += 1;

      return Response.json(
        { token: `ghs_${login}_${String(minted)}`, expires_at: "2999-01-01T00:00:00Z" },
        { status: 201 },
      );
    }

    const hooksPath = /^\/repos\/([^/]+\/[^/]+)\/hooks(?:\/(\d+))?(?:\?.*)?$/u.exec(path);

    if (hooksPath === null) return Response.json({ message: "Not Found" }, { status: 404 });

    if (state.down) return Response.json({ message: "Service Unavailable" }, { status: 503 });

    const repo = hooksPath[1] ?? "";
    const id = hooksPath[2] === undefined ? undefined : Number(hooksPath[2]);
    const hooks = state.hooks.get(repo) ?? [];

    state.hooks.set(repo, hooks);

    const at = hooks.findIndex((hook) => hook.id === id);

    switch (method) {
      case "GET":
        return Response.json(hooks.map((hook) => ({ id: hook.id, config: { url: hook.url } })));
      case "POST": {
        const asked = HookBody(body);

        const full = asked.events.find(
          (event) => hooks.filter((hook) => hook.events.includes(event)).length >= state.limit,
        );

        if (full !== undefined) {
          return Response.json(
            {
              message: "Validation Failed",
              errors: [
                {
                  message: `The "${full}" event cannot have more than ${String(state.limit)} hooks`,
                },
              ],
            },
            { status: 422 },
          );
        }

        const made = {
          id: next++,
          url: asked.config.url,
          secret: asked.config.secret,
          events: asked.events,
          contentType: asked.config.content_type,
        };

        hooks.push(made);

        return Response.json({ id: made.id }, { status: 201 });
      }

      case "PATCH": {
        if (at < 0) return Response.json({ message: "Not Found" }, { status: 404 });

        const asked = HookBody(body);

        hooks[at] = {
          id: id ?? 0,
          url: asked.config.url,
          secret: asked.config.secret,
          events: asked.events,
          contentType: asked.config.content_type,
        };

        return Response.json({ id });
      }

      case "DELETE":
        if (at < 0) return Response.json({ message: "Not Found" }, { status: 404 });

        hooks.splice(at, 1);

        return new Response(null, { status: 204 });
      default:
        return Response.json({ message: "Not Found" }, { status: 404 });
    }
  };
};

/** A fake GitHub's first state: the App installed on `o` (id 11) and `other` (22), `o` having accepted Webhooks: write. */
export const fakeGitHubState = (): FakeGitHubState => ({
  installations: [
    { id: 11, login: "o" },
    { id: 22, login: "other" },
  ],
  accepted: new Set(["o"]),
  hooks: new Map(),
  limit: 20,
  down: false,
  seen: [],
});
