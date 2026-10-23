// Docker in the Container (docs/spec.md → Container and Toolchains → Docker, ADR-0016): the daemon's configuration the
// image ships, and `cloudpid-dockerd`, the helper a Start Script calls to bring the daemon up. The helper runs for
// real, under bash, around a fake `dockerd` and `docker`.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off processEnv:off asyncFunction:off newPromise:off
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";

const helper = join(sandboxImageContext, "cloudpid-dockerd");
const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");

/**
 * A directory with a fake `dockerd`, which records its arguments and `DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE`, then
 * answers (`ready`) after `startSeconds` and stays up, and a fake `docker`, whose `info` succeeds once it answers.
 */
const fakes = (startSeconds: number) => {
  const dir = mkdtempSync(join(tmpdir(), "cloudpid-dockerd-"));

  writeFileSync(
    join(dir, "dockerd"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/started"
printf '%s\\n' "\${DOCKER_ALLOW_IPV6_ON_IPV4_INTERFACE:-unset}" > "${dir}/ipv6"
echo "dockerd: starting"
sleep ${startSeconds}
touch "${dir}/ready"
exec sleep 30
`,
  );
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
[ "$1" = info ] && [ -e "${dir}/ready" ]
`,
  );
  chmodSync(join(dir, "dockerd"), 0o755);
  chmodSync(join(dir, "docker"), 0o755);

  return dir;
};

type Ran = { readonly status: number | null; readonly stderr: string };

/** Run the helper with the fakes first on `PATH`, waiting at most `waitSeconds` for the daemon. */
const run = (dir: string, waitSeconds = 10): Promise<Ran> =>
  new Promise((resolve) => {
    const child = spawn("bash", [helper], {
      env: {
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        CLOUDPID_DOCKERD_LOG: join(dir, "dockerd.log"),
        CLOUDPID_DOCKERD_LOCK: join(dir, "lock"),
        CLOUDPID_DOCKERD_WAIT: String(waitSeconds),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });

const startedTimes = (dir: string): number =>
  existsSync(join(dir, "started"))
    ? readFileSync(join(dir, "started"), "utf8").trim().split("\n").length
    : 0;

describe("cloudpid-dockerd", () => {
  it("starts the daemon detached, with the variable that lets it come up without IPv6 forwarding, and waits for it", async () => {
    const dir = fakes(1);

    const ran = await run(dir);

    expect(ran.status).toBe(0);
    expect(startedTimes(dir)).toBe(1);
    expect(readFileSync(join(dir, "ipv6"), "utf8").trim()).toBe("1");
    // Its output goes to the log, not to the Start Script's.
    expect(readFileSync(join(dir, "dockerd.log"), "utf8")).toContain("dockerd: starting");
  });

  it("does nothing when the daemon answers already", async () => {
    const dir = fakes(0);

    writeFileSync(join(dir, "ready"), "");

    expect((await run(dir)).status).toBe(0);
    expect(startedTimes(dir)).toBe(0);
  });

  it("starts one daemon when called twice at once", async () => {
    const dir = fakes(1);

    const [first, second] = await Promise.all([run(dir), run(dir)]);

    expect([first.status, second.status]).toEqual([0, 0]);
    expect(startedTimes(dir)).toBe(1);
  });

  it("fails with the end of the daemon's log when it does not answer in time", async () => {
    const dir = fakes(20);

    const ran = await run(dir, 1);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("did not answer within 1 s");
    expect(ran.stderr).toContain("dockerd: starting");
  });
});

describe("the image's Docker", () => {
  it("configures the daemon without iptables or IP forwarding, which the Container's read-only /proc/sys refuses", () => {
    const config = JSON.parse(readFileSync(join(sandboxImageContext, "daemon.json"), "utf8"));

    expect(config).toEqual({ iptables: false, ip6tables: false, "ip-forward": false });
    expect(dockerfile).toContain("COPY daemon.json /etc/docker/daemon.json\n");
  });

  it("ships the helper on PATH", () => {
    expect(dockerfile).toContain(
      "COPY --chmod=755 cloudpid-dockerd /usr/local/bin/cloudpid-dockerd\n",
    );
  });
});
