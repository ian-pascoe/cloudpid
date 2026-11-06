// docs/architecture/visuals.md → The frame; docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are
// live, Where it renders), App Panes. Which place of a page mounts an App View (and, keyed `visual:`, a Visual). A call can
// be shown in several places at once (its card in the transcript, the same card in a Subagent Pane or page, an App Pane
// opened for it), and only one of them mounts its View: the places each hold a **claim** on the call, and the highest place
// hosts it (App Pane, then Subagent Pane or page, then card); the others say where it is shown. A View moves from one place to another by the first one's frame closing (its View is told
// to tear down and answers, or 2 s pass) and only then the next one's mounting, never by moving an iframe, which would
// reload it.
//
// A claim names its call by a **key** the owner builds with {@link placeKey} (`app:<callId>`, and `visual:<callId>` for a
// Visual), so that the two kinds of call never share one; this module treats it as opaque (`callKey`).
//
// This module knows nothing of React or the DOM: it is the state machine, tested without either (`places.test.ts`).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a small mutable store over native maps.

/** What a claim names its call by: the kind of frame in the call's name space, so an App View's and a Visual's never collide. */
export const placeKey = (kind: "app" | "visual", callId: string): string => `${kind}:${callId}`;

/** Where an App View can be shown on a page. */
export type AppPlace = "app-pane" | "subagent-pane" | "subagent-page" | "card";

/** Which place mounts a View when several claim its call: the highest, then the one that has it, then the first to claim. */
const RANKS: Readonly<Record<AppPlace, number>> = {
  "app-pane": 3,
  "subagent-pane": 2,
  "subagent-page": 2,
  card: 1,
};

/** How a place that does not mount a View says where it is: "Shown in …". */
export const PLACE_NAMES: Readonly<Record<AppPlace, string>> = {
  "app-pane": "the App Pane",
  "subagent-pane": "the Subagent Pane",
  "subagent-page": "the Subagent page",
  card: "the transcript",
};

interface Claim {
  readonly id: string;
  readonly callKey: string;
  readonly place: AppPlace;
  /** The place wants the View mounted (not collapsed, not unavailable). */
  readonly live: boolean;
  /** The order claims were made in, which breaks a tie. */
  readonly seq: number;
}

/** The place that has a call's View mounted: its frame is there, or closing. */
interface Host {
  readonly callKey: string;
  readonly place: AppPlace;
  readonly claimId: string;
  /** Names this hosting among all that ever were: a new one for a call is a new mount. */
  readonly key: number;
  /** Its View is being told to tear down: the frame stays until `closed`. */
  readonly closing: boolean;
}

/** What a place may do about its call's View. */
export type PlaceView =
  /** Its frame is mounted here (or is closing here and still there to be torn down). */
  | { readonly kind: "hosting"; readonly closing: boolean; readonly key: number }
  /** It is next: another place's frame is closing first. */
  | { readonly kind: "waiting" }
  /** Another place has the View. */
  | { readonly kind: "elsewhere"; readonly place: AppPlace }
  /** No place has a View of this call. */
  | { readonly kind: "none" };

export class AppPlaces {
  private readonly claims = new Map<string, Claim>();
  private readonly hosts = new Map<string, Host>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private count = 0;

  /** Hold a claim on a call (`callKey`: its {@link placeKey}) for a place; it wants no View until `update` says so. */
  readonly claim = (id: string, callKey: string, place: AppPlace): void => {
    const known = this.claims.get(id);

    if (known?.callKey === callKey && known.place === place) return;

    if (known !== undefined) this.drop(known);

    this.seq += 1;
    this.claims.set(id, { id, callKey, place, live: false, seq: this.seq });
    this.reconcile(callKey);
  };

  /**
   * Give up a claim: the place is unmounted, and its frame went with it (what ended it must have asked its View to tear
   * down first: `teardown.ts`). Another place that wants the View is next.
   */
  readonly release = (id: string): void => {
    const known = this.claims.get(id);

    if (known !== undefined) this.drop(known);
  };

  /** Whether a place wants its call's View mounted. */
  readonly update = (id: string, live: boolean): void => {
    const known = this.claims.get(id);

    if (known === undefined || known.live === live) return;

    this.claims.set(id, { ...known, live });
    this.reconcile(known.callKey);
  };

  /** A host's frame has had its View answer the teardown (or 2 s passed): it may be removed, and the next place's mounted. */
  readonly closed = (id: string): void => {
    const known = this.claims.get(id);
    const host = known === undefined ? undefined : this.hosts.get(known.callKey);

    if (known === undefined || host?.claimId !== id) return;

    this.hosts.delete(known.callKey);
    this.reconcile(known.callKey);
  };

  /** What the place with claim `id` does about its call's View. */
  readonly viewOf = (id: string): PlaceView => {
    const mine = this.claims.get(id);

    if (mine === undefined) return { kind: "none" };

    const host = this.hosts.get(mine.callKey);

    if (host?.claimId === id) return { kind: "hosting", closing: host.closing, key: host.key };

    const winner = this.winnerOf(mine.callKey);

    if (winner?.id === id) return { kind: "waiting" };

    const there = winner?.place ?? host?.place;

    return there === undefined ? { kind: "none" } : { kind: "elsewhere", place: there };
  };

  /** A string that says what `viewOf` does, for a snapshot that compares by value. */
  readonly viewKey = (id: string): string => {
    const view = this.viewOf(id);

    switch (view.kind) {
      case "hosting":
        return `hosting:${view.key}:${view.closing}`;
      case "elsewhere":
        return `elsewhere:${view.place}`;
      default:
        return view.kind;
    }
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private drop(claim: Claim): void {
    this.claims.delete(claim.id);

    const host = this.hosts.get(claim.callKey);

    if (host?.claimId === claim.id) this.hosts.delete(claim.callKey);

    this.reconcile(claim.callKey);
  }

  private winnerOf(callKey: string): Claim | undefined {
    const hosted = this.hosts.get(callKey)?.claimId;
    let best: Claim | undefined;

    for (const claim of this.claims.values()) {
      if (claim.callKey !== callKey || !claim.live) continue;

      if (best === undefined || this.beats(claim, best, hosted)) best = claim;
    }

    return best;
  }

  private beats(claim: Claim, best: Claim, hosted: string | undefined): boolean {
    const rank = RANKS[claim.place] - RANKS[best.place];

    if (rank !== 0) return rank > 0;

    if ((claim.id === hosted) !== (best.id === hosted)) return claim.id === hosted;

    return claim.seq < best.seq;
  }

  private reconcile(callKey: string): void {
    const winner = this.winnerOf(callKey);
    const host = this.hosts.get(callKey);

    if (host === undefined) {
      if (winner !== undefined) {
        this.count += 1;
        this.hosts.set(callKey, {
          callKey,
          place: winner.place,
          claimId: winner.id,
          key: this.count,
          closing: false,
        });
      }
    } else if (!host.closing && (winner?.id !== host.claimId || winner.place !== host.place)) {
      // The place no longer wants it, or a higher one does: its View is told to tear down, and the frame stays until it has.
      this.hosts.set(callKey, { ...host, closing: true });
    }

    for (const listener of this.listeners) listener();
  }
}

/** The places of this page: one for the app (a test makes its own). */
export const appPlaces = new AppPlaces();
