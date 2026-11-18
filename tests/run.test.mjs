// Tests for the runner's own mechanics: the spawn/env contract, kill and
// timeout handling, and --fast. Failures are in the execution itself, so spawn
// and the clock are injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main } from "../src/cli.mjs";
import { CODES, RESET } from "../src/colour.mjs";
import { recordTimings } from "../src/fast.mjs";
import { killTree } from "../src/execute.mjs";
import { countLine, runSuites, summaryLine } from "../src/run.mjs";
import { FIX_GLOB, capture, configOf, graphFixture, stubSpawn, suiteOf, tempRoot } from "./helpers.mjs";

const green = (text) => `${CODES.green}${text}${RESET}`;
const red = (text) => `${CODES.red}${text}${RESET}`;

// --- runs, spawn and timeouts ----------------------------------------------

test("a run spawns node with the tests in the run's cwd and its env", async (t) => {
  const repo = graphFixture(t);
  const spawn = stubSpawn();
  await runSuites([suiteOf("fix", [FIX_GLOB], { env: { A: "1" } })], {
    repoRoot: repo,
    _spawn: spawn.spawn,
    _tmpdir: tempRoot(t),
  });
  const call = spawn.calls[0];
  assert.equal(call.args[0], "--test", "the file list must follow --test");
  assert.ok(call.args.includes("plugins/fix/tests/transitive.test.mjs"), call.args.join(" "));
  assert.equal(call.opts.cwd, repo);
  assert.equal(call.opts.env.A, "1");
});

test("the reporter child gets TEST_COLOUR and SLOW_MS, and a command run gets neither", async (t) => {
  const repo = graphFixture(t);
  // Sentinel ambient values: a command run must pass them through untouched,
  // where the reporter child must override them with this run's own.
  const saved = { TEST_COLOUR: process.env.TEST_COLOUR, SLOW_MS: process.env.SLOW_MS };
  process.env.TEST_COLOUR = "ambient";
  process.env.SLOW_MS = "ambient";
  try {
    const reporter = stubSpawn();
    await runSuites([suiteOf("fix", [FIX_GLOB])], {
      repoRoot: repo,
      colour: true,
      slowMs: 500,
      _spawn: reporter.spawn,
      _tmpdir: tempRoot(t),
    });
    const env = reporter.calls[0].opts.env;
    assert.equal(env.TEST_COLOUR, "1");
    assert.equal(env.SLOW_MS, "500");

    const plain = stubSpawn();
    await runSuites([suiteOf("fix", [FIX_GLOB])], {
      repoRoot: repo,
      colour: false,
      slowMs: 500,
      _spawn: plain.spawn,
      _tmpdir: tempRoot(t),
    });
    assert.equal(plain.calls[0].opts.env.TEST_COLOUR, "0");

    const command = stubSpawn();
    await runSuites([{ name: "rust", runs: [{ cwd: ".", command: ["cargo", "test"], timeoutMs: 600000 }] }], {
      repoRoot: repo,
      colour: true,
      slowMs: 500,
      _spawn: command.spawn,
      _tmpdir: tempRoot(t),
    });
    const commandEnv = command.calls[0].opts.env;
    assert.equal(commandEnv.TEST_COLOUR, "ambient", "a command run was told how to colour");
    assert.equal(commandEnv.SLOW_MS, "ambient", "a command run was told what slow means");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the parent's summary and count lines colour on the outcome and only on it", () => {
  const ok = { label: "fix", status: "pass", ok: true, durationMs: 1200 };
  const failed = { label: "fix", status: "fail", ok: false, durationMs: 1200 };
  const timeout = { label: "fix", status: "timeout", ok: false, durationMs: 1200 };
  const noFiles = { label: "fix", status: "no-files", ok: false, durationMs: 1200 };
  const skipped = { label: "fix", status: "skipped", ok: true, durationMs: 1200 };

  assert.equal(summaryLine(ok, true), green("[test] fix: PASS in 1.2s"));
  assert.equal(summaryLine(failed, true), red("[test] fix: FAIL in 1.2s"));
  assert.equal(summaryLine(timeout, true), red("[test] fix: TIMEOUT in 1.2s"));
  assert.equal(summaryLine(noFiles, true), red("[test] fix: NO-FILES in 1.2s"));
  assert.equal(summaryLine(skipped, true), "[test] fix: SKIPPED in 1.2s", "a skip is not a colour");
  assert.equal(summaryLine(ok, false), "[test] fix: PASS in 1.2s");

  assert.equal(countLine([ok, ok], true), green("[test] 2/2 run(s) passed"));
  assert.equal(countLine([ok, skipped], true), green("[test] 2/2 run(s) passed"));
  assert.equal(countLine([ok, failed], true), red("[test] 1/2 run(s) passed"));
  assert.equal(countLine([ok, failed], false), "[test] 1/2 run(s) passed");
});

test("killTree uses taskkill /T on win32 and the process group elsewhere", () => {
  const spawned = [];
  killTree(99, { _platform: "win32", _spawnSync: (...args) => spawned.push(args) });
  assert.deepEqual(spawned[0], ["taskkill", ["/T", "/F", "/PID", "99"], { stdio: "ignore" }]);

  const killed = [];
  killTree(99, { _platform: "linux", _kill: (pid, signal) => killed.push([pid, signal]) });
  assert.deepEqual(killed, [[-99, "SIGKILL"]]);
});

test("a run past its timeout is killed and reported failed", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 30;
  const killed = [];
  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _config: configOf([suite]),
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: (pid) => killed.push(pid),
    _log: (line) => lines.push(line),
    _err: () => {},
    _tmpdir: tempRoot(t),
  });
  assert.equal(code, 1, "a timed-out run must fail the runner");
  assert.deepEqual(killed, [777], "the run's tree was not killed");
  assert.match(lines.join("\n"), /TIMEOUT/);
});

/** A reporter's in-flight record, as the killed run would have left it. */
function inFlightRecord(repo, name, files) {
  const dir = join(repo, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ pid: 1, label: "slow", files }), "utf8");
}

test("a timeout names this run's own unfinished files, and only those", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 30;
  inFlightRecord(repo, "slow.777.inflight.json", [
    { file: "plugins/fix/tests/transitive.test.mjs", startedAt: 0 },
    { file: "plugins/fix/tests/unrelated.test.mjs", startedAt: 0 },
  ]);
  inFlightRecord(repo, "slow.778.inflight.json", [
    { file: "plugins/fix/tests/join-cli.test.mjs", startedAt: 0 },
  ]);

  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _config: configOf([suite]),
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _now: () => 125000,
    _log: (line) => lines.push(line),
    _err: () => {},
    _tmpdir: tempRoot(t),
  });

  const out = lines.join("\n");
  assert.equal(code, 1);
  assert.match(
    out,
    /still running: plugins\/fix\/tests\/transitive\.test\.mjs \(2m05s\), plugins\/fix\/tests\/unrelated\.test\.mjs \(2m05s\)/,
    out,
  );
  assert.ok(!out.includes("join-cli.test.mjs"), `another pid's record reached the reason:\n${out}`);
});

test("a missing or corrupt in-flight record leaves the plain timeout reason", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 20;
  inFlightRecord(repo, "slow.777.inflight.json", []);
  writeFileSync(join(repo, "test-results", "slow.777.inflight.json"), "{not json", "utf8");

  const lines = [];
  const tmp = tempRoot(t);
  const run = () => main(["--suite", "slow"], {
    cwd: repo,
    _config: configOf([suite]),
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _log: (line) => lines.push(line),
    _err: () => {},
    _tmpdir: tmp,
  });

  assert.equal(await run(), 1);
  assert.match(lines.join("\n"), /: TIMEOUT -- no exit within 20ms in /);
  assert.ok(!lines.join("\n").includes("still running"), lines.join("\n"));

  // The runner unlinked the corrupt record after the run; now it is absent too.
  lines.length = 0;
  assert.equal(await run(), 1);
  assert.match(lines.join("\n"), /: TIMEOUT -- no exit within 20ms in /);
});

test("a run cleared a stale log before a timeout, so the log line is not printed", async (t) => {
  const repo = graphFixture(t);
  const suite = suiteOf("slow", [FIX_GLOB]);
  suite.runs[0].timeoutMs = 20;
  const dir = join(repo, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slow.log"), "the previous run\n", "utf8");

  const lines = [];
  const code = await main(["--suite", "slow"], {
    cwd: repo,
    _config: configOf([suite]),
    _spawn: stubSpawn({ never: true, pid: 777 }).spawn,
    _killTree: () => {},
    _log: (line) => lines.push(line),
    _err: () => {},
    _tmpdir: tempRoot(t),
  });

  assert.equal(code, 1);
  assert.ok(!lines.join("\n").includes("log:"), `a killed run pointed at the last run's log:\n${lines.join("\n")}`);
});

// --- --fast ----------------------------------------------------------------

test("--fast runs everything with no timings, then skips a measured-slow file", async (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("fix", [FIX_GLOB])];

  const cold = stubSpawn();
  const coldOut = capture();
  assert.equal(await main(["--suite", "fix", "--fast"], {
    cwd: repo, _config: configOf(suites), _spawn: cold.spawn, _log: coldOut.log, _err: coldOut.err,
    _tmpdir: tempRoot(t),
  }), 0);
  assert.match(coldOut.lines.join("\n"), /--fast: no timings recorded yet; running everything/);
  assert.ok(cold.calls[0].args.includes("plugins/fix/tests/transitive.test.mjs"), "an unmeasured file was skipped");

  recordTimings({
    resultsDir: join(repo, "test-results"),
    repoRoot: repo,
    entries: [{ file: "plugins/fix/tests/transitive.test.mjs", ms: 45000 }],
  });

  const warm = stubSpawn();
  const warmOut = capture();
  assert.equal(await main(["--suite", "fix", "--fast"], {
    cwd: repo, _config: configOf(suites), _spawn: warm.spawn, _log: warmOut.log, _err: warmOut.err,
    _tmpdir: tempRoot(t),
  }), 0);
  assert.match(
    warmOut.lines.join("\n"),
    /--fast skipped 1 measured-slow file\(s\): plugins\/fix\/tests\/transitive\.test\.mjs/,
  );
  assert.ok(!warm.calls[0].args.includes("plugins/fix/tests/transitive.test.mjs"), "the measured-slow file still ran");
  assert.ok(warm.calls[0].args.includes("plugins/fix/tests/unrelated.test.mjs"), "a fast file was skipped too");
});

test("a run --fast empties reports skipped and exits 0", async (t) => {
  const repo = graphFixture(t);
  const suites = [suiteOf("one", ["plugins/fix/tests/transitive.test.mjs"])];
  recordTimings({
    resultsDir: join(repo, "test-results"),
    repoRoot: repo,
    entries: [{ file: "plugins/fix/tests/transitive.test.mjs", ms: 45000 }],
  });

  const spawn = stubSpawn();
  const out = capture();
  const code = await main(["--suite", "one", "--fast"], {
    cwd: repo, _config: configOf(suites), _spawn: spawn.spawn, _log: out.log, _err: out.err,
  });

  assert.equal(code, 0, out.lines.join("\n"));
  assert.equal(spawn.calls.length, 0, "an emptied run spawned node --test");
  assert.match(out.lines.join("\n"), /\[test\] one: SKIPPED -- --fast skipped 1 measured-slow file\(s\)/);
});
