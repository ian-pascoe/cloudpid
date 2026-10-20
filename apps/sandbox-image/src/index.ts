// @effect-diagnostics nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Docker build context of the sandbox image: the directory with its Dockerfile. The stack builds the Workspace DO's
 * Container from it (`apps/server/src/workspace/resource.ts`).
 */
export const sandboxImageContext = join(dirname(fileURLToPath(import.meta.url)), "..", "image");
