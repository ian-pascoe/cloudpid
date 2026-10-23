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
