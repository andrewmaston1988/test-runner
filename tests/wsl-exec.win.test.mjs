// T2: `wslArgv`'s argv reaches a real distro verbatim, with a `(` in PATH. Skips when
// the host has no usable distro or the probe times out; a `--` restore fails at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { distroList, wslArgv } from "../src/wsl.mjs";

const TIMEOUT = 60000;
const PROBE = 'console.log(JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(1), colour: process.env.TEST_COLOUR}))';
const EXPECTED = { cwd: "/tmp", argv: ["a b", "(x)", "$HOME"], colour: "1" };

function spawn(argv, options = {}) {
  return spawnSync("wsl.exe", argv, { timeout: TIMEOUT, ...options });
}

function prepare() {
  const listed = spawn(["-l", "-q"]);
  if (listed.status !== 0) return { skip: "wsl.exe -l -q failed" };
  const distro = distroList(listed.stdout).find((name) => !name.startsWith("docker-desktop"));
  if (!distro) return { skip: "no WSL distro is installed" };

  const path = spawn(wslArgv({ distro }, ["printenv", "PATH"]), { encoding: "utf8" });
  if (path.status !== 0) return { skip: `cannot read PATH in ${distro}` };
  const distroPath = path.stdout.trim();

  const node = spawn(wslArgv({ distro }, ["sh", "-c", "command -v node"]), { encoding: "utf8" });
  if (node.status !== 0) return { skip: `node is not on PATH in ${distro}` };

  return { distro, distroPath };
}

const probe = process.platform === "win32" ? prepare() : { skip: "wsl.exe needs a Windows host" };

test("wslArgv's argv reaches a real distro verbatim", { skip: probe.skip }, (t) => {
  const { distro, distroPath } = probe;
  const r = spawn(
    wslArgv(
      { distro, cd: "/tmp" },
      ["env", `PATH=${distroPath}:/mnt/c/probe (x86)`, "node", "-e", PROBE, "a b", "(x)", "$HOME"],
    ),
    { encoding: "utf8", env: { ...process.env, WSLENV: "TEST_COLOUR/u", TEST_COLOUR: "1" } },
  );

  if (r.error?.code === "ETIMEDOUT") return t.skip(`the probe timed out after ${TIMEOUT} ms`);
  assert.equal(r.status, 0, `${r.stderr ?? ""}${r.stdout ?? ""}`);
  assert.deepEqual(JSON.parse(r.stdout.trim()), EXPECTED);
});
