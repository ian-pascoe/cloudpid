/**
 * The Server Worker's Cloudflare Images binding (`worker.ts`), which the Session DOs' `read` prepares images with, so an
 * image the agent reads fits one conversation entry (`@cloudpid/extensions/images`; `docs/architecture/workspace.md` → Filesystem and
 * tools).
 */
export const IMAGES_BINDING = "IMAGES";
