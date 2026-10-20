import { expect, it } from "vitest";

it("loads alchemy/Cloudflare against the pinned effect version", () =>
  import("alchemy/Cloudflare").then((Cloudflare) => {
    expect(Cloudflare.providers).toBeTypeOf("function");
    expect(Cloudflare.state).toBeTypeOf("function");
  }));
