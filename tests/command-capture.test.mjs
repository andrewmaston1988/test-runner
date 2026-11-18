// Capture, rows and the heartbeat: what a command run prints from a stub
// producer. Every run here drives runSuites directly, and the fixture strings
// are the same probed shapes tests/formats.test.mjs pins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runSuites } from "../src/run.mjs";
import { capture, commandSuite, makeRepo, stubSpawn, tempRoot } from "./helpers.mjs";

const TAP_MIX = [
  "TAP version 13",
  "ok 1 - quick",
  "  ---",
  "  duration_ms: 250",
  "  ...",
  "ok 2 - edge",
  "  ---",
  "  duration_ms: 299.2",
  "  ...",
  "ok 3 - atbar",
  "  ---",
  "  duration_ms: 300.1",
  "  ...",
  "ok 4 - slow",
  "  ---",
  "  duration_ms: 350.4",
  "  ...",
  "ok 5 - skipped one # SKIP",
  "not ok 6 - todo one # TODO",
  "not ok 7 - broken",
  "  ---",
  "  expected: 'two'",
  "  actual: 'one'",
  "  duration_ms: 12",
  "  ...",
  "1..7",
].join("\n");

test("a format run pipes both streams, writes them to the log, and tees only stderr", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: "TAP version 13\nok 1 - a\n", errOut: "warn: ignored one\n" });
  const out = capture();
  let tee = "";
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log,
    _writeErr: (text) => { tee += text; },
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.deepEqual(spawn.calls[0].opts.stdio, ["inherit", "pipe", "pipe"]);
  const log = readFileSync(join(repo, "test-results", "cmd.log"), "utf8");
  assert.equal(log, "TAP version 13\nok 1 - a\n--- stderr ---\nwarn: ignored one\n");
  assert.equal(tee, "warn: ignored one\n", "stderr is teed verbatim");
  assert.match(out.lines.join("\n"), /✓ a/);
  assert.doesNotMatch(out.lines.join("\n"), /TAP version/, "stdout reached the log sink");
});

test("without format the command inherits stdio and writes no log", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: "plain output\n" });
  const out = capture();
  await runSuites([commandSuite(["cargo", "test"])], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
  });
  assert.equal(spawn.calls[0].opts.stdio, "inherit");
  assert.equal(existsSync(join(repo, "test-results", "cmd.log")), false, "a plain run wrote a log");
  assert.doesNotMatch(out.lines.join("\n"), /log:/);
});

test("a timeout-killed format run still writes both streams to the log", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ never: true, out: "TAP version 13\nok 1 - a\n", errOut: "boom\n" });
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "tap", timeoutMs: 50 })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: () => {}, _writeErr: () => {},
    _killTree: () => {},
  });
  assert.equal(result.status, "timeout", JSON.stringify(result));
  const log = readFileSync(join(repo, "test-results", "cmd.log"), "utf8");
  assert.equal(log, "TAP version 13\nok 1 - a\n--- stderr ---\nboom\n");
});

test("rows, the slow list and the totals line print for the parsed events", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ out: TAP_MIX });
  const out = capture();
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
    slowMs: 300,
  });
  const text = out.lines.join("\n");
  // Index 0 is the run's own `[test] cmd: cargo test` line; the rows follow it.
  assert.deepEqual(out.lines.slice(1, 8), [
    "✓ quick  250ms",
    "✓ edge  299ms",
    "✓ atbar  300ms",
    "✓ slow  350ms",
    "↓ skipped one",
    "↓ todo one # TODO",
    "✗ broken  12ms",
  ]);
  assert.ok(text.includes("slowest tests (over 300ms):"), text);
  assert.ok(text.includes("    350ms  slow"), text);
  assert.ok(text.includes("    300ms  atbar"), text);
  assert.doesNotMatch(text, /^    299ms  edge$/m, "a 299ms event entered the slow list at 300");
  assert.ok(text.includes("totals: 7 tests, 4 passed, 1 failed, 1 skipped, 1 todo"), text);
});

test("un-timed libtest events print without a time and name no slow test", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 101, out: [
    "running 3 tests",
    "test calc::adds ... ok",
    "test calc::f ... FAILED",
    "test skipped::x ... ignored",
    "failures:",
    "    calc::f",
    "test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.42s",
  ].join("\n") });
  const out = capture();
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "libtest" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {}, slowMs: 300,
  });
  assert.deepEqual(out.lines.slice(1, 4), ["✓ calc::adds", "✗ calc::f", "↓ skipped::x"]);
  assert.ok(out.lines.join("\n").includes("totals: 3 tests, 1 passed, 1 failed, 1 skipped, 0 todo"), out.lines.join("\n"));
  assert.equal(result.status, "fail", "the exit code still fails the run");
  assert.doesNotMatch(out.lines.join("\n"), /slowest tests/, "an un-timed event entered the slow list");
});

const TWENTY_FIVE = Array.from({ length: 25 }, (n, i) => `err-${i + 1}`).join("\n");

test("agent mode keeps failing rows with detail and the bounded stderr tail", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({
    code: 1,
    out: "TAP version 13\nok 1 - fine\nnot ok 2 - broken\n  ---\n  expected: 'two'\n  actual: 'one'\n  duration_ms: 6\n  ...\n1..2\n",
    errOut: `${TWENTY_FIVE}\n`,
  });
  const out = capture();
  let tail = "";
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log,
    _writeErr: (text) => { tail += text; },
    agent: true,
  });
  assert.equal(result.status, "fail");
  assert.deepEqual(out.lines.slice(1, 4), ["✗ broken  6ms", "    expected: 'two'", "    actual: 'one'"]);
  assert.equal(tail, "err-6\nerr-7\nerr-8\nerr-9\nerr-10\nerr-11\nerr-12\nerr-13\nerr-14\nerr-15\n"
    + "err-16\nerr-17\nerr-18\nerr-19\nerr-20\nerr-21\nerr-22\nerr-23\nerr-24\nerr-25\n",
    "the tail is not the last 20 lines");
});

test("agent mode prints no slowest list and no totals line", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 1, out: TAP_MIX });
  const out = capture();
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
    agent: true, slowMs: 300,
  });
  const text = out.lines.join("\n");
  assert.ok(text.includes("✗ broken"), text);
  assert.doesNotMatch(text, /slowest tests/, "agent mode printed the slowest list");
  assert.doesNotMatch(text, /totals:/, "agent mode printed the totals line");
});

test("default mode tees every stderr chunk as it arrives", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 1, out: "TAP version 13\nok 1 - fine\n", errOut: `${TWENTY_FIVE}\n` });
  const out = capture();
  let tee = "";
  await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log,
    _writeErr: (text) => { tee += text; },
  });
  assert.equal(tee, `${TWENTY_FIVE}\n`, "a chunk was lost or reshaped by the tee");
  assert.ok(out.lines.join("\n").includes("✓ fine"), "passing rows vanished in default mode");
});

test("unparseable output with exit 0 passes, with exactly one notice naming the log", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 0, out: "hello\nworld\ngarbage\n" });
  const out = capture();
  let notes = "";
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log,
    _writeErr: (text) => { notes += text; },
  });
  assert.equal(result.ok, true, "the parse contributed to the verdict");
  assert.equal(result.status, "pass");
  const lines = notes.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, `expected exactly one notice, got: ${notes}`);
  assert.match(lines[0], /^\[test\] cmd: no tests recognised in the output \(format: tap\); raw output in /);
  assert.match(lines[0], /cmd\.log$/);
  assert.doesNotMatch(out.lines.join("\n"), /totals:/, "a totals line printed for zero events");
});

test("all-pass TAP with exit 3 still fails the run and still prints rows", async (t) => {
  const repo = makeRepo(t);
  const spawn = stubSpawn({ code: 3, out: "TAP version 13\nok 1 - a\n" });
  const out = capture();
  const [result] = await runSuites([commandSuite(["cargo", "test"], { format: "tap" })], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: out.log, _writeErr: () => {},
  });
  assert.equal(result.status, "fail", JSON.stringify(result));
  assert.equal(result.reason, "exit 3");
  assert.ok(out.lines.join("\n").includes("✓ a"), "rows vanished on a failing exit");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the default heartbeat prints nothing at 59_999ms and one line at 60_000ms, then stops", async (t) => {
  const repo = makeRepo(t);
  let now = 1_000_000;
  const spawn = stubSpawn({ never: true });
  const beats = [];
  const running = runSuites([commandSuite(["cargo", "test"])], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: () => {}, _writeErr: () => {},
    _writeOut: (text) => beats.push(text),
    _now: () => now,
    _pollMs: 10,
  });
  await sleep(60);
  now += 59_999;
  await sleep(60);
  assert.equal(beats.length, 0, `the 59_999ms beat printed: ${beats.join(" | ")}`);
  now += 1;
  await sleep(60);
  assert.equal(beats.length, 1, `the 60_000ms beat printed ${beats.length} lines`);
  assert.equal(beats[0], "… still running (60s): cmd\n");
  spawn.calls[0].child.close(0);
  await running;
  now += 120_000;
  await sleep(60);
  assert.equal(beats.length, 1, "the heartbeat kept ticking after the child closed");
});

test("a smaller interval prints one line per interval from the fake clock", async (t) => {
  const repo = makeRepo(t);
  let now = 1_000_000;
  const spawn = stubSpawn({ never: true });
  const beats = [];
  const running = runSuites([commandSuite(["cargo", "test"])], {
    repoRoot: repo, _tmpdir: tempRoot(t), _spawn: spawn.spawn, _log: () => {}, _writeErr: () => {},
    _writeOut: (text) => beats.push(text),
    _now: () => now,
    _heartbeatMs: 20,
    _pollMs: 10,
  });
  await sleep(60);
  now += 100;
  await sleep(60);
  assert.equal(beats.length, 5, `expected one line per 20ms, got: ${beats.join(" | ")}`);
  spawn.calls[0].child.close(0);
  await running;
});
