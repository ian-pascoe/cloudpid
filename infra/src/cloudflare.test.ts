import { expect, it } from "vitest";

// The first import of @alchemy.run/cloudflare is large; on a busy CI runner (other packages' tests run alongside) it takes
// more than Vitest's default 5 s.
it("loads @alchemy.run/cloudflare against the pinned effect version", { timeout: 30_000 }, () =>
  import("@alchemy.run/cloudflare").then((Cloudflare) => {
    expect(Cloudflare.providers).toBeTypeOf("function");
    expect(Cloudflare.state).toBeTypeOf("function");
  }),
);
