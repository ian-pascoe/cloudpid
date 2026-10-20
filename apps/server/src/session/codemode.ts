// Code mode (`docs/spec.md` → Agent capabilities, ADR-0005): pi-durable's `codemode` tool, whose scripts call the Session's
// tools as nested calls. The QuickJS VM runs in a Durable Object of the separately deployed codemode sandbox Worker, one
// object per Session; the tools and the journal that makes a script survive an eviction stay in the Session's Harness.
// @effect-diagnostics missingPipeableSignature:off
import {
  type CodemodeRemote,
  type CodemodeSandboxBase,
  RemoteCodemodeSandbox,
} from "@earendil-works/pi-codemode/portable";
import type { Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The sandbox Durable Object namespace, as a Session DO binds it from the sandbox Worker (`script_name`). */
export type CodemodeSandboxNamespace = {
  getByName(name: string): CodemodeRemote;
};

/** What runs a Session's scripts. */
export class CodemodeSandbox extends Context.Service<CodemodeSandbox, CodemodeSandboxBase>()(
  "@cloudpid/server/session/codemode/CodemodeSandbox",
) {}

/**
 * A sandbox that runs each script in the namespace's object named `name`: one per Session, so a Session's scripts take
 * turns on one object, in the sandbox Worker's isolates rather than the Session DO's. Objects of different Sessions may
 * share an isolate, and so its thread and memory.
 */
export const remoteSandbox = (
  namespace: CodemodeSandboxNamespace,
  name: string,
): CodemodeSandboxBase => new RemoteCodemodeSandbox({ remote: () => namespace.getByName(name) });

/**
 * The `codemode` tool and its prompt section, over the Session's sandbox. Scripts get no `models.*`: the model proxy
 * serves only chat models, so the classifier and image generation they offer could not succeed.
 */
export const Codemode: Effect.Effect<Extension, never, CodemodeSandbox> = Effect.map(
  CodemodeSandbox,
  (sandbox) => createCodemodeExtension({ sandbox, models: false }),
);
