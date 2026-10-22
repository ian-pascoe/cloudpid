# Live View spike (#152)

Throwaway. Checks whether our own page can speak CDP straight to the `wss` endpoint of a `Cloudflare.getLiveView`
link (ADR-0013), on its own `workers.dev` stack, apart from the app's stages. Results: `FINDINGS.md`.

- `worker.ts`: the Worker and its `Spike` Durable Object. The object launches a Browser Run session, holds a
  browser-level CDP connection to it through the `BROWSER` binding (as `apps/browser` does), opens the test page in a tab
  (`tab`) and a second page (`other`), and answers `/api/*`: `setup`, `mint` (a `Cloudflare.getLiveView` link, 60 s,
  `mode: "tab"`), `targets`, `handoff`, `cdp` (any command on its own connection, for what the agent sees), `info` (the
  `Cloudflare.handoffComplete` events it heard), `log`.
- `harness.html`: the page on the Worker's origin that mints links and runs each check over them, logging every CDP
  message on screen and to `/api/log` (frames summarized, JWTs redacted). Desktop checks are buttons (or
  `window.spike.run(n)`); the iPhone checks are the orange buttons and the viewer.
- `test-page.html`, `popup.html`: what the Browser Run tab shows.

Every route but the two test pages needs `?t=<SPIKE_TOKEN>`. Nothing logs a Live View link's JWT.

## Deploy and destroy

From this directory, with alchemy linked from `infra` (`ln -s ../../infra/node_modules node_modules`) and a token
(`SPIKE_TOKEN=$(openssl rand -hex 16)`) in the environment:

```sh
./node_modules/.bin/alchemy deploy alchemy.run.ts --stage spike --yes --force
./node_modules/.bin/alchemy destroy alchemy.run.ts --stage spike --yes
```

`--force` because alchemy otherwise plans no change for an edited `worker.ts` here. A running Durable Object keeps its
old code after a deploy, so the object's name carries `VERSION` (`worker.ts`): bump it when the object's code changes
(and `POST /api/close-session` on the old one first, so its browser closes).
