// The runner's non-node execution routes: installs and their argv, a runner
// run's own argv and Windows' cap, and the cargo -p hand-off in diff mode.
// Every process call is injected, so each route is asserted without running it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installIfNeeded } from "../src/execute.mjs";
import { runSuites } from "../src/run.mjs";
import { commandSpawn } from "../src/spawn-command.mjs";
import { FIX_GLOB, capture, graphFixture, makeRepo, stubSpawn, suiteOf, tempRoot, write } from "./helpers.mjs";

// --- install ---------------------------------------------------------------

const memoryFs = (files) => ({
  existsSync: (path) => files.has(path),
  readFileSync: (path) => {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    return files.get(path);
  },
  writeFileSync: (path, value) => files.set(path, value),
  mkdirSync: () => {},
});

test("install runs when the hash is missing or differs, and is skipped when it matches", () => {
  const cwd = join(tmpdir(), "install-fixture");
  const lockfile = join(cwd, "package-lock.json");
  const record = join(cwd, "node_modules", ".test-install-hash");
  const files = new Map([[lockfile, '{"lockfileVersion":3}']]);
  const calls = [];
  const options = {
    cwd,
    install: ["npm", "ci"],
    _fs: memoryFs(files),
    _spawnSync: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    _platform: "linux",
  };

  assert.equal(installIfNeeded(options).installed, true);
  assert.deepEqual(calls[0].slice(0, 2), ["npm", ["ci"]]);
  assert.ok(files.has(record), "the hash was not recorded");

  assert.equal(installIfNeeded(options).installed, false);
  assert.equal(calls.length, 1, "a matching hash still reinstalled");

  files.set(lockfile, '{"lockfileVersion":3,"changed":true}');
  assert.equal(installIfNeeded(options).installed, true);
  assert.equal(calls.length, 2);

  files.set(lockfile, "different again");
  assert.match(installIfNeeded({ ...options, _spawnSync: () => ({ status: 1 }) }).error, /install failed/);

  // A suite with no lockfile has nothing to hash, so it installs nothing.
  const bare = [];
  const none = installIfNeeded({
    cwd: join(tmpdir(), "no-lockfile"),
    install: ["npm", "ci"],
    _fs: memoryFs(new Map()),
    _spawnSync: (...args) => bare.push(args),
  });
  assert.equal(none.installed, false);
  assert.equal(bare.length, 0);
});

test("an install argv is never handed to a shell, so an argument cannot start a second command", () => {
  const calls = [];
  const lockfile = join(tmpdir(), "shell-free", "package-lock.json");
  installIfNeeded({
    cwd: join(tmpdir(), "shell-free"),
    install: ["npm", "ci", "a&&b"],
    _fs: memoryFs(new Map([[lockfile, "{}"]])),
    _spawnSync: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    _platform: "win32",
  });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0][2].shell, true, "the install ran through a shell");
  const { file, args } = commandSpawn(["npm", "ci", "a&&b"], { platform: "win32" });
  assert.deepEqual(calls[0].slice(0, 2), [file, args], "install took a route command runs do not");
});

// --- Python: a runner run and its argv cap ---------------------------------

/** Files under tests/ whose cwd-relative paths bring the argv past `target`. */
function fillArgv(repo, runner, target) {
  const dir = Array.from({ length: 3 }, () => "d".repeat(50)).join("/");
  const files = [];
  while ([...runner, ...files].join(" ").length < target) {
    const file = `tests/${dir}/test_${files.length}.py`;
    write(repo, file, "def test_x():\n    assert True\n");
    files.push(file);
  }
  return files;
}

/** A `.cmd` file that exists on disk, so the batch route is taken on any host. */
function cmdShim(t) {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = join(dir, "pytest.cmd");
  writeFileSync(shim, "@echo off\r\n");
  return shim;
}

const runnerSuite = (runner) => ({
  name: "py",
  runs: [{ cwd: ".", globs: ["tests/**/test_*.py"], runner, timeoutMs: 600000 }],
});

test("a runner run spawns its own argv with the selected files and none of node's flags", async (t) => {
  const repo = graphFixture(t);
  const saved = {};
  const ambient = { TEST_COLOUR: "ambient", SLOW_MS: "ambient", TEST_RUN_LABEL: "ambient", TEST_RESULTS_DIR: "ambient" };
  for (const [key, value] of Object.entries(ambient)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const spawn = stubSpawn();
    const suite = {
      name: "fix",
      runs: [{
        cwd: ".", globs: ["plugins/fix/tests/*.test.mjs"], runner: ["python", "-m", "pytest"],
        env: { PYTHONPATH: "src" }, timeoutMs: 600000,
      }],
    };
    await runSuites([suite], {
      repoRoot: repo, colour: true, slowMs: 500, _platform: "linux", _spawn: spawn.spawn, _tmpdir: tempRoot(t),
    });
    const call = spawn.calls[0];
    assert.equal(call.cmd, "python");
    assert.deepEqual(call.args.slice(0, 3), [
      "-m", "pytest", "plugins/fix/tests/dynamic.test.mjs",
    ], call.args.join(" "));
    assert.ok(!call.args.includes("--test"), "node's --test reached the runner");
    assert.ok(!call.args.some((arg) => arg.startsWith("--test-reporter")), "the reporter reached the runner");
    assert.equal(call.opts.cwd, repo);
    assert.equal(call.opts.env.PYTHONPATH, "src");
    for (const [key, value] of Object.entries(ambient)) {
      assert.equal(call.opts.env[key], value, `the runner branch rewrote ${key}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a node run still uses --test and its own colour and slow values", async (t) => {
  const repo = graphFixture(t);
  const saved = { TEST_COLOUR: process.env.TEST_COLOUR, SLOW_MS: process.env.SLOW_MS };
  process.env.TEST_COLOUR = "ambient";
  process.env.SLOW_MS = "ambient";
  try {
    const spawn = stubSpawn();
    await runSuites([suiteOf("fix", [FIX_GLOB])], {
      repoRoot: repo, colour: false, slowMs: 250, _spawn: spawn.spawn, _tmpdir: tempRoot(t),
    });
    const call = spawn.calls[0];
    assert.equal(call.args[0], "--test");
    assert.ok(call.args.some((arg) => arg.startsWith("--test-reporter=")), call.args.join(" "));
    assert.equal(call.opts.env.TEST_COLOUR, "0");
    assert.equal(call.opts.env.SLOW_MS, "250");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("an argv past cmd.exe's 8,191 runs the bare runner", async (t) => {
  const shim = cmdShim(t);
  const runner = [shim, "-m", "pytest"];

  const over = graphFixture(t);
  const overFiles = fillArgv(over, runner, 8600);
  assert.ok([...runner, ...overFiles].join(" ").length > 8000, "the fixture did not cross 8,191");
  const bare = stubSpawn();
  const logs = capture();
  await runSuites([runnerSuite(runner)], {
    repoRoot: over, _platform: "win32", _spawn: bare.spawn, _log: logs.log, _tmpdir: tempRoot(t),
  });
  const bareArgs = bare.calls[0].args.join(" ");
  assert.doesNotMatch(bareArgs, /test_\d+\.py/, `a file list was handed to cmd.exe: ${bareArgs}`);
  assert.match(logs.lines.join("\n"), /need more than the 8000 argv characters .*running it with no file list/,
    logs.lines.join("\n"));

  const under = graphFixture(t);
  const underFiles = fillArgv(under, runner, 6500);
  assert.ok([...runner, ...underFiles].join(" ").length < 8000, "the fixture already crossed 8,191");
  const kept = stubSpawn();
  await runSuites([runnerSuite(runner)], {
    repoRoot: under, _platform: "win32", _spawn: kept.spawn, _tmpdir: tempRoot(t),
  });
  assert.match(kept.calls[0].args.join(" "), /test_0\.py/, "the file list was dropped under the limit");
});

test("an argv past CreateProcess's 32,767 runs the bare runner", async (t) => {
  const runner = [process.execPath, "-m", "pytest"];

  const over = graphFixture(t);
  const overFiles = fillArgv(over, runner, 32500);
  assert.ok([...runner, ...overFiles].join(" ").length > 32000, "the fixture did not cross 32,767");
  const bare = stubSpawn();
  await runSuites([runnerSuite(runner)], {
    repoRoot: over, _platform: "win32", _spawn: bare.spawn, _tmpdir: tempRoot(t),
  });
  assert.doesNotMatch(bare.calls[0].args.join(" "), /test_\d+\.py/, "the file list was spawned over the limit");

  const under = graphFixture(t);
  const underFiles = fillArgv(under, runner, 29500);
  assert.ok([...runner, ...underFiles].join(" ").length < 32000, "the fixture already crossed 32,767");
  const kept = stubSpawn();
  await runSuites([runnerSuite(runner)], {
    repoRoot: under, _platform: "win32", _spawn: kept.spawn, _tmpdir: tempRoot(t),
  });
  assert.match(kept.calls[0].args.join(" "), /test_0\.py/, "the file list was dropped under the limit");
});

// --- the cargo -p hand-off in diff mode (cargo R14) ---------------------------

const cargoRun = (extra = {}) => ({
  label: "test", cwd: ".", command: ["cargo", "test"], cargo: true, timeoutMs: 600000, ...extra,
});

/** runSuites over the cargo suite with a selected set, capturing the spawn and log. */
async function pickedSpawn(t, repo, keys) {
  const spawn = stubSpawn();
  const out = capture();
  await runSuites([{ name: "rust", runs: [cargoRun()] }], {
    repoRoot: repo, selected: keys, _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
    _tmpdir: tempRoot(t),
  });
  return { spawn, lines: out.lines };
}

test("a run selected only by crate keys builds the -p argv, and the whole key beats them", async (t) => {
  const repo = makeRepo(t);

  // Nothing of this suite selected — no whole key, no crate key — skips the run.
  const none = await pickedSpawn(t, repo, new Set(["unit\0tests/a.test.mjs"]));
  assert.deepEqual(none.spawn.calls, [], "an unselected cargo run was spawned");
  assert.match(none.lines.join("\n"), /^\[test\] rust\[test\]: skipped \(nothing selected\)$/m);

  // Crate keys without the whole key build the sorted -p argv.
  const crates = await pickedSpawn(t, repo, new Set([
    "rust\0command:test#gamma", "rust\0command:test#alpha",
  ]));
  assert.deepEqual(crates.spawn.calls[0].args, ["test", "-p", "alpha", "-p", "gamma"]);
  assert.equal(crates.spawn.calls.length, 1, "the run spawned more than once");

  // The whole key present runs the declared argv; crate keys ride along ignored.
  const whole = await pickedSpawn(t, repo, new Set(["rust\0command:test", "rust\0command:test#alpha"]));
  assert.deepEqual(whole.spawn.calls[0].args, ["test"]);
});
