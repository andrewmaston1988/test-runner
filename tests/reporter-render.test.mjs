// The reporter's rendering detail: skipped and todo rows, the vitest tree, the
// plain log, and the one slow threshold shared by colour and the slow list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CODES, RESET } from "../src/colour.mjs";
import { createReporter } from "../src/reporter.mjs";
import {
  complete,
  dequeue,
  drain,
  envFor,
  events,
  leaf,
  lines,
  makeRoot,
  neverSleep,
  skippedLeaf,
  start,
  suite,
  summary,
} from "./reporter-harness.mjs";

const green = (text) => `${CODES.green}${text}${RESET}`;
const yellow = (text) => `${CODES.yellow}${text}${RESET}`;

// --- R5: skipped and todo --------------------------------------------------

test("a skipped or todo test is a yellow ↓ with no time, and the file still passes", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "mixed.test.mjs");
  const out = await drain(
    createReporter({ env: envFor(root, { TEST_COLOUR: "1" }), sleep: neverSleep }),
    events([
      dequeue(file),
      start(file, "skip me", 0),
      skippedLeaf(file, "skip me", 0, "skip"),
      start(file, "todo me", 0),
      skippedLeaf(file, "todo me", 0, "todo"),
      start(file, "runs", 0),
      leaf("test:pass", file, "runs", 0, 10),
      complete(file, { ms: 100 }),
      summary({ tests: 3, passed: 1, failed: 0, skipped: 1, todo: 1 }, 100),
    ]),
  );
  const rows = lines(out);
  assert.equal(rows[0], `${green("✓")} tests/mixed.test.mjs (3 tests)  ${green("0.1s")}`, out);
  assert.ok(rows.includes(`  ${yellow("↓")} skip me`), out);
  assert.ok(rows.includes(`  ${yellow("↓")} todo me`), out);
  assert.ok(!rows.some((row) => row.includes("skip me") && row.includes("ms")), `a skipped row carried a time:\n${out}`);
});

// --- R7: the vitest tree ---------------------------------------------------

test("default mode prints the count, a suite row and every test at its depth", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "tree.test.mjs");
  const out = await drain(
    createReporter({ env: envFor(root), sleep: neverSleep }),
    events([
      dequeue(file),
      start(file, "outer", 0),
      start(file, "inner", 1),
      start(file, "deep", 2),
      leaf("test:pass", file, "deep", 2, 10),
      suite("test:pass", file, "inner", 1, 800),
      start(file, "shallow", 1),
      leaf("test:pass", file, "shallow", 1, 20),
      suite("test:pass", file, "outer", 0, 900),
      complete(file, { ms: 1200 }),
      summary({ tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, 1200),
    ]),
  );
  const rows = lines(out);
  assert.equal(rows[0], "✓ tests/tree.test.mjs (2 tests)  1.2s", out);
  assert.equal(rows[1], "  ✓ outer  900ms", out);
  assert.equal(rows[2], "    ✓ inner  800ms", out);
  assert.equal(rows[3], "      ✓ deep  10ms", out);
  assert.equal(rows[4], "    ✓ shallow  20ms", out);
  assert.ok(!out.includes("outer > inner > deep"), "the tree prints names, not chains");
});

// --- R9: the log -----------------------------------------------------------

test("the log row equals the stdout row with ANSI stripped, count included", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "logged.test.mjs");
  const out = await drain(
    createReporter({ env: envFor(root, { TEST_COLOUR: "1" }), sleep: neverSleep }),
    events([
      dequeue(file),
      start(file, "one", 0),
      leaf("test:pass", file, "one", 0, 10),
      start(file, "two", 0),
      leaf("test:pass", file, "two", 0, 20),
      complete(file, { ms: 500 }),
      summary({ tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, 500),
    ]),
  );
  const strip = (text) => text.replace(/\x1b\[\d+m/g, "");
  const log = readFileSync(join(root, "test-results", "unit.log"), "utf8");
  const outRows = lines(out);
  const logRows = lines(log);
  assert.deepEqual(logRows.slice(0, 3), outRows.slice(0, 3).map(strip));
  assert.match(outRows[0], /\(2 tests\)/);
  assert.ok(!logRows[0].includes("\x1b["), "the log must stay plain");
});

test("agent mode's log still holds the full tree", async (t) => {
  const root = makeRoot(t);
  const passing = join(root, "tests", "passing.test.mjs");
  const failing = join(root, "tests", "failing.test.mjs");
  const error = new Error("nope");
  error.stack = "Error: nope\n    at node:internal/test_runner/test:1:1";
  const out = await drain(
    createReporter({ env: envFor(root, { TEST_REPORTER: "agent" }), sleep: neverSleep }),
    events([
      dequeue(passing), dequeue(failing),
      start(passing, "passing child", 0),
      leaf("test:pass", passing, "passing child", 0, 10),
      suite("test:pass", passing, "group", 0, 10),
      complete(passing, { ms: 20 }),
      start(failing, "breaks", 0),
      leaf("test:fail", failing, "breaks", 0, 5, { code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: error }),
      complete(failing, { passed: false, ms: 5 }),
      summary({ tests: 2, passed: 1, failed: 1, skipped: 0, todo: 0 }, 30),
    ]),
  );
  assert.ok(!out.includes("passing child"), `agent mode printed passing work:\n${out}`);
  const log = readFileSync(join(root, "test-results", "unit.log"), "utf8");
  assert.match(log, /^✓ tests\/passing\.test\.mjs \(1 tests\) {2}0\.0s$/m, log);
  assert.match(log, /^ {2}✓ passing child {2}10ms$/m, log);
});

// --- R10 / R11: one meaning of slow ----------------------------------------

test("SLOW_MS=150 colours a 200ms test yellow and lists it, and leaves 100ms out", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "threshold.test.mjs");
  const out = await drain(
    createReporter({ env: envFor(root, { TEST_COLOUR: "1", SLOW_MS: "150" }), sleep: neverSleep }),
    events([
      dequeue(file),
      start(file, "slow leaf", 0),
      leaf("test:pass", file, "slow leaf", 0, 200),
      start(file, "fast leaf", 0),
      leaf("test:pass", file, "fast leaf", 0, 100),
      complete(file, { ms: 300 }),
      summary({ tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, 300),
    ]),
  );
  const rows = lines(out);
  assert.ok(rows.includes(`  ${green("✓")} slow leaf  ${yellow("200ms")}`), out);
  assert.ok(rows.includes(`  ${green("✓")} fast leaf  ${green("100ms")}`), out);
  const heading = rows.indexOf("slowest tests (over 150ms):");
  assert.notEqual(heading, -1, out);
  const block = rows.slice(heading + 1);
  assert.ok(block.some((row) => row.includes("slow leaf")), out);
  assert.ok(!block.some((row) => row.includes("fast leaf")), out);
});

test("the default threshold colours and lists exactly 300ms, and not 299ms", async (t) => {
  const root = makeRoot(t);
  const file = join(root, "tests", "default.test.mjs");
  const out = await drain(
    createReporter({ env: envFor(root, { TEST_COLOUR: "1" }), sleep: neverSleep }),
    events([
      dequeue(file),
      start(file, "at 300", 0),
      leaf("test:pass", file, "at 300", 0, 300),
      start(file, "at 299", 0),
      leaf("test:pass", file, "at 299", 0, 299),
      complete(file, { ms: 600 }),
      summary({ tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }, 600),
    ]),
  );
  const rows = lines(out);
  assert.ok(rows.includes(`  ${green("✓")} at 300  ${yellow("300ms")}`), out);
  assert.ok(rows.includes(`  ${green("✓")} at 299  ${green("299ms")}`), out);
  const heading = rows.indexOf("slowest tests (over 300ms):");
  assert.notEqual(heading, -1, out);
  const block = rows.slice(heading + 1);
  assert.ok(block.some((row) => row.includes("at 300")), out);
  assert.ok(!block.some((row) => row.includes("at 299")), out);
});
