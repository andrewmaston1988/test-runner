// The platform split: which runs and files execute on which host and flag, so
// that a Windows consumer's `--platform windows` plus `--wsl` run everything
// exactly once. The mirror side of `--wsl` is a plain run on a Linux host.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli.mjs";
import { capture, makeRepo, stubSpawn, write } from "./helpers.mjs";

/** One run of each platform, plus a `.win.test.mjs` inside the `any` run. */
const CONFIG = {
  suites: [{
    name: "mixed",
    runs: [
      { label: "node", globs: ["tests/*.test.mjs"] },
      { label: "win", command: ["win-tool"], platform: "windows" },
      { label: "lin", command: ["lin-tool"], platform: "linux" },
    ],
  }],
};

/** What one invocation executed: command names, and test files passed to node. */
async function executed(t, argv, platform) {
  const repo = makeRepo(t);
  write(repo, "tests/a.test.mjs");
  write(repo, "tests/b.win.test.mjs");
  const spawned = stubSpawn();
  const out = capture();
  const code = await main(argv, {
    cwd: repo, _config: CONFIG, _platform: platform, _spawn: spawned.spawn, _log: out.log, _err: out.err,
  });
  const units = [];
  for (const call of spawned.calls) {
    if (call.args.includes("--test")) units.push(...call.args.filter((arg) => arg.endsWith(".test.mjs")));
    else units.push(call.cmd);
  }
  return { code, units: units.sort(), out };
}

test("A5: --platform windows on Windows runs the windows run and the .win file only", async (t) => {
  const { code, units } = await executed(t, ["--all", "--platform", "windows"], "win32");
  assert.equal(code, 0);
  assert.deepEqual(units, ["tests/b.win.test.mjs", "win-tool"]);
});

test("A5: a plain run on Linux runs linux and any, minus the .win file, and names the skip", async (t) => {
  const { code, units, out } = await executed(t, ["--all"], "linux");
  assert.equal(code, 0);
  assert.deepEqual(units, ["lin-tool", "tests/a.test.mjs"]);
  const lines = out.lines.join("\n");
  assert.match(lines, /mixed\[win\]: skipped on this linux host \(platform: windows\)/);
  assert.match(lines, /mixed\[node\]: skipped 1 windows-only file\(s\)/);
});

test("A5: --platform windows plus the mirror's plain Linux run execute every unit exactly once", async (t) => {
  const windows = await executed(t, ["--all", "--platform", "windows"], "win32");
  const mirror = await executed(t, ["--all"], "linux");
  const union = [...windows.units, ...mirror.units].sort();
  assert.deepEqual(union, ["lin-tool", "tests/a.test.mjs", "tests/b.win.test.mjs", "win-tool"]);
  assert.equal(new Set(union).size, union.length, `a unit ran twice: ${union.join(", ")}`);
});

test("A5: a plain run on Windows runs any and windows, and the .win file", async (t) => {
  const { units } = await executed(t, ["--all"], "win32");
  assert.deepEqual(units, ["tests/a.test.mjs", "tests/b.win.test.mjs", "win-tool"]);
});

test("A5: --platform windows on Linux exits 2 and runs nothing", async (t) => {
  const { code, units, out } = await executed(t, ["--all", "--platform", "windows"], "linux");
  assert.equal(code, 2);
  assert.deepEqual(units, []);
  assert.match(out.errors.join("\n"), /--platform windows runs only on a Windows host/);
});

test("--platform takes only windows, and --wsl refuses it", async () => {
  const bad = capture();
  assert.equal(await main(["--platform", "linux"], { _log: bad.log, _err: bad.err }), 2);
  assert.match(bad.errors.join("\n"), /--platform takes windows, not linux/);
  const wsl = capture();
  assert.equal(await main(["--wsl", "--platform", "windows"], { _log: wsl.log, _err: wsl.err }), 2);
  assert.match(wsl.errors.join("\n"), /--wsl cannot be combined with --platform/);
});
