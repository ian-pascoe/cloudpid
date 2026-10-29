// The Container's side of the file-change signal (docs/architecture/container.md → File-change signals), `cloudpid-notify`,
// with the Workspace DO, which imports it: no Node built-ins here, since it runs in a Worker. `image/cloudpid-notify.c` repeats
// these values; `notify.test.ts` fails when they differ.

/** Where the image has the helper: it reads NUL-ended paths on stdin and sets `NOTIFY_ATTRIBUTE` on each. */
export const NOTIFY_PROGRAM = "/usr/local/bin/cloudpid-notify";

/**
 * The extended attribute the helper sets through the Workspace's mount. computerd answers `setxattr` there as a no-op
 * that changes nothing it stores, but the kernel still raises `IN_ATTRIB` for it, which file watchers act on.
 */
export const NOTIFY_ATTRIBUTE = "user.cloudpid.notify";

/** The variable that moves the helper's root (`/workspace` without it): what it never climbs above. For its tests. */
export const NOTIFY_ROOT_VARIABLE = "CLOUDPID_NOTIFY_ROOT";
