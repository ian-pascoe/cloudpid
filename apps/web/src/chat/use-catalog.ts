// The composer's catalog (`catalog`): the Session's Slash commands and the Prompt templates and Skills of the
// conversation's directory. Asked for when the menu first opens, and again once it is older than `CATALOG_TTL_MS`, so a
// template or Skill added meanwhile shows up without a reload.

// @effect-diagnostics globalDate:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: Date is the platform here.

import type { Catalog } from "@cloudpid/protocol";
import { useCallback, useRef, useState } from "react";
import type { SessionConnection } from "../session/connection.ts";

/** How long a catalog is fresh. */
export const CATALOG_TTL_MS = 30_000;

/** How long to wait before asking again after the Session could not answer. */
const RETRY_MS = 5_000;

/** A conversation's catalog as the composer has it, and how to ask for a fresh one. */
export type CatalogState = { readonly catalog: Catalog | null; readonly refresh: () => void };

/**
 * The catalog of the root conversation, or of subagent conversation `conversationId`: null until the Session first
 * answered, and `refresh`, which asks the Session unless the catalog is fresh or a request is out.
 */
export const useCatalog = (
  connection: Pick<SessionConnection, "catalog">,
  conversationId: number | undefined,
): CatalogState => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const asking = useRef(false);
  // When the catalog may be asked for again.
  const nextAt = useRef(0);

  const refresh = useCallback(() => {
    if (asking.current || Date.now() < nextAt.current) return;

    asking.current = true;
    connection.catalog(conversationId).then(
      (answer) => {
        asking.current = false;
        nextAt.current = Date.now() + CATALOG_TTL_MS;
        setCatalog(answer);
      },
      () => {
        // The menu keeps what it had, and the composer's own commands; the next opening asks again.
        asking.current = false;
        nextAt.current = Date.now() + RETRY_MS;
      },
    );
  }, [connection, conversationId]);

  return { catalog, refresh };
};
