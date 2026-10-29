// Images in the conversation (`docs/architecture/workspace.md` → Filesystem and tools). An image a tool returns is part
// of a tool result, which is one conversation entry: one row of the Session DO's SQLite, which workerd caps at 8 MiB
// (workerd#7493). So every image `read` returns is held to `MAX_IMAGE_CHARACTERS` of base64, whatever the model would
// take: one over it is scaled down and re-encoded by the Cloudflare Images binding (`./images/prepare.ts`, not in the
// Session DO's own isolate), or left out with the reason (`./images/read.ts`).
import * as Context from "effect/Context";
import type { ImagesService } from "./images/prepare.ts";

export {
  cloudflareImages,
  type CloudflareImagesOptions,
  type ImagePreparation,
  type ImagesService,
  MAX_IMAGE_ATTEMPTS,
  MAX_IMAGE_CHARACTERS,
  MAX_IMAGE_FILE_BYTES,
  prepareImage,
} from "./images/prepare.ts";

export { readTool } from "./images/read.ts";

export { boundImages, MAX_RESULT_IMAGE_CHARACTERS, ResultImages } from "./images/results.ts";

/** The Session's Images binding, which `read` prepares images with. */
export class Images extends Context.Service<Images, ImagesService>()(
  "@cloudpid/extensions/images",
) {}
