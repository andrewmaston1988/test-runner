// The {report} artifact token and the .mjs shim: how a run's output reaches the
// parser when it comes from a file or from a shim's events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runSuites } from "../src/run.mjs";
import { capture, commandSuite, makeRepo, stubSpawn, tempRoot, write } from "./helpers.mjs";

// --- {report}: the junit artifact token (R10) ---------------------------------

const FRESH_REPORT = '<testsuite name="fresh"><testcase classname="t" name="fresh-x" time="1"/></testsuite>';
const STALE_REPORT = '<testsuite name="stale"><testcase classname="t" name="stale-x" time="7"/></testsuite>';

test("{report} substitutes under the results dir, unlinks stale, and parses the file", async (t) => {
  const repo = makeRepo(t);
  const reportRel = "test-results/cmd.report.xml";
  write(repo, reportRel, STALE_REPORT); // last run's file must never be parsed
  const spawn = stubSpawn({ code: 0 });
  const realSpawn = spawn.spawn;
  let staleAtSpawn = null;
  const spawnFn = (file, args, opts) => {
    staleAtSpawn = existsSync(join(repo, reportRel));
    write(repo, reportRel, FRESH_REPORT); // the producer writes the file this run
    return realSpawn(file, args, opts);
  };
  const out = capture();
  await runSuites([commandSuite(["pytest", "--junitxml={report}"], { format: "junit" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawnFn, _log: out.log, _writeErr: () => {},
  });
  assert.equal(staleAtSpawn, false, "the stale report reached the spawn unlinked");
  assert.deepEqual(spawn.calls[0].args, ["--junitxml=" + join(repo, "test-results", "cmd.report.xml")]);
  const rows = out.lines.join("\n");
  assert.match(rows, /✓ t::fresh-x  1000ms/, "the fresh report never got parsed");
  assert.doesNotMatch(rows, /stale-x/, "the stale report got parsed");
});

test("a run whose report never appears parses stdout as the fallback", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 0, out: '<testsuite name="stdout"><testcase classname="t" name="stdout-x" time="0.02"/></testsuite>' });
  const out = capture();
  await runSuites([commandSuite(["pytest", "--junitxml={report}"], { format: "junit" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
  });
  assert.equal(existsSync(join(repo, "test-results", "cmd.report.xml")), false);
  assert.match(out.lines.join("\n"), /✓ t::stdout-x  20ms/, "stdout never got parsed as the fallback");
});

// --- the .mjs shim: the {events} contract at run time (R13) -------------------

test("the shim parse call carries the exact captured shape, report null without the token", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: "go test chatter\n", errOut: "go: warnings\n", code: 0 });
  const calls = [];
  const parse = (args) => {
    calls.push(args);
    return { events: [{ name: "go passes", outcome: "pass", ms: 7 }] };
  };
  const out = capture();
  await runSuites([commandSuite(["go", "test"], { format: "shims/go.mjs" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, shims: { "shims/go.mjs": parse },
  });
  assert.deepEqual(calls, [{
    stdout: "go test chatter\n",
    stderr: "go: warnings\n",
    exitCode: 0,
    report: null,
  }]);
});

test("with {report} the parse call carries the read file as report", async (t) => {
  const repo = makeRepo(t);
  write(repo, "test-results/cmd.report.xml", FRESH_REPORT);
  const spawn = stubSpawn({ code: 0 });
  const realSpawn = spawn.spawn;
  const spawnFn = (file, args, opts) => {
    write(repo, "test-results/cmd.report.xml", FRESH_REPORT); // the producer writes the file this run
    return realSpawn(file, args, opts);
  };
  const calls = [];
  const parse = (args) => {
    calls.push(args);
    return { events: [{ name: "go from-report", outcome: "pass", ms: 2 }] };
  };
  const out = capture();
  await runSuites([commandSuite(["go", "test", "--out={report}"], { format: "shims/go.mjs" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawnFn, _log: out.log, shims: { "shims/go.mjs": parse },
  });
  assert.deepEqual(calls[0].report, {
    path: join(repo, "test-results", "cmd.report.xml"),
    text: FRESH_REPORT,
  });
});

test("shim events render as rows — pass, fail, skip and todo", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: "go test chatter\n", code: 0 });
  const parse = () => ({
    events: [
      { name: "go passes", outcome: "pass", ms: 7 },
      { name: "go fails", outcome: "fail", ms: 2, detail: "boom" },
      { name: "go skips", outcome: "skip", ms: null },
      { name: "go todos", outcome: "skip", ms: null, todo: true },
    ],
  });
  const out = capture();
  await runSuites([commandSuite(["go", "test"], { format: "shims/go.mjs" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, shims: { "shims/go.mjs": parse },
  });
  const rows = out.lines.join("\n");
  assert.match(rows, /✓ go passes  7ms/);
  assert.match(rows, /✗ go fails/);
  assert.match(rows, /↓ go skips/);
  assert.match(rows, /↓ go todos/);
});

test("a shim that throws prints the decision-8 notice and the verdict stays the child's", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: "go test chatter\n", code: 1 });
  const parse = () => {
    throw new Error("shim exploded");
  };
  const out = capture();
  let err = "";
  const [result] = await runSuites([commandSuite(["go", "test"], { format: "shims/go.mjs" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: (text) => { err += text; },
    shims: { "shims/go.mjs": parse },
  });
  assert.equal(result.status, "fail", "a throwing shim improved the verdict");
  assert.equal(result.exitCode, 1);
  assert.match(err, /\[test\] cmd: no tests recognised in the output \(format: shims\/go\.mjs\); raw output in /);
  assert.doesNotMatch(out.lines.join("\n"), /totals:/, "a throwing shim also rendered rows");
});
