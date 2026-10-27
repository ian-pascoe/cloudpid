// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// A fake of the browser host's read of the Owner tabs a message attaches (`readOwnerTabPages`), shared by the tests of
// `BrowserPane.attach` and of the Session's wiring: it answers the pages `open` says are open, in the order asked, and
// fails as the host does (with `OWNER_TAB_GONE`) when one asked for is not.
import * as Effect from "effect/Effect";
import { OWNER_TAB_GONE } from "@cloudpid/protocol/live-view";
import { BrowserError, type BrowserHostService, type OwnerTabPageRead } from "./host.ts";

export const readingOwnerTabPages =
  (options: {
    /** The pages open now. */
    readonly open: () => ReadonlyArray<OwnerTabPageRead>;
    /** Told of each read, with the IDs it was asked for. */
    readonly reading?: (ids: ReadonlyArray<string>) => void;
    /** How long a read of `ids` takes, in milliseconds. */
    readonly delayMs?: (ids: ReadonlyArray<string>) => number;
  }): BrowserHostService["readOwnerTabPages"] =>
  (ids) =>
    Effect.sleep(options.delayMs?.(ids) ?? 0).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          options.reading?.(ids);

          const open = options.open();
          const read = ids.flatMap((id) => open.filter((page) => page.ownerTabId === id));

          return read.length === ids.length
            ? Effect.succeed(read)
            : Effect.fail(
                BrowserError.make({ message: `readOwnerTabPages: Error: ${OWNER_TAB_GONE}` }),
              );
        }),
      ),
    );
