// The draft composer's state: what is typed and chosen, the last Environment chosen on this device, sending the draft,
// and the first message waiting for its Session to take it.

import { DEFAULT_ENVIRONMENT, NEW_WORKSPACE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { type DraftInput, draftPlace, draftSendable } from "./draft.ts";
import { environmentListAtom } from "./environments-state.ts";
import { changing, RegistryClient } from "./registry.ts";
import { pathAtom, sessionPath } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { sessionClientAtom } from "./session/atoms.ts";

/** What is typed in the draft. The page has one. */
export const draftTextAtom = Atom.make("");

/** The Workspace picked in the draft: `NEW_WORKSPACE`, or the id of one of the chosen Environment. */
export const draftWorkspaceAtom = Atom.make<string>(NEW_WORKSPACE);

/** What is typed as a new Workspace's base branch; empty for the default branch. */
export const draftBaseAtom = Atom.make("");

/** What is typed as a new Workspace's branch name; empty for `cloudpid/<id>`. */
export const draftBranchAtom = Atom.make("");

/** The Environment last chosen on this device (in the runtime's key-value store). */
const lastEnvironmentAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:draft-environment",
  schema: Schema.String,
  defaultValue: (): string => DEFAULT_ENVIRONMENT,
}).pipe(Atom.keepAlive);

/**
 * The Environment the draft is made in: the one last chosen on this device, or the default one when that is gone (or
 * before the list has answered). Writing it chooses an Environment, keeps that on this device, and goes back to a new
 * Workspace, since the Workspaces are the old Environment's.
 */
export const draftEnvironmentAtom = Atom.writable(
  (get): string => {
    const id = get(lastEnvironmentAtom);
    const environments = get(environmentListAtom);

    return environments !== null && !Arr.some(environments, (known) => known.id === id)
      ? DEFAULT_ENVIRONMENT
      : id;
  },
  (ctx, id: string) => {
    ctx.set(lastEnvironmentAtom, id);
    ctx.set(draftWorkspaceAtom, NEW_WORKSPACE);
  },
);

/**
 * The first messages waiting for their Session to take them, by Session id. The draft puts one here once the Session is
 * registered; `drainFirstMessageAtom` sends it, and takes it out once the Session answered.
 */
export const pendingFirstMessagesAtom = Atom.make<Readonly<Record<string, string>>>({}).pipe(
  Atom.keepAlive,
);

/**
 * Register the Session the draft describes and open it. Once it is registered the first message is put in
 * `pendingFirstMessagesAtom`, the draft empties, and the page moves to the Session. A refusal fails with the Registry's
 * message and leaves the draft as it was.
 */
export const sendDraftAtom = appRuntime.fn((input: DraftInput, get) =>
  Effect.gen(function* () {
    if (!draftSendable(input)) return yield* Effect.die("The draft cannot be sent");

    const created = yield* RegistryClient.use((registry) =>
      registry("createSession", draftPlace(input)),
    );

    get.set(pendingFirstMessagesAtom, {
      ...get(pendingFirstMessagesAtom),
      [created.id]: input.text.trim(),
    });
    get.set(draftTextAtom, "");
    get.set(draftBaseAtom, "");
    get.set(draftBranchAtom, "");
    get.set(draftWorkspaceAtom, NEW_WORKSPACE);
    get.set(pathAtom, sessionPath(created.id));

    return created;
  }).pipe(changing(["sessions", "workspaces"])),
);

/** The request ID Session `sessionId`'s first message is submitted under, the same on every client, so it is taken once. */
const firstMessageRequestId = (sessionId: string): string => `first-message:${sessionId}`;

/** A first message the Session refused, with why: its composer takes it back. */
export interface RefusedFirstMessage {
  readonly text: string;
  readonly reason: string;
}

/**
 * The first messages their Session refused, by Session id: the Session's composer puts the text back with the reason
 * and takes it out of here.
 */
export const refusedFirstMessagesAtom = Atom.make<Readonly<Record<string, RefusedFirstMessage>>>(
  {},
).pipe(Atom.keepAlive);

/**
 * Sends Session `sessionId`'s waiting first message, if there is one, once its client is built: as a follow-up, as a
 * message typed in its composer would be (`submitAtom`). It stays in `pendingFirstMessagesAtom` until the Session
 * answers, so a page left before then sends it again when the Session is opened again, under the same request ID, which
 * the Session takes once. Refused, it moves to `refusedFirstMessagesAtom` for the composer. The client holds the submit
 * until the Session greets. Mounted by the Session's chat.
 */
export const drainFirstMessageAtom = Atom.family((sessionId: string) =>
  appRuntime.atom((get) =>
    get.result(sessionClientAtom(sessionId)).pipe(
      Effect.flatMap((client) => {
        const text = get.once(pendingFirstMessagesAtom)[sessionId];

        if (text === undefined) return Effect.void;

        const answered = (reason: string | null) =>
          Effect.sync(() => {
            const { [sessionId]: _sent, ...others } = get.once(pendingFirstMessagesAtom);

            get.set(pendingFirstMessagesAtom, others);

            if (reason !== null) {
              get.set(refusedFirstMessagesAtom, {
                ...get.once(refusedFirstMessagesAtom),
                [sessionId]: { text, reason },
              });
            }
          });

        return client
          .submitAndAwait(text, "followUp", undefined, firstMessageRequestId(sessionId))
          .pipe(
            Effect.matchEffect({
              onSuccess: () => answered(null),
              onFailure: (error) => answered(error.message),
            }),
          );
      }),
    ),
  ),
);
