// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off globalDate:off globalTimers:off -- JSX lists are native arrays, and the words of an answer are no combinator, a time is said against now as the Skills page does, and focus returns after the dialog closes by a DOM timer.

// The pieces of the MCP servers section that show and act on the owner's MCP sign-ins (docs/architecture/mcp-sign-in.md →
// Settings, Sign-out): a row's state chip, last problem and hint, its Sign in, Sign in again and Sign out; the Sign out dialog;
// the Sign-ins list at Global. Never a token, a client secret or a URL beyond a host: the Registry's list has none.

import { GLOBAL_SCOPE, type McpSignInView, type McpSignOutView } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type FormEvent, useEffect, useState } from "react";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Dialog, DialogActions, DialogProblem } from "../components/ui/dialog.tsx";
import { relativeTime } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { settledFailureOf } from "../registry.ts";
import { settingsPath } from "../router.ts";
import { MessageList } from "./mcp-parts.tsx";
import {
  type McpSignInLine,
  type McpSignInsState,
  mcpSignInStartHref,
  type McpSignInTone,
} from "./mcp-sign-in-model.ts";
import { mcpSignInsStateAtom, mcpSignOutOpenAtom, signOutMcpAtom } from "./mcp-sign-in-state.ts";

const TONES: Readonly<Record<McpSignInTone, string>> = {
  ok: "border-input text-foreground",
  attention: "border-amber-600/50 text-amber-700 dark:text-amber-400",
  problem: "border-destructive/40 text-destructive",
  quiet: "border-input text-muted-foreground",
};

/** A server's sign-in state: "Signed in · host", "Needs sign-in", "More access requested", … */
export const SignInChip = ({ chip }: { chip: NonNullable<McpSignInLine["chip"]> }) => (
  <span
    // Never cut: a refresh's problem rides in the label, and the owner reads all of it (it wraps within the row).
    className={cn(
      "inline-flex min-h-5 max-w-full items-center rounded-sm border px-1.5 py-0.5 text-xs leading-tight break-words",
      TONES[chip.tone],
    )}
  >
    {chip.label}
  </span>
);

/** The last problem, the words a step-up adds, and the refused-document-client hint, under a row's target. */
export const SignInNotes = ({ id, line }: { id: string; line: McpSignInLine }) => (
  <>
    <MessageList
      tone="problem"
      id={id}
      small
      messages={line.problem === null ? [] : [`Sign-in: ${line.problem}`]}
    />
    <MessageList
      tone="hint"
      small
      messages={[...line.notes, ...(line.hint === null ? [] : [line.hint])]}
    />
  </>
);

/**
 * A row's Sign in, Sign in again and Sign out. Sign in is a link, not a call followed by `window.open`, so that a popup
 * blocker does not stop it (→ Starting and completing a sign-in, The link); it opens in a new tab and comes back by the
 * channel, so the row asks again.
 */
export const SignInControls = ({
  scope,
  name,
  line,
  returnTo,
}: {
  scope: string;
  name: string;
  line: McpSignInLine;
  /** The id of the row, which holds focus when its Sign out is gone. */
  returnTo: string;
}) => {
  const setSigningOut = useAtomSet(mcpSignOutOpenAtom(scope));
  const { actions } = line;

  return (
    <>
      {actions.signIn !== null && (
        <a
          href={mcpSignInStartHref({
            scope,
            global: GLOBAL_SCOPE,
            server: name,
            stepUp: actions.stepUp,
            returnPath: settingsPath(scope, "mcp"),
          })}
          target="_blank"
          rel="noopener"
          aria-label={`${actions.signIn} to ${name}${actions.stepUp ? " for more access" : ""} (opens in a new tab)`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {actions.signIn}
        </a>
      )}
      {actions.signOut !== null && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Sign out of ${name}`}
          onClick={() => {
            const hash = actions.signOut;

            if (hash !== null) setSigningOut({ hash, returnTo });
          }}
        >
          Sign out
        </Button>
      )}
    </>
  );
};

/** What a sign-out came to, in words: that it was done, and what the authorization server did. */
export const signOutWords = (answer: McpSignOutView): ReadonlyArray<string> => {
  if (Predicate.isTagged(answer, "SignedOut")) {
    const host = answer.issuerHost ?? "The authorization server";
    const { revocation } = answer;

    const revoked = ((): string => {
      switch (revocation.status) {
        case "revoked":
          return `${host} revoked the tokens.`;
        case "no_endpoint":
          return `${host} does not offer revocation, so the tokens stay valid there until they expire.`;
        case "not_attempted":
          return `${revocation.note ?? "Nothing was revoked"}.`;
        default:
          // `failed`, and a status a later build adds: the safe reading is that the grant may still stand.
          return `${revocation.note ?? `${host} did not revoke the tokens`}. The sign-out went through, but the grant may still stand there: revoke it in the server's own settings.`;
      }
    })();

    return [`Signed out of ${answer.server}.`, revoked];
  }

  if (Predicate.isTagged(answer, "NoSignIn")) return ["It was already signed out."];

  return [
    Predicate.hasProperty(answer, "message") && Predicate.isString(answer.message)
      ? answer.message
      : "Nothing was signed out.",
  ];
};

/** The sign-in `hash` in the list, if the list is known and holds it. */
const viewOf = (state: McpSignInsState, hash: string): McpSignInView | undefined =>
  state.status === "ready"
    ? Arr.findFirst(state.list.signIns, (held) => held.hash === hash).pipe(Option.getOrUndefined)
    : undefined;

/**
 * The body of the Sign out dialog: who it affects, what the server is asked, then what came of it. `view` is the sign-in as
 * the dialog opened on it, which the refreshed list no longer holds once it is signed out. The status region is always
 * there, empty until the answer, so that a screen reader announces the answer when it is put in.
 */
const SignOutDialogBody = ({
  scope,
  hash,
  view,
  onClose,
}: {
  scope: string;
  hash: string;
  view: McpSignInView | undefined;
  onClose: () => void;
}) => {
  const [result, signOut] = useAtom(signOutMcpAtom(scope));
  const answer = AsyncResult.isSuccess(result) ? result.value : null;
  const done = answer !== null;
  const busy = result.waiting;

  const name =
    view?.server ??
    (answer !== null && Predicate.isTagged(answer, "SignedOut") ? answer.server : "the server");

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!busy && !done) signOut(hash);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {!done && (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {view === undefined || view.environments.length === 0
              ? "No environment uses this sign-in now."
              : `Used by ${Arr.join(
                  Arr.map(view.environments, ({ name: environment }) => environment),
                  ", ",
                )}: their sessions close ${name}'s connection. Its tools stay listed.`}
          </p>
          <p className="text-muted-foreground">
            {view?.issuerHost == null ? "The authorization server" : view.issuerHost} is asked to
            revoke the tokens first, if it supports that. Its registration of cloudpid and your
            client binding stay, so you can sign in again.
          </p>
        </div>
      )}
      <div role="status" className="flex flex-col gap-1 text-sm">
        {answer !== null && Arr.map(signOutWords(answer), (line) => <p key={line}>{line}</p>)}
      </div>
      <DialogProblem problem={settledFailureOf(result)} />
      <DialogActions>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          {done ? "Close" : "Cancel"}
        </Button>
        {!done && (
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </Button>
        )}
      </DialogActions>
    </form>
  );
};

/**
 * The Sign out dialog, open while a sign-out is set at the Scope. It keeps the sign-in as it was when it opened (the list
 * asks again after the sign-out and no longer holds it), and gives focus back to the row or the list heading when it closes,
 * since the button that opened it may be gone.
 */
export const SignOutDialog = ({ scope }: { scope: string }) => {
  const [signingOut, setSigningOut] = useAtom(mcpSignOutOpenAtom(scope));
  const [result, signOut] = useAtom(signOutMcpAtom(scope));
  const state = useAtomValue(mcpSignInsStateAtom);
  const [held, setHeld] = useState<{ hash: string; view: McpSignInView } | null>(null);
  const hash = signingOut?.hash ?? null;
  const listed = hash === null ? undefined : viewOf(state, hash);

  if (hash === null && held !== null) setHeld(null);
  else if (hash !== null && listed !== undefined && held?.hash !== hash) {
    setHeld({ hash, view: listed });
  }

  const view = held?.hash === hash ? held.view : listed;

  const close = () => {
    const returnTo = signingOut?.returnTo;

    setSigningOut(null);
    // What an earlier sign-out said shows no more once the dialog is opened again.
    signOut(Atom.Reset);

    // The dialog gives focus back to what opened it; when that is gone, the page's body has it, and the row or heading does.
    setTimeout(() => {
      if (returnTo === undefined) return;

      const active = document.activeElement;

      if (active === null || active === document.body) document.getElementById(returnTo)?.focus();
    }, 0);
  };

  return (
    <Dialog
      open={hash !== null}
      onClose={close}
      dismissible={!result.waiting}
      title={`Sign out of ${view?.server ?? "this server"}?`}
    >
      {hash !== null && <SignOutDialogBody scope={scope} hash={hash} view={view} onClose={close} />}
    </Dialog>
  );
};

/** The time of a sign-in's last event, as a list says it. */
const when = (time: number | null, now: number): string =>
  time === null ? "never" : relativeTime(time, now);

/** The id of the Sign-ins heading, where focus goes when a sign-out from the list is done and its button is gone. */
const SIGN_INS_HEADING = "sign-ins-heading";

/** One sign-in of the Sign-ins list. */
const SignInItem = ({ scope, view, now }: { scope: string; view: McpSignInView; now: number }) => {
  const setSigningOut = useAtomSet(mcpSignOutOpenAtom(scope));
  const grant = view.kind === "client_grant";
  // A client grant that an entry uses signs in on its own: there is nothing to sign out of.
  const signOutOffered = !(grant && !view.unused);

  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Source", view.source === "owner" ? "Your own entry" : view.source.replace("repo:", "Repo ")],
    ["URL host", view.urlHost],
    ["Issuer", view.issuerHost ?? "not recorded"],
    ["Client", view.kind ?? "none yet"],
    ["Status", view.status.replace("_", " ")],
    ["Scopes", view.scope ?? "none"],
    ["Signed in", when(view.createdAt, now)],
    ["Refreshed", when(view.refreshedAt, now)],
    ["Used", when(view.usedAt, now)],
    ["Expires", view.expiresAt === null ? "no expiry given" : relativeTime(view.expiresAt, now)],
  ];

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium break-all">{view.server}</span>
        {view.unused && (
          <span className="inline-flex h-5 items-center rounded-sm border border-input px-1.5 text-xs leading-none text-muted-foreground">
            Unused
          </span>
        )}
        {signOutOffered && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="sm:ml-auto"
            aria-label={`Sign out of ${view.server} (${view.urlHost})`}
            onClick={() => {
              setSigningOut({ hash: view.hash, returnTo: SIGN_INS_HEADING });
            }}
          >
            Sign out
          </Button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {Arr.map(facts, ([term, detail]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="break-all">{detail}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Used by</dt>
        <dd>
          {view.environments.length === 0
            ? "no environment"
            : Arr.join(
                Arr.map(view.environments, ({ name }) => name),
                ", ",
              )}
        </dd>
      </dl>
      {view.lastError !== null && (
        <p className="text-xs text-destructive">Last problem: {view.lastError}</p>
      )}
    </li>
  );
};

/**
 * The Sign-ins at Global (`/settings/all/mcp#sign-ins`): every MCP sign-in the owner has made, with who uses it, which are
 * unused (an Environment deleted, or an entry removed or renamed), and Sign out. Nothing says "account": there is no
 * standard claim for it, so a row is the issuer's host, the scopes and the times.
 */
export const SignInsList = () => {
  const state = useAtomValue(mcpSignInsStateAtom);
  // The times are said against now, taken again whenever the list is (a time says "5 min ago" of the moment it was asked).
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setNow(Date.now());
  }, [state]);

  return (
    <div id="sign-ins" className="scroll-mt-6">
      <section aria-labelledby={SIGN_INS_HEADING} className="flex flex-col gap-4 border-t py-6">
        <div className="flex flex-col gap-1">
          <h2 id={SIGN_INS_HEADING} tabIndex={-1} className="text-sm font-semibold">
            Sign-ins
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            The MCP sign-ins you have made, kept Global: each environment that has the server uses
            it. One no entry uses any more stays here, unused, until you sign out.
          </p>
        </div>
        {state.status === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the sign-ins…
          </p>
        )}
        {state.status === "failed" && (
          <p role="alert" className="text-sm text-destructive">
            Can't open sign-ins: {state.problem}
          </p>
        )}
        {state.status === "ready" && state.list.sealing !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {state.list.sealing} Sign-ins stay unavailable until the encryption key is fixed.
          </p>
        )}
        {state.status === "ready" &&
          (state.list.signIns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No MCP sign-ins yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {Arr.map(state.list.signIns, (view) => (
                <SignInItem key={view.hash} scope={GLOBAL_SCOPE} view={view} now={now} />
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
};
