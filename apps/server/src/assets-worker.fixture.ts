// The test Worker of the `workerd-assets` project: only the asset layer's binding, which the test reads, so it loads
// nothing of the Durable Objects `workerd.fixture.ts` exports (the real Registry's chain reaches Alchemy, which cannot load
// outside the `workerd` project's alias).
export default {
  fetch: () => new Response("cloudpid workerd assets test worker"),
};
