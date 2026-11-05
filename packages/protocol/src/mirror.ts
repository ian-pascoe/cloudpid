// Adapted from Cloudflare's `agents` repository, `examples/next/harnesses/pi/src/mirror.ts` as of commit 9e88bbf
// https://github.com/cloudflare/agents/blob/9e88bbf502fc3590790e575b4ab1b5ccb33c9495/examples/next/harnesses/pi/src/mirror.ts
//
// MIT License
//
// Copyright (c) 2025 Cloudflare, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Changes: `PiSessionMirror` → `ConversationMirror`, one per watched conversation rather than per socket; it holds no
// socket and calls no `onChange`: the client gives it the frames and a loader of `entries` pages, reads `view()` after
// each, and fills the gaps itself a page at a time (`fillGap`) instead of showing them; operations that do not apply
// say so (`receive` returns false), for the client to watch again; the projection takes the streamed tools. Imports end
// in `.ts`. Formatted for this repository.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- a plain class over pi's Promise-based transcript, as the example's is.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type EntryId,
  type EntryQuery,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import type { EntriesPage } from "./session.ts";
import { EMPTY_VIEW, projectView, type SessionView, type StreamedTools } from "./view.ts";

/** Entries one "show earlier messages", or one page of a gap, asks the Session for. */
export const ENTRIES_PAGE_SIZE = 50;

/** Ask the Session for a page of the conversation's entries (`entries`). */
export type EntriesLoader = (
  query: Omit<EntryQuery, "conversationId">,
  limit: number,
) => Promise<EntriesPage>;

/** One frame of a conversation's watch: its whole view, or the operations that change the last one. */
export type WatchFrame =
  | { readonly type: "view"; readonly view: ConversationView }
  | { readonly type: "ops"; readonly ops: readonly Op[] };

/**
 * The client's copy of one conversation: pi's conversation view, kept current from the Session's `view` and `ops`
 * frames, merged into a `ConversationTranscript` that keeps every entry the client has seen beyond the view's window.
 * Earlier entries, and entries a reconnect skipped (a gap), load on demand through `load`. Pure state, so the client
 * and the tests run the same code.
 */
export class ConversationMirror {
  readonly #transcript: ConversationTranscript;
  /** pi's view as the Session last sent it; the operations apply to it. */
  #view: ConversationView | null = null;
  #merged: TranscriptView | null = null;
  #projected: {
    readonly merged: TranscriptView;
    readonly streamed: StreamedTools;
    readonly view: SessionView;
  } | null = null;

  constructor(load: EntriesLoader) {
    this.#transcript = new ConversationTranscript((query, limit) => load(query, limit), {
      pageSize: ENTRIES_PAGE_SIZE,
    });
  }

  /** Whether a `view` came: until then the conversation is not shown. */
  get started(): boolean {
    return this.#merged !== null;
  }

  /**
   * Where a new watch starts so that it continues the transcript (`Watch.from`): right after its newest entry, so a
   * reconnect gets only what it missed. Undefined before the first view and for an empty transcript.
   */
  get from(): EntryId | undefined {
    return this.#transcript.resume?.from;
  }

  /** Whether the transcript misses entries between two it has, which `fillGap` loads. */
  get gapped(): boolean {
    return this.#merged?.items.some((item) => item.kind === "gap") ?? false;
  }

  /**
   * Take one frame of the watch. Operations with no view to apply to (one never came, or the last operations did not
   * apply) are dropped. False when operations did not apply to the view held: it is dropped too, and the client watches
   * again for a new one.
   */
  receive(frame: WatchFrame): boolean {
    if (frame.type === "view") {
      this.#view = frame.view;
    } else {
      if (this.#view === null) return true;

      try {
        this.#view = applyImmutable(this.#view, frame.ops);
      } catch {
        this.#view = null;

        return false;
      }
    }

    this.#merged = this.#transcript.merge(this.#view);

    return true;
  }

  /** What the conversation shows: `projectView` of the transcript, the same object while nothing changed. */
  view(streamed?: StreamedTools): SessionView {
    const merged = this.#merged;

    if (merged === null) return EMPTY_VIEW;

    const projected = this.#projected;

    if (projected !== null && projected.merged === merged && projected.streamed === streamed) {
      return projected.view;
    }

    const view = projectView(merged, streamed);

    this.#projected = { merged, streamed, view };

    return view;
  }

  /** Load the page before the oldest entry held, when the transcript goes back further. Rejects when the load fails. */
  async loadEarlier(): Promise<void> {
    if (this.#merged?.items[0]?.kind !== "earlier") return;

    this.#merged = await this.#transcript.loadEarlier(BACKGROUND_CONTEXT);
  }

  /** Load the next page of the first gap, if there is one. Rejects when the load fails. */
  async fillGap(): Promise<void> {
    const gap = this.#merged?.items.find((item) => item.kind === "gap");

    if (gap?.kind !== "gap") return;

    this.#merged = await this.#transcript.fillGap(gap, BACKGROUND_CONTEXT);
  }
}
