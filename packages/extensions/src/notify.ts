// Telling the owner (`docs/spec.md` → Client and protocol → Notifications): what a Session can push to the owner's
// devices, and the service an extension yields to do it. The Session DO provides the service; extensions that need the
// owner (the secrets request, a Browser Handoff) depend only on this module.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Anything the owner should hear, in the Session's name: the caller words it. `url` is where tapping it goes: a path of
 * the app, a query of the Session's page (`?pane=live-view:7`, a Browser Handoff's Live View Pane), or an absolute
 * `https:` URL. A URL longer than `MAX_NOTICE_URL_LENGTH` or with characters a URL does not have is ignored, and the
 * Session's page opens instead.
 */
export type PushNotice = {
  readonly kind: "notice";
  readonly title?: string | undefined;
  readonly body: string;
  readonly url?: string | undefined;
};

/** Something a Session tells the owner about. */
export type PushEvent =
  | PushNotice
  /** A Run ended with an answer. */
  | { readonly kind: "finished" }
  /** A Run ended without one: a model error, a restart limit. `reason` is the error's text, when there is one. */
  | { readonly kind: "failed"; readonly reason?: string | undefined }
  /**
   * The agent waits for the owner: to enter the Secrets `names`, or, with `approval`, to approve the change it names
   * (`docs/spec.md` → Approval).
   */
  | {
      readonly kind: "input";
      readonly names: ReadonlyArray<string>;
      readonly reason?: string | undefined;
      readonly approval?: string | undefined;
    };

/** The longest `PushNotice.url` that is sent: with the rest of a push it must fit one 4096-octet message. */
export const MAX_NOTICE_URL_LENGTH = 1024;

/** The Session's way to push to the owner. It never fails and never waits long: a notification is not worth a Run. */
export class OwnerNotifications extends Context.Service<
  OwnerNotifications,
  { readonly notify: (event: PushEvent) => Effect.Effect<void> }
>()("@cloudpid/extensions/notify/OwnerNotifications") {}
