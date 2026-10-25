// @effect-diagnostics missingPipeableSignature:off
// What the owner can do with the Secrets they enter in a masked form (`docs/spec.md` → Secrets): hold them for the
// Session, or keep them for its Environment or for every Environment. The agent's `keep` only pre-selects one; the
// form always offers all three and the owner's choice is final.
import { SecretKeep, type SecretRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The name of the form's radio group. */
export const KEEP_FIELD = "keep";

/** The choices in the order the form shows them, each with how it reads. */
export const KEEP_CHOICES = [
  { value: "session", label: "This Session only" },
  { value: "environment", label: "Keep for this Environment" },
  { value: "all", label: "Keep for every Environment" },
] as const satisfies ReadonlyArray<{ readonly value: SecretKeep; readonly label: string }>;

/** The choice the form starts on: the agent's suggestion, else the Session only. */
export const defaultKeep = (request: Pick<SecretRequest, "keep">): SecretKeep =>
  request.keep ?? "session";

/** What the form's radio group says, the Session only when it says nothing a choice would. */
export const chosenKeep = (value: FormDataEntryValue | null): SecretKeep =>
  Schema.decodeUnknownOption(SecretKeep)(value).pipe(Option.getOrElse((): SecretKeep => "session"));

/** What the choices say to the owner about the Secrets, under the form. */
export const keepNote = (keep: SecretKeep, lifetimeMinutes: number): string => {
  switch (keep) {
    case "session":
      return `Held encrypted for ${lifetimeMinutes} minutes, then forgotten.`;
    case "environment":
      return "Saved encrypted for this Environment, as on the Environments page: it does not expire, and a Build can use it where marked.";
    case "all":
      return "Saved encrypted for every Environment, as on the Environments page: it does not expire, and an Environment's own Secret of the name wins.";
  }
};

/** Every choice's value, for tests. */
export const KEEP_VALUES: ReadonlyArray<SecretKeep> = Arr.map(KEEP_CHOICES, ({ value }) => value);
