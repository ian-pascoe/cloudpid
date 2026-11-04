# Notices

The Live View's typing (`src/live-view/typed-text.ts`, and the input sentinel as `src/live-view/keyboard.ts` uses it)
is ported from [Kernel's live view](https://github.com/kernel/kernel-images) (`kernel/kernel-images` at commit
`2c3fabc9a04a9f445870f183e21e3475104cb8cc`), released under the Apache License, Version 2.0. The licence's text is in
[`LICENSES/kernel-images.LICENSE`](LICENSES/kernel-images.LICENSE); the upstream repository has no `NOTICE` file.

> Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
> the License. You may obtain a copy of the License at
>
> http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
> an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
> specific language governing permissions and limitations under the License.

What was ported, and what changed:

| Here                                | From (`images/chromium-headful/client/src/`)                                        | Change                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typed-text.ts` (`TypedText`)       | `utils/typed-text.ts` (`TypedText`)                                                 | `edit` returns the edit (Backspaces, text, whether to start over) instead of calling outputs                                                                                                                                            |
| `typed-text.ts` (`textDiff`)        | `utils/text-input.ts` (`textDiff`)                                                  | none                                                                                                                                                                                                                                    |
| `typed-text.ts` (`INPUT_SENTINEL`)  | `components/video.vue` (`INPUT_SENTINEL`)                                           | none                                                                                                                                                                                                                                    |
| `keyboard.ts` (`input`, `reset`, …) | `components/video.vue` (`resetInputSentinel`, `onOverlayInput`, `onCompositionEnd`) | CDP `Input.insertText` and key events instead of X keysyms; one diff path whether or not text is kept for autocorrect (kept where the field's keyboard corrects); line breaks sent as Enter; a tap, an arrow key or a paste starts over |

## ext-apps example View (test fixture)

The test fixture `src/app-view/fixtures/get-time/` is the unmodified source of the
[`basic-server-vanillajs` example](https://github.com/modelcontextprotocol/ext-apps/tree/07cda2513b0b691ac261ac69c856062c9afb2824/examples/basic-server-vanillajs)
of [`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) at commit
`07cda2513b0b691ac261ac69c856062c9afb2824` (`mcp-app.html`, `src/mcp-app.ts`, `src/global.css` and `src/mcp-app.css`, each with a
`.txt` extension added so no tool reads them as this package's code). The project is moving from the MIT License to the Apache
License, Version 2.0: its new contributions are Apache-2.0 and those whose authors have not consented to relicense remain
MIT, so the files are used under the terms of both. The upstream `LICENSE`, with the Apache-2.0 text and the MIT text
("Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC."), is in
[`LICENSES/ext-apps.LICENSE`](LICENSES/ext-apps.LICENSE); the upstream repository has no `NOTICE` file. The fixture is only
read by the test `src/app-view/example-view.test.ts`; nothing of it is in the app.
