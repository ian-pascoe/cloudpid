---
status: accepted
---

# Trigger URLs sit outside Access, behind a secret token and a required signature

A webhook sender (GitHub, or any service the owner pastes a URL into) can't pass Cloudflare Access, so a Trigger's deliveries must reach the main Worker on a public path. Each Trigger's **Trigger URL** is `<origin>/hooks/<trigger id>/<token>`, the token 256 random bits (43 base64url characters), and every delivery must also be signed with its **Signing secret**, another 256 bits. There is no unsigned mode. Each Trigger names one format: `github` (`X-Hub-Signature-256`, an HMAC-SHA256 of the raw body) or `standard` (Standard Webhooks' `webhook-id`, `webhook-timestamp` and `webhook-signature`, with its 5-minute timestamp window). The HMAC proves the sender; the token only turns away noise cheaply and hides that the Trigger exists, since a URL leaks (GitHub shows a hook's URL to the repo's admins).

`<host>/hooks/*` is the one destination of a new Access application, `Server/Hooks`, with a Bypass/Everyone policy, declared as `Server/Bypass` is (only while the Worker is live, `domain` set and `adopt: true`). Bare `/hooks` and the rest of the stage stay behind Access. The main Worker checks the path's exact shape (a UUIDv7, then a 43-character token), answers 404 for anything else under `/hooks`, and hands the request to the Trigger's object, which compares the token's hash in constant time, then the HMAC over the bytes received, then the Trigger's filters. Only an accepted, matching delivery reaches the Registry.

The token and the Signing secret are made by the Trigger object and kept only there, sealed with the vault bound to its id. The agent never sees either; the owner can reveal them on the Trigger's page at any time, and replace either at once with no overlap (a hook cloudpid made on GitHub is updated in the same action). A reverted removal brings the Trigger back with a new URL and secret.

## Considered options

- **A signature only when a secret is set:** allows URL-only Triggers, a weaker mode the owner didn't ask for. The cost of refusing it is that a sender that can't sign is unsupported.
- **The secret in a header instead of the path:** GitHub's hooks can't send a custom header, and a query string is logged as the path is.
- **Only the Trigger's id in the URL:** the owner asked for both a secret URL and a signature.
- **A third destination on `Server/Bypass`:** it changes an application ADR-0035 records exactly, to save one resource. Its own application can also take its own policy later (GitHub's IP ranges, say).
- **Service Auth:** a sender can't present Access's service token headers.
- **Accepting the old and new secret side by side after a rotation:** extra state for something rotated rarely.

## Consequences

- The token is in the path, so it lands in the owner's own Workers Logs (kept 7 days, readable only from the owner's account). cloudpid's own spans and logs record only the route template, `/hooks/:id/:token`. Rotation is the remedy for a leak; turning off invocation logs (every route's) or a Tail Worker that strips the URL were judged not worth it.
- Access logs nothing on a bypassed path, so cloudpid's spans are the only record of deliveries, and refused ones are only counted per day.
- Access lets through more than the exact shape (sub-paths, other capitalisation), as it does for ADR-0035's paths; the Worker's exact-shape router is what refuses them.
- An unknown id reaches an object with no storage, which answers 404 and writes nothing.
- A preview stage runs unreviewed code on a public path, as it does for ADR-0035's.
- A pasted Trigger URL must be pasted again after a rotation or a reverted removal.
