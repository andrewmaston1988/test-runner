// The temp root one dispatch gets: every kind of run sees the same one dir,
// it is removed on a pass and kept as evidence on a failure, and a run.env
// temp var opts the whole thing out.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { runSuites } from "../src/run.mjs";
import { withTempRoot } from "../src/temp-root.mjs";
import { makeRepo, tempRoot, write } from "./helpers.mjs";

/** The three run kinds' probes: each records what the child saw as TEMP, TMP
 *  and TMPDIR, and makes one dir under `os.tmpdir()` -- the leak this feature
 *  exists to contain. `PROBE_MODE` picks the outcome. */
const GLOBS_PROBE = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const leak = mkdtempSync(join(tmpdir(), "leak-"));
if (process.env.PROBE_OUT) {
  writeFileSync(process.env.PROBE_OUT, JSON.stringify({
    temp: [process.env.TEMP, process.env.TMP, process.env.TMPDIR],
    leak,
  }));
}
test("probe", async () => {
  if (process.env.PROBE_MODE === "fail") throw new Error("probe fails");
  if (process.env.PROBE_MODE === "timeout") await new Promise(() => {});
});
`;

const SCRIPT_PROBE = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const leak = mkdtempSync(join(tmpdir(), "leak-"));
if (process.env.PROBE_OUT) {
  writeFileSync(process.env.PROBE_OUT, JSON.stringify({
    temp: [process.env.TEMP, process.env.TMP, process.env.TMPDIR],
    leak,
  }));
}
if (process.env.PROBE_MODE === "fail") process.exitCode = 1;
if (process.env.PROBE_MODE === "timeout") setTimeout(() => {}, 60000);
`;

function writeProbes(repo) {
  write(repo, "tests/probe.test.mjs", GLOBS_PROBE);
  write(repo, "tests/probe.mjs", SCRIPT_PROBE);
  write(repo, "tests/fixture.py", "def test_fixture():\n    assert True\n");
}

/** The three run kinds over the probes. `bracket` labels carry `[`/`]`, as
 *  `suite[label]` does. A timeout mode gives node --test more room to start
 *  than the script runs need; both are killed well after the probe writes. */
function probeSuite(mode, out, { bracket = false } = {}) {
  const label = (name) => (bracket ? `${name}[x]` : name);
  const timeoutMs = mode === "timeout" ? (name) => (name === "globs" ? 4000 : 2000) : () => 60000;
  return [{
    name: "probe",
    runs: [
      {
        label: label("globs"), cwd: ".", globs: ["tests/probe.test.mjs"], timeoutMs: timeoutMs("globs"),
        env: { PROBE_MODE: mode, PROBE_OUT: out.globs },
      },
      {
        label: label("runner"), cwd: ".", globs: ["tests/fixture.py"],
        runner: [process.execPath, "tests/probe.mjs"], timeoutMs: timeoutMs("runner"),
        env: { PROBE_MODE: mode, PROBE_OUT: out.runner },
      },
      {
        label: label("command"), cwd: ".", command: [process.execPath, "tests/probe.mjs"],
        timeoutMs: timeoutMs("command"), env: { PROBE_MODE: mode, PROBE_OUT: out.command },
      },
    ],
  }];
}

const outPaths = (repo, mode) => ({
  globs: join(repo, `out-globs-${mode}.json`),
  runner: join(repo, `out-runner-${mode}.json`),
  command: join(repo, `out-command-${mode}.json`),
});

const probeOf = (file) => JSON.parse(readFileSync(file, "utf8"));

/** A node --test child inherits NODE_TEST_CONTEXT from this test file's own
 *  runner and would skip the file it was given. Consumers run from a shell,
 *  where the variable is absent, so it is cleared only for this fixture. */
async function asShell(fn) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

// --- A1 ---------------------------------------------------------------------

test("a globs, a runner and a command run all see one root under <tmpdir>/test-runner", async (t) => {
  const repo = makeRepo(t);
  writeProbes(repo);
  const base = tempRoot(t);
  const out = outPaths(repo, "pass");
  const results = await asShell(() => runSuites(probeSuite("pass", out, { bracket: true }), {
    repoRoot: repo, _tmpdir: base, _log: () => {},
  }));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));

  const prefixes = {
    globs: "probe_globs_x__-",
    runner: "probe_runner_x__-",
    command: "probe_command_x__-",
  };
  for (const [kind, file] of Object.entries(out)) {
    const { temp } = probeOf(file);
    assert.equal(temp[0], temp[1], `${kind}: TEMP and TMP differ`);
    assert.equal(temp[1], temp[2], `${kind}: TMP and TMPDIR differ`);
    assert.equal(dirname(temp[0]), join(base(), "test-runner"), `${kind}: the root is not under test-runner/`);
    assert.ok(basename(temp[0]).startsWith(prefixes[kind]),
      `${kind}: the label was not sanitised into the root name: ${basename(temp[0])}`);
  }
});

// --- A2 ---------------------------------------------------------------------

test("a passing run's root is deleted; a failed or timed-out one is kept and named", async (t) => {
  const repo = makeRepo(t);
  writeProbes(repo);
  const base = tempRoot(t);

  const passed = await asShell(() => runSuites(probeSuite("pass", outPaths(repo, "pass")), {
    repoRoot: repo, _tmpdir: base, _log: () => {},
  }));
  assert.ok(passed.every((result) => result.ok), JSON.stringify(passed));
  for (const [kind, file] of Object.entries(outPaths(repo, "pass"))) {
    const { temp } = probeOf(file);
    assert.equal(existsSync(temp[0]), false, `${kind}: a passing run kept its root`);
  }

  const labels = { globs: "probe[globs]", runner: "probe[runner]", command: "probe[command]" };
  for (const [mode, status] of [["fail", "fail"], ["timeout", "timeout"]]) {
    const lines = [];
    const out = outPaths(repo, mode);
    const results = await asShell(() => runSuites(probeSuite(mode, out), {
      repoRoot: repo, _tmpdir: base, _log: (line) => lines.push(line),
    }));
    assert.ok(results.every((result) => result.status === status), JSON.stringify(results));
    for (const [kind, file] of Object.entries(out)) {
      const { temp, leak } = probeOf(file);
      assert.equal(existsSync(temp[0]), true, `${kind}: a ${mode} run's root was deleted`);
      assert.equal(existsSync(leak), true, `${kind}: the ${mode} run's leak is not in the kept root`);
      assert.ok(lines.includes(`[test] ${labels[kind]}: temp root kept at ${temp[0]}`),
        `${kind}: no kept-root line named ${temp[0]}:\n${lines.join("\n")}`);
    }
  }
});

// --- A3 ---------------------------------------------------------------------

test("a run.env temp var is honoured and no root is made", async (t) => {
  const repo = makeRepo(t);
  writeProbes(repo);
  const base = tempRoot(t);
  const custom = join(base(), "custom-temp");
  nodeFs.mkdirSync(custom, { recursive: true });
  let roots = 0;
  const _fs = {
    ...nodeFs,
    mkdtempSync: (...args) => {
      roots++;
      return nodeFs.mkdtempSync(...args);
    },
  };
  const out = join(repo, "out-env.json");
  const [result] = await runSuites([{
    name: "probe",
    runs: [{
      label: "env", cwd: ".", command: [process.execPath, "tests/probe.mjs"], timeoutMs: 60000,
      env: { PROBE_MODE: "pass", PROBE_OUT: out, TEMP: custom },
    }],
  }], { repoRoot: repo, _tmpdir: base, _fs });

  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(probeOf(out).temp[0], custom, "the child did not see run.env's TEMP");
  assert.equal(roots, 0, "a root was created despite run.env's TEMP");
  assert.equal(existsSync(join(base(), "test-runner")), false, "the shared parent was created");
});

// --- A4 ---------------------------------------------------------------------

test("a delete that fails prints one named line and leaves the run's result alone", async () => {
  const root = join("tmp", "test-runner", "probe-abc123");
  const lines = [];
  const busy = {
    mkdirSync() {},
    mkdtempSync: () => root,
    readdirSync: () => [],
    rmSync: () => {
      const err = new Error("EBUSY: resource busy");
      err.code = "EBUSY";
      throw err;
    },
  };
  const result = await withTempRoot(
    { label: "probe", _fs: busy, _tmpdir: () => "tmp", _log: (line) => lines.push(line) },
    () => ({ ok: true, status: "pass" }),
  );
  assert.deepEqual(result, { ok: true, status: "pass" }, "a failed delete changed the result");
  assert.deepEqual(lines, [`[test] probe: could not remove temp root ${root} (EBUSY)`]);

  const recorded = [];
  const recording = {
    mkdirSync() {},
    mkdtempSync: () => root,
    readdirSync: () => [],
    rmSync: (path, options) => recorded.push([path, options]),
  };
  await withTempRoot({ label: "probe", _fs: recording, _tmpdir: () => "tmp" }, () => ({ ok: true }));
  assert.deepEqual(recorded, [[root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }]]);
});

// --- A5 ---------------------------------------------------------------------

test("the install step runs outside the temp root", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tools/package-lock.json", "{}\n");
  write(repo, "tools/tests/a.test.mjs", "export const a = 1;\n");
  const base = tempRoot(t);
  const installs = [];
  const spawns = [];
  const _spawnSync = (cmd, args, opts = {}) => {
    installs.push({ cmd, args, opts });
    return { status: 0 };
  };
  const _spawn = (file, args, opts) => {
    const child = {
      pid: 4242,
      once(event, cb) { if (event === "close") setImmediate(() => cb(0)); return child; },
    };
    spawns.push({ file, args, opts });
    return child;
  };

  const [result] = await runSuites([{
    name: "probe",
    runs: [{ label: "installed", cwd: "tools", globs: ["tests/*.test.mjs"], install: ["npm", "ci"], timeoutMs: 60000 }],
  }], { repoRoot: repo, _spawn, _spawnSync, _tmpdir: base, _platform: "linux" });

  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(installs.length, 1, "the install did not run");
  assert.equal(installs[0].opts.env, undefined, "the install spawn was handed the run's temp env");
  assert.equal(dirname(spawns[0].opts.env.TEMP), join(base(), "test-runner"),
    "the test spawn did not see the root");
});

// --- A6 ---------------------------------------------------------------------

test("an empty failed root is removed; a throw keeps its evidence and re-throws", async (t) => {
  const base = tempRoot(t);
  const created = [];
  const recordingFs = () => ({
    ...nodeFs,
    mkdtempSync: (dir) => {
      const root = nodeFs.mkdtempSync(dir);
      created.push(root);
      return root;
    },
  });

  const lines = [];
  const failed = await withTempRoot(
    { label: "empty", _fs: recordingFs(), _tmpdir: base, _log: (line) => lines.push(line) },
    () => ({ ok: false, status: "fail" }),
  );
  assert.equal(failed.status, "fail");
  assert.equal(created.length, 1);
  assert.equal(existsSync(created[0]), false, "an empty failed root was kept");
  assert.deepEqual(lines, [], "an empty failed root was named as kept");

  const err = new Error("after settle");
  const kept = [];
  await assert.rejects(
    withTempRoot(
      { label: "thrown", _fs: recordingFs(), _tmpdir: base, _log: (line) => kept.push(line) },
      () => {
        const root = created.at(-1);
        writeFileSync(join(root, "evidence.txt"), "kept\n");
        throw err;
      },
    ),
    /after settle/,
  );
  const root = created.at(-1);
  assert.equal(existsSync(join(root, "evidence.txt")), true, "the thrown run's evidence was deleted");
  assert.deepEqual(kept, [`[test] thrown: temp root kept at ${root}`], "a throw did not name the kept root");
});

// --- A7 ---------------------------------------------------------------------

test("one runSuites call gives each dispatch its own fresh root", async (t) => {
  const repo = makeRepo(t);
  write(repo, "tests/probe.mjs", SCRIPT_PROBE);
  const base = tempRoot(t);
  const first = join(repo, "one.json");
  const second = join(repo, "two.json");
  const run = (label, out, timeoutMs) => ({
    label, cwd: ".", command: [process.execPath, "tests/probe.mjs"], timeoutMs,
    env: { PROBE_MODE: "pass", PROBE_OUT: out },
  });

  const results = await runSuites([{ name: "probe", runs: [run("one", first, 60000), run("two", second, 60000)] }], {
    repoRoot: repo, _tmpdir: base,
  });

  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const a = probeOf(first).temp[0];
  const b = probeOf(second).temp[0];
  assert.notEqual(a, b, "both dispatches shared one temp root");
  assert.equal(dirname(a), join(base(), "test-runner"));
  assert.equal(dirname(b), join(base(), "test-runner"));
});
