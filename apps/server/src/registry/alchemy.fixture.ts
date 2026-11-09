// The parts of `@alchemy.run/cloudflare` that `Registry.ts` reads when it loads, for the workerd test project, which aliases
// the package to this file (`vitest.config.ts`): the package cannot load in workerd (it resolves modules with
// `import.meta.resolve`), and a test that runs `registryMethods` (`registry.fixture.ts`) needs only the object's
// declaration and the two services the Registry asks its host for.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the Worker's bindings, whatever they are: a test passes none. */
import * as Context from "effect/Context";

/** The Durable Object's state, as the Registry reads it: `raw` is the runtime's own. */
export class DurableObjectState extends Context.Service<
  DurableObjectState,
  { readonly raw: { readonly storage: unknown } }
>()("@cloudpid/server/registry/alchemy.fixture/DurableObjectState") {}

/** The Worker's bindings. */
export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Readonly<Record<string, unknown>>
>()("@cloudpid/server/registry/alchemy.fixture/WorkerEnvironment") {}

/** An object's declaration, whose `make` hands back what it is given: a test runs the methods itself. */
export const DurableObject = () => (_name: string) =>
  class {
    static make = <A>(methods: A): A => methods;
  };
