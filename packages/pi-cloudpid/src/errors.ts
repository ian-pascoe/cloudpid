// @effect-diagnostics extendsNativeError:off -- errors the command tells apart with instanceof.
import type { JsonObject } from "./json.ts";

/** A refusal the owner reads as it is: what is wrong and what to do (never a stack trace). */
export class Refusal extends Error {
  override readonly name: string = "Refusal";
}

/** The endpoint's domain failure (`isError` result): its `code`, one sentence, whether a retry may heal it. */
export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  readonly code: string;
  readonly retryable: boolean;
  readonly details: JsonObject | undefined;

  constructor(code: string, message: string, retryable: boolean, details?: JsonObject) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * The endpoint wants a sign-in this machine does not have (none stored, or the stored one is rejected or expired and
 * could not be refreshed). A {@link Refusal}, so the owner reads it as it is; `/cloudpid import` asks to sign in on it.
 */
export class SignInRequired extends Refusal {
  override readonly name: string = "SignInRequired";
}

export const SIGN_IN_REJECTED = "sign-in rejected or expired: run `/cloudpid login`.";

export const NOT_SIGNED_IN = "not signed in to cloudpid: run `/cloudpid login`.";
