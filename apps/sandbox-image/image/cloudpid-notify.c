/*
 * cloudpid-notify (docs/architecture/container.md → File-change signals): the
 * Container's side of the file-change signal, which tells its file watchers
 * (Vite, tsc --watch, Vitest) of changes the Workspace DO synced into
 * /workspace: those reach computerd's store without going through the kernel
 * and so raise no inotify event. It reads absolute paths on stdin, each ended
 * by a NUL byte (a newline is a valid byte of a file name), and sets the
 * extended attribute user.cloudpid.notify on each through the mount: computerd
 * answers setxattr there as a no-op, but the kernel raises IN_ATTRIB for it all
 * the same.
 *
 * A path that is gone (ENOENT, ENOTDIR) is signalled at its nearest existing
 * ancestor instead, never above the root (CLOUDPID_NOTIFY_ROOT, /workspace by
 * default), and nothing is said of it. A path outside the root, or with an
 * empty, "." or ".." segment (which could lead out of it), is skipped with a
 * note on stderr. Any other failure is reported on stderr and the rest go on.
 * The exit status is 0, or 2 when the input held a path that is not absolute
 * or is longer than PATH_MAX (the others are still signalled).
 *
 * C rather than a script around setfattr: the image has build-essential
 * already, and this needs no package (attr) or interpreter of its own. It keeps
 * in step with apps/sandbox-image/src/notify.ts (notify.test.ts).
 */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/xattr.h>

#define NOTIFY_ATTRIBUTE "user.cloudpid.notify"
#define DEFAULT_ROOT "/workspace"

static char root[PATH_MAX];
static size_t root_length;

/* Whether `path` (absolute) has no empty, "." or ".." segment. */
static int clean(const char *path) {
  const char *segment = path + 1;

  for (;;) {
    const char *end = strchr(segment, '/');
    size_t length = end == NULL ? strlen(segment) : (size_t)(end - segment);

    if (length == 0 || (length == 1 && segment[0] == '.') ||
        (length == 2 && segment[0] == '.' && segment[1] == '.'))
      return 0;

    if (end == NULL)
      return 1;

    segment = end + 1;
  }
}

/* Whether `path` is the root or below it. */
static int under_root(const char *path) {
  return strncmp(path, root, root_length) == 0 &&
         (path[root_length] == '\0' || path[root_length] == '/');
}

/* Set the attribute on `path` (of `length` bytes, changed in place), or on its
 * nearest existing ancestor. */
static void signal_path(char *path, size_t length) {
  if (!clean(path)) {
    fprintf(stderr,
            "cloudpid-notify: %s: an empty, \".\" or \"..\" segment, skipped\n",
            path);
    return;
  }

  if (!under_root(path)) {
    fprintf(stderr, "cloudpid-notify: %s: outside %s, skipped\n", path, root);
    return;
  }

  for (;;) {
    if (setxattr(path, NOTIFY_ATTRIBUTE, "1", 1, 0) == 0)
      return;

    if (errno != ENOENT && errno != ENOTDIR) {
      fprintf(stderr, "cloudpid-notify: %s: %s\n", path, strerror(errno));
      return;
    }

    /* The root itself is gone: nothing above it is ours to signal. */
    if (length <= root_length)
      return;

    while (length > root_length && path[length - 1] != '/')
      length--;
    if (length > root_length)
      length--;
    path[length] = '\0';
  }
}

int main(void) {
  const char *configured = getenv("CLOUDPID_NOTIFY_ROOT");
  const char *chosen = configured != NULL && configured[0] == '/' &&
                               configured[1] != '\0' && clean(configured)
                           ? configured
                           : DEFAULT_ROOT;

  root_length = strlen(chosen);
  if (root_length >= sizeof root) {
    fprintf(stderr, "cloudpid-notify: root too long\n");
    return 2;
  }
  memcpy(root, chosen, root_length + 1);

  static char path[PATH_MAX];
  size_t length = 0;
  int overlong = 0;
  int malformed = 0;
  int c;

  for (;;) {
    c = getchar();

    if (c == EOF || c == '\0') {
      if (overlong) {
        fprintf(stderr, "cloudpid-notify: a path longer than %d bytes\n",
                PATH_MAX - 1);
        malformed = 1;
      } else if (length > 0) {
        path[length] = '\0';

        if (path[0] == '/')
          signal_path(path, length);
        else {
          fprintf(stderr, "cloudpid-notify: %s: not an absolute path\n", path);
          malformed = 1;
        }
      }

      length = 0;
      overlong = 0;

      if (c == EOF)
        break;
      continue;
    }

    if (length + 1 >= sizeof path)
      overlong = 1;
    else
      path[length++] = (char)c;
  }

  if (ferror(stdin)) {
    fprintf(stderr, "cloudpid-notify: reading stdin: %s\n", strerror(errno));
    return 2;
  }

  return malformed ? 2 : 0;
}
