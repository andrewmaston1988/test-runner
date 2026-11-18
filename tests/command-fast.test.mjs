// --fast skip args and command timings: what a long-running test deselects,
// and what a passing run records.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runSuites } from "../src/run.mjs";
import { capture, commandSuite, commitAll, git, makeRepo, stubSpawn, write } from "./helpers.mjs";

// --- --fast skip args and command timings (R11/R12) ---------------------------

const DAY = 24 * 60 * 60 * 1000;

/** A committed repo whose `test-results/` stays untracked-and-ignored, so the
 *  tree stamps `dirty: false` however late the timings file is written. */
async function stampedRepo(t) {
  const repo = makeRepo(t);
  write(repo, ".gitignore", "test-results/\n");
  commitAll(repo, "seed");
  return repo;
}

const junitCommandEntry = (sha, now) => ({
  at: now - 3_600_000,
  sha,
  dirty: false,
  tests: {
    "slow::one": { ms: 31_000, nodeid: "tests/test_x.py::slow_one" },
    "edge::zero": { ms: 30_000 },
    "quick::two": { ms: 500 },
    "stale::old": { ms: 31_000, nodeid: "tests/test_x.py::stale_old", sha: "a-different-tree" },
    "bare::num": 31_000,
    "aged::out": { ms: 31_000, nodeid: "tests/test_x.py::aged_out", at: now - 8 * DAY },
  },
});

test("a junit --fast fastSkip run deselects exactly the long-running tests", async (t) => {
  const repo = await stampedRepo(t);
  const sha = git(repo, "rev-parse", "HEAD").trim();
  const NOW = 1_800_000_000_000;
  write(repo, "test-results/timings.json", `${JSON.stringify({ "command:0": junitCommandEntry(sha, NOW) }, null, 2)}\n`);
  const spawn = stubSpawn({ code: 0 });
  const out = capture();
  await runSuites([commandSuite(["pytest"], { format: "junit", fastSkip: true })], {
    repoRoot: repo, _spawn: spawn.spawn, _log: out.log, _writeErr: () => {}, _now: () => NOW,
    fast: true,
  });
  // The stub sees the args past the resolved command, so the deselects arrive
  // as the whole argv. The command name resolves against this machine's PATH
  // and is none of the row's business.
  assert.deepEqual(spawn.calls[0].args, ["--deselect", "tests/test_x.py::slow_one"]);
  assert.ok(out.lines.join("\n").includes("[test] cmd: --fast skipping 1 measured-slow test(s): slow::one"), out.lines.join("\n"));
});

test("fastSkip is default off, and tap and libtest run whole with a warning", async (t) => {
  const repo = await stampedRepo(t);
  const NOW = 1_800_000_000_000;
  for (const [format, argvEndsClean] of [["tap", true], ["libtest", true], ["junit", true]]) {
    const spawn = stubSpawn({ code: 0 });
    const out = capture();
    await runSuites([commandSuite(["pytest"], { format, ...(format === "tap" || format === "libtest" ? { fastSkip: true } : {}) })], {
      repoRoot: repo, _spawn: spawn.spawn, _log: out.log, _writeErr: () => {}, _now: () => NOW,
      fast: true,
    });
    assert.deepEqual(spawn.calls[0].args, [], `${format} grew skip args`);
    const text = out.lines.join("\n");
    if (format === "junit") {
      assert.ok(!text.includes("running whole"), "a default-off junit run warned");
      assert.ok(!text.includes("measured-slow test(s)"), "a default-off junit run named a skip");
    } else {
      assert.match(text, /--fast/, `a ${format} fastSkip run printed no warning`);
      assert.match(text, /running whole/, `a ${format} fastSkip run printed no warning`);
    }
  }
});

test("a junit run with no recorded timings runs whole", async (t) => {
  const repo = await stampedRepo(t);
  const spawn = stubSpawn({ code: 0 });
  const out = capture();
  await runSuites([commandSuite(["pytest"], { format: "junit", fastSkip: true })], {
    repoRoot: repo, _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
  });
  assert.deepEqual(spawn.calls[0].args, []);
  assert.doesNotMatch(out.lines.join("\n"), /measured-slow test\(s\)/);
});

test("a passing --fast run records its timed tests stamped with the tree", async (t) => {
  const repo = await stampedRepo(t);
  const sha = git(repo, "rev-parse", "HEAD").trim();
  const spawn = stubSpawn({ code: 0, out: "TAP version 13\nok 1 - adds\n  ---\n  duration_ms: 120.4\n  ...\nok 2 - slow\n  ---\n  duration_ms: 40000.9\n  ...\n1..2\n" });
  const out = capture();
  const testStart = Date.now();
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
    fast: true,
  });
  const recorded = JSON.parse(readFileSync(join(repo, "test-results", "timings.json"), "utf8"))["command:0"];
  assert.equal(recorded.sha, sha, "the record carried another tree's sha");
  assert.equal(recorded.dirty, false, "an ignored results dir stamped the tree dirty");
  assert.ok(recorded.at >= testStart, "the record predates the run");
  assert.deepEqual(recorded.tests, { adds: { ms: 120 }, slow: { ms: 40001 } });
});

test("the recording merges names absent from this run's events", async (t) => {
  const repo = await stampedRepo(t);
  const sha = git(repo, "rev-parse", "HEAD").trim();
  write(repo, "test-results/timings.json", `${JSON.stringify({
    "command:0": { at: 1, sha, dirty: false, tests: { "deselected::one": { ms: 31_000, nodeid: "tests/test_x.py::deselected" }, old: { ms: 5 } } },
  }, null, 2)}\n`);
  const spawn = stubSpawn({ code: 0, out: "TAP version 13\nok 1 - adds\n  ---\n  duration_ms: 120\n  ...\n1..1\n" });
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _spawn: spawn.spawn, _log: () => {}, _writeErr: () => {},
    fast: true,
  });
  const tests = JSON.parse(readFileSync(join(repo, "test-results", "timings.json"), "utf8"))["command:0"].tests;
  assert.deepEqual(tests, {
    "deselected::one": { ms: 31_000, nodeid: "tests/test_x.py::deselected" },
    old: { ms: 5 },
    adds: { ms: 120 },
  });
});

test("a junit run without a file attribute records no nodeid, so --fast deselects nothing", async (t) => {
  const repo = await stampedRepo(t);
  const xml = '<testsuite><testcase classname="tests.test_x" name="slow" time="40"/></testsuite>';
  await runSuites([commandSuite(["pytest"], { format: "junit" })], {
    repoRoot: repo, _spawn: stubSpawn({ code: 0, out: xml }).spawn,
    _log: () => {}, _writeErr: () => {}, fast: true,
  });
  const tests = JSON.parse(readFileSync(join(repo, "test-results", "timings.json"), "utf8"))["command:0"].tests;
  assert.deepEqual(tests, { "tests.test_x::slow": { ms: 40_000 } }, "the display-form nodeid was recorded");
});

test("a failing run records nothing", async (t) => {
  const repo = await stampedRepo(t);
  const spawn = stubSpawn({ code: 1, out: "TAP version 13\nok 1 - adds\n  ---\n  duration_ms: 120\n  ...\n1..1\n" });
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _spawn: spawn.spawn, _log: () => {}, _writeErr: () => {},
    fast: true,
  });
  assert.equal(existsSync(join(repo, "test-results", "timings.json")), false, "a failing run wrote a record");
});
