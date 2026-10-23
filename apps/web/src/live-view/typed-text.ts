// Ported from Kernel's live view: kernel/kernel-images at commit 2c3fabc9a04a9f445870f183e21e3475104cb8cc
// (https://github.com/kernel/kernel-images), `images/chromium-headful/client/src/utils/typed-text.ts` (`TypedText`) and
// `utils/text-input.ts` (`textDiff`), with the sentinel of `components/video.vue` (`INPUT_SENTINEL`).
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
// the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0 (and in
// `apps/web/LICENSES/kernel-images.LICENSE`). Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the License for the specific language governing permissions and limitations under
// the License.
//
// Changed here: `edit` returns the edit (Backspaces and text) instead of calling outputs, which the keyboard turns into
// CDP key events and `Input.insertText` rather than X keysyms; the sentinel lives with it. See `apps/web/NOTICE.md`.
//
// Keeps the text typed into the tab's field in the typing textarea, so the soft keyboard can autocorrect it: iOS
// autocorrect, predictive text and dictation change text already typed (a replacement, or a whole word at once) instead
// of sending keys. Each change to the textarea is diffed against what was sent and goes to the tab as Backspaces and
// text, so the text before the tab's caret keeps matching the textarea.

/**
 * What the typing textarea always holds before the caret, so iOS has something to delete and sends Backspace even in an
 * empty field (an empty textarea gets no input event for it).
 */
export const INPUT_SENTINEL = " ";

/** Past this the textarea starts over, at the cost of the corrections reaching back. */
const MAX_TEXT = 1000;

/** How many characters to delete from the end, then what to insert. */
export interface TextDiff {
  readonly deletes: number;
  readonly insert: string;
}

/** The smallest edit that turns `previous` into `next`: delete from the end, then insert. By code point. */
export const textDiff = (previous: string, next: string): TextDiff => {
  const a = Array.from(previous);
  const b = Array.from(next);
  let common = 0;

  while (common < a.length && common < b.length && a[common] === b[common]) common++;

  return { deletes: a.length - common, insert: b.slice(common).join("") };
};

/** One edit of the textarea, for the tab: Backspaces, then text; `kept` false when the textarea should start over. */
export interface TypedEdit {
  readonly backspaces: number;
  readonly insert: string;
  readonly kept: boolean;
}

/** The textarea's text after the sentinel, as sent to the tab. */
export class TypedText {
  private text = "";

  /** The textarea was reset to the sentinel, or its text was dropped. */
  reset(): void {
    this.text = "";
  }

  /**
   * The textarea's value after an edit, as the edit to send. Not `kept` when the textarea should be reset: its sentinel
   * was deleted (which stands for a character typed before the textarea last started over), or it holds too much.
   */
  edit(value: string): TypedEdit {
    const kept = value.startsWith(INPUT_SENTINEL);
    const next = kept ? value.slice(INPUT_SENTINEL.length) : value;
    const { deletes, insert } = textDiff(this.text, next);

    this.text = next;

    // The sentinel stands for one character before the textarea's text.
    return {
      backspaces: deletes + (kept ? 0 : 1),
      insert,
      kept: kept && Array.from(next).length <= MAX_TEXT,
    };
  }
}
