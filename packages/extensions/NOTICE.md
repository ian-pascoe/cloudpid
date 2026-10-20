# Notices

The web tools in `src/web/` are a port of [`@ian-pascoe/pi-web-tools`](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-web-tools)
(version 0.6.7, commit `c126370`), the owner's own package, released under the MIT licence:

> MIT License
>
> Copyright 2026 Ian Pascoe
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

What was ported, and what changed:

| Here                    | From                                   | Change                                                                                      |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `json-reindent.ts`      | `json-reindent.ts`                     | none                                                                                        |
| `html-main-content.ts`  | `html-main-content.ts`                 | none                                                                                        |
| `content.ts`            | `web-fetch.ts` (`convertHtmlPage`)     | moved; uses the converter below                                                             |
| `html-text.ts`          | `web-fetch.ts` (`extractTextFromHtml`) | moved                                                                                       |
| `html-markdown.ts`      | `html-markdown.ts`, Turndown           | rewritten as one linear pass over htmlparser2 events; Turndown needs a DOM and is quadratic |
| `output.ts`             | `web-tool-output.ts`                   | no temp-file spill: continuation notes name the next `offset`                               |
| `response.ts`           | `web-response.ts`                      | Effect; no Node `http`                                                                      |
| `fetch.ts`, `search.ts` | `web-fetch.ts`, `web-search.ts`        | Effect Schema and Effect tools; SSRF guard; Exa/Parallel keys from deploy-time secrets      |

The Secrets in `src/secrets/` are a port of [`@ian-pascoe/pi-secret`](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-secret)
(version 0.3.0, commit `3dad0f7`) and the redaction in its sibling `@ian-pascoe/pi-utils` (`secret-registry.ts`), the
owner's own packages, under the same MIT licence. 1Password and Env File Secret Providers, Secret Grants,
`secret_ask_grant`, and `secret_save` are not ported (v2).

| Here            | From                                        | Change                                                                                                                                                       |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `references.ts` | `secret-references.ts`                      | none beyond Effect predicates                                                                                                                                |
| `redaction.ts`  | `pi-utils/secret-registry.ts` (redaction)   | per Session instance instead of process-wide; WebCrypto-free encoders instead of `Buffer`; adds a chunked stream redactor                                    |
| `vault.ts`      | `secret-vault.ts`                           | WebCrypto; one HKDF-derived key per Session from a Worker-secret master key instead of a key file with a key per Secret                                      |
| `store.ts`      | `pi-secret-extension.ts` (state, `context`) | values entered in a masked form on the web client and stored in the Session DO; a message redacted once keeps its redacted form in storage across evictions  |
| `extension.ts`  | `pi-secret-extension.ts` (tools, hooks)     | pi-durable hooks; references resolved inside tool wraps rather than in `tool_call`, so no value enters durable state; injected per command, not process-wide |
