// The Container's exec runs commands with `/bin/sh -c`, which is dash on Debian; `bash` promises bash. `inBash` is
// what a command is wrapped in, checked here under dash itself.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inBash } from "./shell.ts";

const DASH = "/bin/dash";

/** Runs `script` the way computerd does: `/bin/sh -c`, with dash as the shell. */
const underDash = (script: string) => spawnSync(DASH, ["-c", inBash(script)], { encoding: "utf8" });

describe.skipIf(!existsSync(DASH))("inBash under dash", () => {
  it("runs bash syntax that dash cannot", () => {
    const result = underDash(
      'items=(a b c); [[ ${items[1]} == b ]] && echo "second: ${items[1]}"; cat <(echo substituted)',
    );

    expect(result.stdout).toBe("second: b\nsubstituted\n");
    expect(result.status).toBe(0);
  });

  it("passes quotes, dollars, backslashes and newlines through unchanged", () => {
    const result = underDash("printf '%s|' \"it's\" '$HOME' 'a\\b'\necho done");

    expect(result.stdout).toBe("it's|$HOME|a\\b|done\n");
  });

  it("keeps the exit status and the streams apart", () => {
    const result = underDash("echo out; echo err >&2; exit 3");

    expect(result).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n" });
  });
});
