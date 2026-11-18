// The command-run output parsers (src/formats.mjs): fixture strings pinned to
// probed producer shapes -- node --test --test-reporter=tap probed 2026-11-17
// (children print BEFORE their parent's point; YAML blocks follow each point),
// cargo's plain and nightly --format json shapes probed the same day (neither
// carries a per-test duration). No fixture asserts an assumed shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fastSkipArgs, parseOutput } from "../src/formats.mjs";

const TAP_FIXTURE = `
TAP version 13
# Subtest: calc::adds
ok 1 - calc::adds
  ---
  duration_ms: 0.8723
  type: 'test'
  ...
# Subtest: calc::f
not ok 2 - calc::f
  ---
  code: 'ERR_TEST_FAILURE'
  expected: '2'
  actual: '3'
  duration_ms: 42.4
  ...
# a comment nothing reads
# Subtest: parent
    # Subtest: child
    ok 1 - child
      ---
      duration_ms: 1.24
      type: 'test'
      ...
    1..1
ok 2 - parent
  ---
  duration_ms: 3.4
  type: 'suite'
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP
  ---
  duration_ms: 0.3
  type: 'test'
  ...
1..4
# tests 4
# pass 2
# fail 1
`.trimStart();

test("the probed node TAP shape parses to five events in file order", () => {
  // The rows pin the fields the plan names; the failing row's detail is the
  // whole YAML block minus its duration_ms entry.
  const pick = (events) => events.map(({ name, outcome, ms, chain, detail, todo }) => ({
    name, outcome, ms, ...(chain && { chain }),
    ...(outcome === "fail" && detail && { detail }), ...(todo && { todo }),
  }));
  assert.deepEqual(pick(parseOutput("tap", { stdout: TAP_FIXTURE, stderr: "", exitCode: 0, report: null })), [
    { name: "calc::adds", outcome: "pass", ms: 1 },
    {
      name: "calc::f",
      outcome: "fail",
      ms: 42,
      detail: "code: 'ERR_TEST_FAILURE'\nexpected: '2'\nactual: '3'",
    },
    { name: "child", outcome: "pass", ms: 1, chain: ["parent"] },
    { name: "parent", outcome: "pass", ms: 3 },
    { name: "skipped one", outcome: "skip", ms: 0 },
  ]);
});

test("the child's sub-plan, the banners, the comment and TAP version yield notices only", () => {
  const events = parseOutput("tap", { stdout: TAP_FIXTURE, stderr: "", exitCode: 0, report: null });
  const named = events.map((event) => event.name);
  assert.deepEqual(named, ["calc::adds", "calc::f", "child", "parent", "skipped one"]);
  assert.ok(!named.includes("parent # Subtest"), "a banner became an event");
  for (const event of events) {
    assert.ok(!String(event.name).startsWith("--"), `an event grew a bogus -- prefix: ${event.name}`);
  }
});

test("a point without descriptions, and one without the N - prefix, both parse", () => {
  assert.deepEqual(
    parseOutput("tap", { stdout: "ok 1 - plain\nTAP version 13\nBail out! done\nnot ok 2 - broken # TODO\n", stderr: "", exitCode: 1, report: null }),
    [
      { name: "plain", outcome: "pass", ms: null },
      { name: "broken", outcome: "skip", ms: null, todo: true },
    ],
  );
});

const CARGO_FIXTURE = [
  "running 3 tests",
  "test calc::adds ... ok",
  "test calc::f ... FAILED",
  "test skipped::x ... ignored",
  "",
  "failures:",
  "",
  "---- calc::f stdout ----",
  "boom: assertion failed",
  "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
  "",
  "failures:",
  "    calc::f",
  "",
  "test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.42s",
  "",
  "Doc-tests docname",
  "running 0 tests",
].join("\n");

test("the plain libtest shape parses pass/fail/skip, all un-timed, with the stdout block as detail", () => {
  assert.deepEqual(parseOutput("libtest", { stdout: CARGO_FIXTURE, stderr: "", exitCode: 101, report: null }), [
    { name: "calc::adds", outcome: "pass", ms: null },
    {
      name: "calc::f",
      outcome: "fail",
      ms: null,
      detail: "boom: assertion failed"
        + "\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    },
    { name: "skipped::x", outcome: "skip", ms: null },
  ]);
});

test("running, result and Doc-tests lines yield nothing, and the bare failures list is ignored", () => {
  const events = parseOutput("libtest", { stdout: CARGO_FIXTURE, stderr: "", exitCode: 101, report: null });
  const named = events.map((event) => event.name);
  assert.deepEqual(named, ["calc::adds", "calc::f", "skipped::x"]);
});

const MIXED_FIXTURE = [
  "   Compiling calc v0.1.0",
  `{"type":"suite","event":"started","test_count":3}`,
  `{"type":"test","event":"started","name":"a"}`,
  "running 3 tests",
  `{"type":"test","event":"ok","name":"a"}`,
  `{"type":"test","event":"failed","name":"f","stdout":"boom"}`,
  "test plain::b ... ok",
  `{"type":"test","event":"ignored","name":"s"}`,
  `{"type":"suite","event":"ok","test_count":3,"exec_time":0.5}`,
].join("\n");

test("JSON objects and plain libtest lines parse correctly mixed", () => {
  assert.deepEqual(parseOutput("libtest", { stdout: MIXED_FIXTURE, stderr: "", exitCode: 0, report: null }), [
    { name: "a", outcome: "pass", ms: null },
    { name: "f", outcome: "fail", ms: null, detail: "boom" },
    { name: "plain::b", outcome: "pass", ms: null },
    { name: "s", outcome: "skip", ms: null },
  ]);
});

const JSON_FIXTURE = [
  `{"type":"suite","event":"started","test_count":3}`,
  `{"type":"test","event":"started","name":"a"}`,
  `{"type":"test","event":"ok","name":"a"}`,
  `{"type":"test","event":"failed","name":"f","stdout":"boom"}`,
  `{"type":"test","event":"ignored","name":"s"}`,
  `{"type":"test","event":"timeout","name":"t"}`,
  `{"type":"suite","event":"ok","test_count":3,"exec_time":0.5}`,
].join("\n");

test("the libtest JSON shape parses; timeout fails; exec_time is suite-level and ignored", () => {
  assert.deepEqual(parseOutput("libtest", { stdout: JSON_FIXTURE, stderr: "", exitCode: 101, report: null }), [
    { name: "a", outcome: "pass", ms: null },
    { name: "f", outcome: "fail", ms: null, detail: "boom" },
    { name: "s", outcome: "skip", ms: null },
    { name: "t", outcome: "fail", ms: null },
  ]);
});

test("fastSkipArgs: an opted-in junit run gains one --deselect pair per long-running test", () => {
  const tests = [
    { name: "slow::one", ms: 31_000, nodeid: "tests/test_x.py::slow_one" },
    { name: "slow::two", ms: 35_000, nodeid: "tests/test_y.py::b" },
  ];
  assert.deepEqual(fastSkipArgs({ format: "junit", fastSkip: true }, tests), {
    args: ["--deselect", "tests/test_x.py::slow_one", "--deselect", "tests/test_y.py::b"],
    names: ["slow::one", "slow::two"],
    warn: false,
  });
});

test("fastSkipArgs: default off changes nothing, and tap and libtest warn", () => {
  const slow = [{ name: "slow::one", ms: 31_000, nodeid: "tests/test_x.py::slow_one" }];
  assert.deepEqual(fastSkipArgs({ format: "junit" }, slow), { args: [], names: [] });
  for (const format of ["tap", "libtest"]) {
    assert.deepEqual(fastSkipArgs({ format, fastSkip: true }, slow), { args: [], names: [], warn: true });
  }
});

test("fastSkipArgs: a junit test without a nodeid deselects nothing but is still named", () => {
  assert.deepEqual(
    fastSkipArgs({ format: "junit", fastSkip: true }, [{ name: "bare::num", ms: 31_000 }, { name: "a", ms: 31_000, nodeid: "n" }]),
    { args: ["--deselect", "n"], names: ["bare::num", "a"], warn: false },
  );
});

// --- R4: the junit scanner ----------------------------------------------------

const JUNIT_WITH_FILE = [
  '<testsuites><testsuite name="pytest" tests="5" failures="2" errors="1" skipped="1" time="1.6005">',
  '<testcase classname="tests.test_x" name="a" file="tests/test_x.py" line="2" time="1.5"/>',
  '<testcase classname="tests.test_x" name="f" file="tests/test_x.py" line="5" time="0.2">',
  '<failure message="boom">trace\nE   AssertionError</failure></testcase>',
  '<testcase classname="tests.test_x" name="s" file="tests/test_x.py" line="8" time="0.004">',
  '<skipped message="why"/></testcase>',
  '<testcase classname="tests.other" name="plain" time="0.02"><error message="no-attr">stderr text</error></testcase>',
  '<testcase classname="tests.other" name="notime"><failure>just the body</failure></testcase>',
  "</testsuite></testsuites>",
].join("\n");

const junitPick = ({ name, outcome, ms, nodeid, detail = null }) => ({
  name, outcome, ms, ...(nodeid && { nodeid }), detail,
});

test("the pytest-junit shape scans to events with nodeids, seconds as ms, and failure details", () => {
  const events = parseOutput("junit", { stdout: JUNIT_WITH_FILE }).map(junitPick);
  assert.deepEqual(events, [
    { name: "tests.test_x::a", outcome: "pass", ms: 1500, nodeid: "tests/test_x.py::a", detail: null },
    { name: "tests.test_x::f", outcome: "fail", ms: 200, nodeid: "tests/test_x.py::f", detail: "boom" },
    { name: "tests.test_x::s", outcome: "skip", ms: 4, nodeid: "tests/test_x.py::s", detail: null },
    { name: "tests.other::plain", outcome: "fail", ms: 20, detail: "no-attr" },
    { name: "tests.other::notime", outcome: "fail", ms: null, detail: "just the body" },
  ]);
});

test("a self-closing failure keeps its message as detail", () => {
  const events = parseOutput("junit", {
    stdout: '<testsuite><testcase classname="t" name="x"><failure message="self-closing"/></testcase></testsuite>',
  });
  assert.deepEqual(events.map(({ outcome, detail }) => ({ outcome, detail })), [{ outcome: "fail", detail: "self-closing" }]);
});

test("a testcase without classname or file parses as a bare, nodeid-less name", () => {
  const events = parseOutput("junit", { stdout: '<testsuite name="root"><testcase name="solo" time="0.001"/></testsuite>' });
  assert.deepEqual(events, [{ name: "solo", outcome: "pass", ms: 1 }]);
});

test("a junit report read from the report file parses instead of stdout", () => {
  const events = parseOutput("junit", {
    stdout: '<testcase name="chatter" time="9"/>',
    report: { path: "test-results/cmd.report.xml", text: '<testsuite><testcase name="from-file" time="1"/></testsuite>' },
  });
  assert.deepEqual(events.map((e) => e.name), ["from-file"]);
  assert.deepEqual(parseOutput("junit", { stdout: '<testcase name="chatter" time="9"/>' }).map((e) => e.name), ["chatter"]);
});
