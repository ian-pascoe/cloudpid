// POSIX paths of a Workspace's file tree, which is always absolute and `/`-separated.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off

/** `path` without `.` and `..` segments, repeated or trailing `/`. `..` above the root stays at the root. */
export const normalize = (path: string): string => {
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/** `path` resolved against the absolute directory `cwd`; a `file://` URL names its path. */
export const resolve = (cwd: string, path: string): string => {
  const plain = path.startsWith("file://") ? decodeFileUrl(path) : path;

  return normalize(plain.startsWith("/") ? plain : `${cwd}/${plain}`);
};

/** The parts joined with `/` and normalized, relative unless the first part is absolute. */
export const join = (parts: readonly string[]): string => {
  const joined = parts.filter((part) => part !== "").join("/");

  if (joined.startsWith("/")) return normalize(joined);

  const normalized = normalize(joined).slice(1);

  return normalized === "" ? "." : normalized;
};

/** The directory holding `path`; the root's is the root. */
export const dirname = (path: string): string => {
  const index = path.lastIndexOf("/");

  return index <= 0 ? "/" : path.slice(0, index);
};

/** The last segment of `path`; the root's is empty. */
export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Whether `path` is `ancestor` or below it. */
export const isWithin = (path: string, ancestor: string): boolean =>
  path === ancestor || path.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);

/** The ancestors of `path`, nearest first, ending at the root. */
export const ancestors = (path: string): string[] => {
  const result: string[] = [];

  for (let current = path; current !== "/";) {
    current = dirname(current);
    result.push(current);
  }

  return result;
};

const decodeFileUrl = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    // A malformed URL stays an ordinary path, so file operations keep their non-throwing contract.
    return url;
  }
};
